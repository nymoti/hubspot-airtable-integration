'use strict';

const config = require('../../shared/config');
const logger = require('../../shared/logger');
const { AirtableApiError } = require('../../shared/errors');
const { withRetry } = require('../../shared/retry');

/**
 * Airtable Webhooks API client.
 *
 * The `airtable` npm package only covers the records API, so webhook
 * management is done over plain HTTP against `api.airtable.com/v0/bases/{id}/webhooks`.
 *
 * Webhooks are managed entirely over REST, which is why this approach works on
 * the free plan: the "Run script" and "Send HTTP request" automation actions
 * are gated behind paid tiers, but the API is not.
 *
 * Note the expiry: a webhook stops delivering after seven days unless it is
 * refreshed. `scripts/refresh-airtable-webhook.js` handles that, driven by
 * Cloud Scheduler.
 */

class AirtableWebhookApi {
  /**
   * @param {object} [options]
   * @param {string} [options.apiKey]
   * @param {string} [options.baseId]
   * @param {string} [options.apiBaseUrl]
   * @param {import('winston').Logger} [options.logger]
   */
  constructor(options = {}) {
    this.apiKey = options.apiKey || config.airtable.apiKey;
    this.baseId = options.baseId || config.airtable.baseId;
    this.apiBaseUrl = options.apiBaseUrl || config.airtable.apiBaseUrl;
    this.log = options.logger || logger;
  }

  /**
   * @param {'GET'|'POST'|'DELETE'} method
   * @param {string} path appended to the base's webhooks URL
   * @param {object} [body]
   * @returns {Promise<any>}
   */
  async request(method, path, body) {
    const url = `${this.apiBaseUrl}/bases/${this.baseId}/webhooks${path}`;

    const send = async () => {
      const response = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: body ? JSON.stringify(body) : undefined,
      });

      const payload = await response.json().catch(() => null);

      if (!response.ok) {
        throw new AirtableApiError(
          payload?.error?.message || `Airtable ${method} ${path} failed with ${response.status}`,
          {
            status: response.status,
            retryable: response.status === 429 || response.status >= 500,
            context: { method, url, type: payload?.error?.type },
          }
        );
      }

      return payload;
    };

    return withRetry(send, { logger: this.log, context: { method, path } });
  }

  /**
   * Registers a webhook covering every table in the base.
   *
   * The specification watches `tableData` for adds and updates. Deletions are
   * deliberately not watched: this sync is additive, and removing a row in
   * Airtable should not delete a CRM record that a salesperson may since have
   * worked on.
   *
   * @param {string} notificationUrl must be https
   * @returns {Promise<{ id: string, macSecretBase64: string, expirationTime: string }>}
   */
  async create(notificationUrl) {
    if (!notificationUrl.startsWith('https://')) {
      throw new AirtableApiError('notificationUrl must be https', {
        retryable: false,
        context: { notificationUrl },
      });
    }

    const payload = await this.request('POST', '', {
      notificationUrl,
      specification: {
        options: {
          filters: {
            dataTypes: ['tableData'],
            changeTypes: ['add', 'update'],
          },
        },
      },
    });

    return payload;
  }

  /** @returns {Promise<Array<object>>} */
  async list() {
    const payload = await this.request('GET', '');
    return payload?.webhooks ?? [];
  }

  /**
   * Extends a webhook's life by another seven days.
   * @param {string} webhookId
   */
  refresh(webhookId) {
    return this.request('POST', `/${webhookId}/refresh`);
  }

  /** @param {string} webhookId */
  delete(webhookId) {
    return this.request('DELETE', `/${webhookId}`);
  }
}

module.exports = { AirtableWebhookApi };
