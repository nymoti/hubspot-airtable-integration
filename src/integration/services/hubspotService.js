'use strict';

const HubSpotClient = require('../../shared/hubspotClient');
const logger = require('../../shared/logger');
const {
  EXTERNAL_ID_PROPERTY,
  buildExternalId,
} = require('../../shared/hubspotSchema');

/**
 * HubSpot operations expressed in the terms the sync handlers need: "make sure
 * this record exists and looks like this", rather than "POST or PATCH".
 *
 * ## Idempotency
 *
 * The service resolves an existing record through three tiers, cheapest and
 * most reliable first:
 *
 *  1. **`hubspot_record_id` from Airtable.** Authoritative when present. It is
 *     still verified with a GET, because a record deleted in HubSpot would
 *     otherwise make every later event fail with a 404 forever.
 *  2. **`external_source_id`.** Every record this service creates is stamped
 *     with `airtable:<object>:<recordId>`. This covers the window between
 *     creating a record in HubSpot and the write-back to Airtable landing —
 *     precisely the case a retried webhook hits, and the one that produced
 *     duplicates in the original implementation.
 *  3. **Natural key.** `domain` for companies, `email` for contacts. This
 *     catches records that already existed in the portal (from the Part 1
 *     migration, or entered by a salesperson) so the sync adopts them instead
 *     of creating a near-duplicate.
 *
 * Only if all three miss is a record created.
 */
class HubSpotService {
  /**
   * @param {object} [options]
   * @param {HubSpotClient} [options.client]
   * @param {import('winston').Logger} [options.logger]
   */
  constructor(options = {}) {
    this.client = options.client || new HubSpotClient();
    this.log = options.logger || logger;
  }

  /**
   * Resolves the HubSpot id for a record, or null if it does not exist yet.
   *
   * @param {object} params
   * @param {string} params.objectType
   * @param {string} [params.knownId] `hubspot_record_id` from Airtable
   * @param {string} params.externalId
   * @param {{ property: string, value: string }} [params.naturalKey]
   * @param {Record<string, unknown>} [params.logContext]
   * @returns {Promise<{ id: string, matchedBy: 'hubspot_record_id'|'external_source_id'|'natural_key' }|null>}
   */
  async resolveExisting(params) {
    const { objectType, knownId, externalId, naturalKey, logContext = {} } = params;

    // Tier 1 — the id Airtable already holds.
    if (knownId) {
      const record = await this.client.getObject(objectType, knownId, [
        EXTERNAL_ID_PROPERTY,
      ]);
      if (record) {
        return { id: record.id, matchedBy: 'hubspot_record_id' };
      }
      // Fall through: the record was deleted in HubSpot, so treat the stored
      // id as stale and re-resolve rather than failing.
      this.log.warn('Stored hubspot_record_id no longer exists, re-resolving', {
        ...logContext,
        objectType,
        staleHubspotId: knownId,
      });
    }

    // Tier 2 — our own external id, written at create time.
    const byExternalId = await this.client.searchByProperty(
      objectType,
      EXTERNAL_ID_PROPERTY,
      externalId,
      { properties: [EXTERNAL_ID_PROPERTY] }
    );
    if (byExternalId.length > 0) {
      return { id: byExternalId[0].id, matchedBy: 'external_source_id' };
    }

    // Tier 3 — the object's natural key, to adopt pre-existing records.
    if (naturalKey?.value) {
      const byNaturalKey = await this.client.searchByProperty(
        objectType,
        naturalKey.property,
        naturalKey.value,
        { properties: [EXTERNAL_ID_PROPERTY] }
      );
      if (byNaturalKey.length > 0) {
        this.log.info('Adopted an existing HubSpot record via natural key', {
          ...logContext,
          objectType,
          property: naturalKey.property,
          hubspotId: byNaturalKey[0].id,
        });
        return { id: byNaturalKey[0].id, matchedBy: 'natural_key' };
      }
    }

    return null;
  }

  /**
   * Creates or updates a record, whichever the idempotency check calls for.
   *
   * @param {object} params
   * @param {string} params.objectType
   * @param {string} params.airtableRecordId
   * @param {Record<string, string>} params.properties
   * @param {string} [params.knownId]
   * @param {{ property: string, value: string }} [params.naturalKey]
   * @param {Record<string, unknown>} [params.logContext]
   * @returns {Promise<{ id: string, action: 'created'|'updated', matchedBy: string|null }>}
   */
  async upsert(params) {
    const {
      objectType,
      airtableRecordId,
      properties,
      knownId,
      naturalKey,
      logContext = {},
    } = params;

    const externalId = buildExternalId('airtable', objectType, airtableRecordId);

    const existing = await this.resolveExisting({
      objectType,
      knownId,
      externalId,
      naturalKey,
      logContext,
    });

    // The external id is written on every upsert, not only on create, so that
    // records adopted via the natural key become resolvable by tier 2 too.
    const payload = {
      ...properties,
      [EXTERNAL_ID_PROPERTY]: externalId,
      external_source_system: 'airtable',
    };

    if (existing) {
      await this.client.updateObject(objectType, existing.id, payload, logContext);
      this.log.info('Record updated in HubSpot', {
        ...logContext,
        objectType,
        hubspotId: existing.id,
        matchedBy: existing.matchedBy,
      });
      return { id: existing.id, action: 'updated', matchedBy: existing.matchedBy };
    }

    const created = await this.client.createObject(objectType, payload, logContext);
    this.log.info('Record created in HubSpot', {
      ...logContext,
      objectType,
      hubspotId: created.id,
    });
    return { id: created.id, action: 'created', matchedBy: null };
  }

  /**
   * Associates two records using HubSpot's default association type.
   *
   * The underlying call is a PUT, so re-delivering an event re-asserts the
   * same association rather than adding a second one. A failure here is logged
   * and rethrown by the caller's discretion — the record itself is already
   * saved, so a missing association is recoverable on the next event.
   *
   * @param {string} fromObjectType
   * @param {string} fromId
   * @param {string} toObjectType
   * @param {string} toId
   * @param {Record<string, unknown>} [logContext]
   */
  async associate(fromObjectType, fromId, toObjectType, toId, logContext = {}) {
    await this.client.associate(
      fromObjectType,
      fromId,
      toObjectType,
      toId,
      logContext
    );
    this.log.info('Association written', {
      ...logContext,
      fromObjectType,
      fromId,
      toObjectType,
      toId,
    });
  }
}

module.exports = { HubSpotService };
