'use strict';

const { Client } = require('@hubspot/api-client');
const config = require('./config');
const logger = require('./logger');
const { HubSpotApiError } = require('./errors');
const { withRetry, RateLimiter } = require('./retry');

/**
 * Response headers arrive as a `Headers` instance or a plain object depending
 * on the SDK's underlying transport; flatten both to a lower-cased map.
 *
 * @param {Headers|Record<string, string>|undefined} headers
 * @returns {Record<string, string>}
 */
function normaliseHeaders(headers) {
  if (!headers) return {};
  if (typeof headers.forEach === 'function' && typeof headers.get === 'function') {
    const flat = {};
    headers.forEach((value, key) => {
      flat[String(key).toLowerCase()] = value;
    });
    return flat;
  }
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value])
  );
}

/**
 * Thin, uniform wrapper over the official `@hubspot/api-client`.
 *
 * The SDK is used as the transport (`apiRequest`) rather than through its
 * per-object typed methods, for two reasons:
 *
 *  1. One code path covers CRM v3 objects *and* v4 associations. The typed
 *     helpers cover these inconsistently, and mixing both styles would give us
 *     two different error shapes to handle.
 *  2. Every call flows through a single place where we can apply client-side
 *     rate limiting, retry with backoff, and structured logging — so those
 *     behaviours are guaranteed rather than remembered at each call site.
 *
 * Errors are normalised to `HubSpotApiError`, which carries the HTTP status
 * and HubSpot's per-field validation details.
 */
class HubSpotClient {
  /**
   * @param {object} [options]
   * @param {string} [options.accessToken]
   * @param {import('winston').Logger} [options.logger]
   */
  constructor(options = {}) {
    this.log = options.logger || logger;
    this.client = new Client({
      accessToken: options.accessToken || config.hubspot.accessToken,
      basePath: config.hubspot.baseUrl,
    });
    this.limiter = new RateLimiter(config.hubspot.maxRequestsPerSecond);
    this.maxRetries = config.hubspot.maxRetries;
  }

  /**
   * Performs a rate-limited, retried HubSpot API call.
   *
   * @param {'GET'|'POST'|'PATCH'|'PUT'|'DELETE'} method
   * @param {string} path e.g. `/crm/v3/objects/companies`
   * @param {object} [body]
   * @param {Record<string, unknown>} [logContext]
   * @param {object} [options]
   * @param {number[]} [options.expectedStatuses] statuses the caller handles
   *   itself, logged at debug rather than error. A 404 from an existence check
   *   is a normal answer, not a fault, and should not look like one in the logs.
   * @returns {Promise<any>} the parsed JSON body (null for 204 responses)
   */
  async request(method, path, body, logContext = {}, options = {}) {
    const startedAt = Date.now();
    const expectedStatuses = options.expectedStatuses || [];

    const send = async () => {
      const response = await this.limiter.schedule(() =>
        this.client.apiRequest({ method, path, body })
      );

      if (response.status === 204) return null;

      const payload = await response.json().catch(() => null);

      if (response.status >= 400) {
        const error = new HubSpotApiError(
          payload?.message || `HubSpot ${method} ${path} failed with ${response.status}`,
          {
            status: response.status,
            // 429 and 5xx are transient; 4xx validation failures are not.
            retryable: response.status === 429 || response.status >= 500,
            details: payload?.errors || payload?.validationResults,
            context: { method, path, correlationId: payload?.correlationId },
          }
        );
        // Expose the raw headers so the backoff can honour `Retry-After`.
        error.headers = normaliseHeaders(response.headers);
        throw error;
      }

      return payload;
    };

    try {
      const result = await withRetry(send, {
        retries: this.maxRetries,
        logger: this.log,
        context: { ...logContext, method, path },
      });

      this.log.debug('HubSpot request succeeded', {
        ...logContext,
        method,
        path,
        durationMs: Date.now() - startedAt,
      });

      return result;
    } catch (error) {
      const expected = expectedStatuses.includes(error.status);

      this.log[expected ? 'debug' : 'error']('HubSpot request failed', {
        ...logContext,
        method,
        path,
        durationMs: Date.now() - startedAt,
        status: error.status,
        details: error.details,
        error: error.message,
      });
      throw error;
    }
  }

  // ---------------------------------------------------------------------
  // CRM objects
  // ---------------------------------------------------------------------

  /**
   * @param {string} objectType `companies` | `contacts` | `deals` | `line_items`
   * @param {Record<string, string>} properties
   * @param {Record<string, unknown>} [logContext]
   * @returns {Promise<{ id: string, properties: Record<string, string> }>}
   */
  createObject(objectType, properties, logContext) {
    return this.request(
      'POST',
      `/crm/v3/objects/${objectType}`,
      { properties },
      logContext
    );
  }

  /**
   * @param {string} objectType
   * @param {string} objectId
   * @param {Record<string, string>} properties
   * @param {Record<string, unknown>} [logContext]
   */
  updateObject(objectType, objectId, properties, logContext) {
    return this.request(
      'PATCH',
      `/crm/v3/objects/${objectType}/${objectId}`,
      { properties },
      logContext
    );
  }

  /**
   * @param {string} objectType
   * @param {string} objectId
   * @param {string[]} [properties] properties to return
   * @returns {Promise<object|null>} null when the record does not exist
   */
  async getObject(objectType, objectId, properties = []) {
    const query = properties.length
      ? `?properties=${encodeURIComponent(properties.join(','))}`
      : '';
    try {
      return await this.request(
        'GET',
        `/crm/v3/objects/${objectType}/${objectId}${query}`,
        undefined,
        { objectType, objectId },
        // A deleted or mistyped id is an expected outcome of an idempotency
        // check, not a failure — the caller falls back to searching.
        { expectedStatuses: [404] }
      );
    } catch (error) {
      if (error.status === 404) return null;
      throw error;
    }
  }

  /**
   * Finds records by an exact property match.
   *
   * @param {string} objectType
   * @param {string} propertyName
   * @param {string|number} value
   * @param {object} [options]
   * @param {number} [options.limit=1]
   * @param {string[]} [options.properties]
   * @returns {Promise<Array<{ id: string, properties: Record<string, string> }>>}
   */
  async searchByProperty(objectType, propertyName, value, options = {}) {
    const { limit = 1, properties = [] } = options;

    const payload = await this.request(
      'POST',
      `/crm/v3/objects/${objectType}/search`,
      {
        filterGroups: [
          {
            filters: [
              { propertyName, operator: 'EQ', value: String(value) },
            ],
          },
        ],
        properties,
        limit,
      },
      { objectType, propertyName }
    );

    return payload?.results ?? [];
  }

  /**
   * Creates up to `inputs.length` records in one call (HubSpot caps at 100).
   *
   * Note that HubSpot's batch endpoint is all-or-nothing: one invalid record
   * fails the whole batch with a 400. Callers are expected to fall back to
   * per-record creation so a single bad row cannot block the other 99.
   *
   * @param {string} objectType
   * @param {Array<{ properties: Record<string, string> }>} inputs
   * @param {Record<string, unknown>} [logContext]
   * @returns {Promise<{ results: Array<{ id: string, properties: Record<string, string> }> }>}
   */
  batchCreate(objectType, inputs, logContext) {
    return this.request(
      'POST',
      `/crm/v3/objects/${objectType}/batch/create`,
      { inputs },
      { ...logContext, objectType, batchSize: inputs.length }
    );
  }

  /**
   * @param {string} objectType
   * @param {Array<{ id: string, properties: Record<string, string> }>} inputs
   * @param {Record<string, unknown>} [logContext]
   */
  batchUpdate(objectType, inputs, logContext) {
    return this.request(
      'POST',
      `/crm/v3/objects/${objectType}/batch/update`,
      { inputs },
      { ...logContext, objectType, batchSize: inputs.length }
    );
  }

  /**
   * Reads many records by an alternate unique id in one call — used to look up
   * existing records by `email` (contacts) or `domain` (companies) without
   * spending one search request per record.
   *
   * @param {string} objectType
   * @param {string[]} ids
   * @param {string} idProperty
   * @param {string[]} [properties]
   * @returns {Promise<Array<{ id: string, properties: Record<string, string> }>>}
   */
  async batchRead(objectType, ids, idProperty, properties = []) {
    if (ids.length === 0) return [];

    const payload = await this.request(
      'POST',
      `/crm/v3/objects/${objectType}/batch/read`,
      {
        idProperty,
        properties,
        inputs: ids.map((id) => ({ id: String(id) })),
      },
      { objectType, idProperty, batchSize: ids.length }
    );

    // Records that do not exist come back under `errors`, not `results`, and a
    // partial result arrives with HTTP 207 — both are expected here.
    return payload?.results ?? [];
  }

  // ---------------------------------------------------------------------
  // Associations (v4)
  // ---------------------------------------------------------------------

  /**
   * Associates two records using HubSpot's *default* association type for the
   * pair (e.g. contact→company "primary"). Using the default endpoint avoids
   * hard-coding numeric association type ids, which differ between portals for
   * custom labels.
   *
   * PUT is idempotent: replaying the same event re-asserts the association
   * rather than duplicating it.
   *
   * @param {string} fromObjectType
   * @param {string} fromId
   * @param {string} toObjectType
   * @param {string} toId
   * @param {Record<string, unknown>} [logContext]
   */
  associate(fromObjectType, fromId, toObjectType, toId, logContext) {
    return this.request(
      'PUT',
      `/crm/v4/objects/${fromObjectType}/${fromId}/associations/default/${toObjectType}/${toId}`,
      undefined,
      { ...logContext, fromObjectType, fromId, toObjectType, toId }
    );
  }

  /**
   * Batch equivalent of {@link associate}, for the migration.
   *
   * @param {string} fromObjectType
   * @param {string} toObjectType
   * @param {Array<{ from: { id: string }, to: { id: string } }>} inputs
   * @param {Record<string, unknown>} [logContext]
   */
  batchAssociate(fromObjectType, toObjectType, inputs, logContext) {
    return this.request(
      'POST',
      `/crm/v4/associations/${fromObjectType}/${toObjectType}/batch/associate/default`,
      { inputs },
      { ...logContext, fromObjectType, toObjectType, batchSize: inputs.length }
    );
  }

  // ---------------------------------------------------------------------
  // Property schema
  // ---------------------------------------------------------------------

  /**
   * @param {string} objectType
   * @param {string} propertyName
   * @returns {Promise<object|null>}
   */
  async getProperty(objectType, propertyName) {
    try {
      return await this.request(
        'GET',
        `/crm/v3/properties/${objectType}/${propertyName}`,
        undefined,
        { objectType, propertyName },
        // "Not found" is the expected answer half the time here.
        { expectedStatuses: [404] }
      );
    } catch (error) {
      if (error.status === 404) return null;
      throw error;
    }
  }

  /**
   * @param {string} objectType
   * @param {object} definition
   */
  createProperty(objectType, definition) {
    return this.request(
      'POST',
      `/crm/v3/properties/${objectType}`,
      definition,
      { objectType, propertyName: definition.name }
    );
  }
}

module.exports = HubSpotClient;
