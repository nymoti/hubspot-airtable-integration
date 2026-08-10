'use strict';

const { ValidationError } = require('../shared/errors');

/**
 * Turns whatever Airtable posted into a canonical event.
 *
 * Airtable automations are configured by hand, and the "Send web request"
 * action lets the author name the fields freely, so the payload shape varies
 * between bases and drifts as the automation is edited. Normalising once, at
 * the edge, keeps that variability out of the handlers — and gives one place
 * to produce a clear error when the automation is misconfigured.
 *
 * Accepted shapes:
 *   { "table": "Companies", "recordId": "rec123", "fields": { … } }
 *   { "table_name": "Companies", "record": { "id": "rec123", "fields": { … } } }
 *   { "tableName": "Companies", "id": "rec123" }
 */

/** Canonical entity keys. */
const ENTITIES = {
  COMPANY: 'company',
  CONTACT: 'contact',
  DEAL: 'deal',
  LINE_ITEM: 'line_item',
};

/**
 * Airtable table names (and common variants) mapped to canonical entities.
 * Keys are compared lower-cased with punctuation and spacing removed, so
 * "Line Items", "line_items" and "lineItems" all resolve.
 */
const ENTITY_BY_TABLE = {
  company: ENTITIES.COMPANY,
  companies: ENTITIES.COMPANY,
  contact: ENTITIES.CONTACT,
  contacts: ENTITIES.CONTACT,
  deal: ENTITIES.DEAL,
  deals: ENTITIES.DEAL,
  lineitem: ENTITIES.LINE_ITEM,
  lineitems: ENTITIES.LINE_ITEM,
};

/**
 * @param {string} tableName
 * @returns {string|null} a canonical entity key
 */
function resolveEntity(tableName) {
  if (!tableName) return null;
  const key = String(tableName).toLowerCase().replace(/[^a-z]/g, '');
  return ENTITY_BY_TABLE[key] || null;
}

/**
 * @param {unknown} body the parsed request body
 * @returns {{ entity: string, table: string, recordId: string, fields: Record<string, any>|null, eventId: string|null }}
 * @throws {ValidationError} when the payload cannot be interpreted
 */
function normaliseEvent(body) {
  if (!body || typeof body !== 'object') {
    throw new ValidationError('Request body must be a JSON object');
  }

  const table = body.table || body.table_name || body.tableName || body.record?.table;
  const entity = resolveEntity(table);

  if (!entity) {
    throw new ValidationError(
      `Unknown or missing table name "${table ?? ''}". Expected one of: Companies, Contacts, Deals, Line Items.`,
      { context: { receivedKeys: Object.keys(body) } }
    );
  }

  const recordId =
    body.recordId ||
    body.record_id ||
    body.id ||
    body.record?.id ||
    body.record?.recordId;

  if (!recordId || typeof recordId !== 'string') {
    throw new ValidationError(
      'Payload is missing the Airtable record id (expected `recordId`).',
      { context: { table } }
    );
  }

  const fields = body.fields || body.record?.fields || null;

  return {
    entity,
    table: String(table),
    recordId,
    fields: fields && typeof fields === 'object' ? fields : null,
    // Used purely for log correlation when the automation supplies one.
    eventId: body.eventId || body.event_id || null,
  };
}

module.exports = { normaliseEvent, resolveEntity, ENTITIES, ENTITY_BY_TABLE };
