'use strict';

const Airtable = require('airtable');
const config = require('../../shared/config');
const logger = require('../../shared/logger');
const { AirtableApiError } = require('../../shared/errors');
const { withRetry } = require('../../shared/retry');

/**
 * Read/write access to the Airtable base.
 *
 * Two responsibilities matter here:
 *
 *  - **Write-back.** After a record is created in HubSpot we store the new
 *    HubSpot id on the Airtable row. That write is what makes every subsequent
 *    event for the row an update rather than a create.
 *  - **Link resolution.** Airtable linked-record fields hold opaque record ids
 *    (`recXXXXXXXX`), not the business ids the rest of the system uses, so the
 *    parent row has to be fetched to find its `hubspot_record_id`.
 */
class AirtableService {
  /**
   * @param {object} [options]
   * @param {import('winston').Logger} [options.logger]
   * @param {object} [options.base] pre-built Airtable base, for tests
   */
  constructor(options = {}) {
    this.log = options.logger || logger;
    this.base =
      options.base ||
      new Airtable({ apiKey: config.airtable.apiKey }).base(
        config.airtable.baseId
      );
    this.tables = config.airtable.tables;
  }

  /**
   * Wraps an Airtable SDK call with retry and a normalised error type.
   *
   * @template T
   * @param {string} operation label used in logs
   * @param {() => Promise<T>} fn
   * @param {Record<string, unknown>} [context]
   * @returns {Promise<T>}
   */
  async call(operation, fn, context = {}) {
    try {
      return await withRetry(
        async () => {
          try {
            return await fn();
          } catch (error) {
            // The Airtable SDK reports rate limiting as statusCode 429; map it
            // onto our own error type so the shared retry logic recognises it.
            throw new AirtableApiError(error.message || 'Airtable request failed', {
              status: error.statusCode || error.status,
              retryable:
                error.statusCode === 429 || (error.statusCode ?? 0) >= 500,
              context: { operation, ...context },
              cause: error,
            });
          }
        },
        { logger: this.log, context: { operation, ...context } }
      );
    } catch (error) {
      this.log.error('Airtable request failed', {
        operation,
        ...context,
        status: error.status,
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Fetches a single record.
   *
   * @param {string} tableName
   * @param {string} recordId
   * @returns {Promise<{ id: string, fields: Record<string, any> }|null>} null when the record no longer exists
   */
  async getRecord(tableName, recordId) {
    try {
      const record = await this.call(
        'getRecord',
        () => this.base(tableName).find(recordId),
        { tableName, recordId }
      );
      return { id: record.id, fields: record.fields };
    } catch (error) {
      // A deleted record is a normal race with a queued webhook, not an error.
      if (error.status === 404) {
        this.log.warn('Airtable record not found', { tableName, recordId });
        return null;
      }
      throw error;
    }
  }

  /**
   * Stores the HubSpot id on the Airtable row.
   *
   * @param {string} tableName
   * @param {string} recordId
   * @param {string} hubspotId
   */
  async writeBackHubspotId(tableName, recordId, hubspotId) {
    await this.call(
      'writeBackHubspotId',
      () =>
        this.base(tableName).update(recordId, {
          hubspot_record_id: String(hubspotId),
        }),
      { tableName, recordId, hubspotId }
    );

    this.log.info('Wrote hubspot_record_id back to Airtable', {
      tableName,
      recordId,
      hubspotId,
    });
  }

  /**
   * Finds a record by one of its business-key fields (`company_id`,
   * `deal_id`, …). Used when a row references its parent by id rather than by
   * an Airtable link.
   *
   * @param {string} tableName
   * @param {string} fieldName
   * @param {string|number} value
   * @returns {Promise<{ id: string, fields: Record<string, any> }|null>}
   */
  async findByField(tableName, fieldName, value) {
    if (value === undefined || value === null || value === '') return null;

    // Escape embedded quotes so a value cannot break out of the formula.
    const escaped = String(value).replace(/'/g, "\\'");

    const records = await this.call(
      'findByField',
      () =>
        this.base(tableName)
          .select({
            filterByFormula: `{${fieldName}} = '${escaped}'`,
            maxRecords: 1,
          })
          .firstPage(),
      { tableName, fieldName, value }
    );

    if (!records || records.length === 0) return null;
    return { id: records[0].id, fields: records[0].fields };
  }
}

module.exports = { AirtableService };
