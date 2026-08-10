'use strict';

const config = require('../../shared/config');
const { OBJECT_TYPES } = require('../../shared/hubspotSchema');
const { parseAmount, compactProperties } = require('../../shared/transforms');
const { ValidationError } = require('../../shared/errors');
const { resolveParentHubspotId } = require('./resolveParent');
const { handleDeal } = require('./dealHandler');

/**
 * Syncs one Airtable **Line Items** row into HubSpot and attaches it to its
 * Deal.
 *
 * This creates a real HubSpot `line_items` object associated with the deal,
 * rather than adding the line total onto the deal's `amount`. Two reasons:
 *
 *  - Line items are a first-class CRM object in HubSpot; they show up on the
 *    deal record, in quotes and in revenue reporting, none of which a rolled-up
 *    number would do.
 *  - Adding to `amount` is not idempotent. A redelivered webhook would add the
 *    same total a second time and silently inflate the deal — the exact class
 *    of bug the brief asks the service to be safe against.
 *
 * A deal's `amount` is deliberately left alone here; HubSpot recalculates it
 * from its line items when the deal is managed that way.
 */

/**
 * @param {Record<string, any>} fields
 * @returns {Record<string, string>}
 */
function mapLineItemFields(fields) {
  return compactProperties({
    name: fields.product_name,
    quantity: parseAmount(fields.quantity),
    price: parseAmount(fields.unit_price),
  });
}

/**
 * @param {object} params
 * @param {{ id: string, fields: Record<string, any> }} params.record
 * @param {import('../services/hubspotService').HubSpotService} params.hubspot
 * @param {import('../services/airtableService').AirtableService} params.airtable
 * @param {import('winston').Logger} params.logger
 */
async function handleLineItem({ record, hubspot, airtable, logger }) {
  const { id: airtableRecordId, fields } = record;

  if (!fields.product_name) {
    throw new ValidationError('product_name is required to sync a Line Item', {
      context: { airtableRecordId },
    });
  }

  // Unlike the other objects, a line item is meaningless without its parent —
  // HubSpot has nowhere to put it — so the deal must resolve before we create
  // anything.
  const dealHubspotId = await resolveParentHubspotId({
    fields,
    linkFieldNames: ['Deal', 'Deals', 'Linked Deal'],
    businessKeyField: 'deal_id',
    parentTable: config.airtable.tables.deals,
    airtable,
    logger,
    required: true,
    syncParent: async (dealRecord) => {
      const synced = await handleDeal({
        record: dealRecord,
        hubspot,
        airtable,
        logger,
      });
      return { hubspotId: synced.hubspotId };
    },
  });

  const result = await hubspot.upsert({
    objectType: OBJECT_TYPES.LINE_ITEMS,
    airtableRecordId,
    properties: mapLineItemFields(fields),
    knownId: fields.hubspot_record_id,
    logContext: { airtableRecordId, table: 'Line Items' },
  });

  if (String(fields.hubspot_record_id || '') !== String(result.id)) {
    await airtable.writeBackHubspotId(
      config.airtable.tables.lineItems,
      airtableRecordId,
      result.id
    );
  }

  await hubspot.associate(
    OBJECT_TYPES.LINE_ITEMS,
    result.id,
    OBJECT_TYPES.DEALS,
    dealHubspotId,
    { airtableRecordId, table: 'Line Items' }
  );

  logger.info('Line item synced', {
    airtableRecordId,
    hubspotId: result.id,
    action: result.action,
    matchedBy: result.matchedBy,
    associatedDealId: dealHubspotId,
  });

  return {
    objectType: OBJECT_TYPES.LINE_ITEMS,
    hubspotId: result.id,
    action: result.action,
    associatedDealId: dealHubspotId,
  };
}

module.exports = { handleLineItem, mapLineItemFields };
