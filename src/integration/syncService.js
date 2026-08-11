'use strict';

const { randomUUID } = require('crypto');
const config = require('../shared/config');
const logger = require('../shared/logger');
const { HubSpotService } = require('./services/hubspotService');
const { AirtableService } = require('./services/airtableService');
const { normaliseEvent, ENTITIES } = require('./normaliseEvent');
const { handleCompany } = require('./handlers/companyHandler');
const { handleContact } = require('./handlers/contactHandler');
const { handleDeal } = require('./handlers/dealHandler');
const { handleLineItem } = require('./handlers/lineItemHandler');

/**
 * Dispatches a normalised Airtable event to the right handler.
 *
 * This is the seam between transport (HTTP, whether Cloud Function or local
 * Express) and business logic: it takes a parsed body and returns a result,
 * with no knowledge of requests or responses. That keeps the handlers testable
 * without spinning up a server, and means the same code would work unchanged
 * behind a Pub/Sub subscription if the service later moves to a queue.
 */

const HANDLERS = {
  [ENTITIES.COMPANY]: handleCompany,
  [ENTITIES.CONTACT]: handleContact,
  [ENTITIES.DEAL]: handleDeal,
  [ENTITIES.LINE_ITEM]: handleLineItem,
};

/** Airtable table name to read from, per entity. */
const TABLE_BY_ENTITY = {
  [ENTITIES.COMPANY]: () => config.airtable.tables.companies,
  [ENTITIES.CONTACT]: () => config.airtable.tables.contacts,
  [ENTITIES.DEAL]: () => config.airtable.tables.deals,
  [ENTITIES.LINE_ITEM]: () => config.airtable.tables.lineItems,
};

/**
 * Fields that exist on every row regardless of whether a human has typed
 * anything: the computed modification timestamp and our own write-back.
 */
const SYSTEM_FIELDS = new Set(['last_modified', 'hubspot_record_id']);

/**
 * True when a record carries no user-entered data.
 *
 * Airtable seeds every new table with blank rows, and they have a
 * `last modified time` like any other record, so a rescan picks them up. They
 * are not errors — there is simply nothing to sync — and reporting them as
 * failures would train whoever reads the logs to ignore a genuine failure
 * count.
 *
 * @param {Record<string, any>} fields
 * @returns {boolean}
 */
function isBlankRecord(fields) {
  return !Object.entries(fields || {}).some(([name, value]) => {
    if (SYSTEM_FIELDS.has(name)) return false;
    if (value === null || value === undefined || value === '') return false;
    if (Array.isArray(value)) return value.length > 0;
    return true;
  });
}

class SyncService {
  /**
   * @param {object} [options]
   * @param {HubSpotService} [options.hubspot]
   * @param {AirtableService} [options.airtable]
   */
  constructor(options = {}) {
    this.hubspot = options.hubspot || new HubSpotService();
    this.airtable = options.airtable || new AirtableService();
  }

  /**
   * Processes one inbound Airtable event end to end.
   *
   * @param {unknown} body the raw request body
   * @param {object} [options]
   * @param {string} [options.correlationId]
   * @returns {Promise<{ status: 'synced'|'skipped', correlationId: string, [key: string]: unknown }>}
   */
  async process(body, options = {}) {
    const correlationId = options.correlationId || randomUUID();
    const startedAt = Date.now();

    const event = normaliseEvent(body);

    // Every log line for this event carries the same correlation id and record
    // id, so one Cloud Logging query returns the complete trace.
    const log = logger.child({
      correlationId,
      entity: event.entity,
      table: event.table,
      airtableRecordId: event.recordId,
      airtableEventId: event.eventId,
    });

    log.info('Event received');

    const tableName = TABLE_BY_ENTITY[event.entity]();

    // The record is re-read from Airtable rather than trusted from the payload.
    // Webhook payloads are point-in-time snapshots: a redelivered or delayed
    // event would otherwise write stale values over newer ones, and automation
    // payloads routinely omit linked-record fields that association resolution
    // needs. Re-reading makes the sync converge on Airtable's current state
    // regardless of delivery order or duplication.
    let record = await this.airtable.getRecord(tableName, event.recordId);

    if (!record) {
      if (!event.fields) {
        // Deleted between the trigger firing and this invocation. Nothing to
        // sync, and nothing a retry would fix.
        log.warn('Record no longer exists in Airtable; skipping');
        return { status: 'skipped', reason: 'record_not_found', correlationId };
      }
      log.warn('Record not readable from Airtable; falling back to payload fields');
      record = { id: event.recordId, fields: event.fields };
    }

    if (isBlankRecord(record.fields)) {
      log.info('Record has no data yet; skipping');
      return { status: 'skipped', reason: 'blank_record', correlationId };
    }

    const handler = HANDLERS[event.entity];
    const result = await handler({
      record,
      hubspot: this.hubspot,
      airtable: this.airtable,
      logger: log,
    });

    const durationMs = Date.now() - startedAt;
    log.info('Event processed', { ...result, durationMs });

    return { status: 'synced', correlationId, durationMs, ...result };
  }
}

module.exports = { SyncService, HANDLERS, TABLE_BY_ENTITY, isBlankRecord };
