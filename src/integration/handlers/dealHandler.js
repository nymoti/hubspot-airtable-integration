'use strict';

const config = require('../../shared/config');
const { OBJECT_TYPES } = require('../../shared/hubspotSchema');
const {
  parseAmount,
  parseDate,
  compactProperties,
} = require('../../shared/transforms');
const { ValidationError } = require('../../shared/errors');
const { mapStatusToDealStage } = require('../dealStage');
const { resolveParentHubspotId } = require('./resolveParent');
const { handleCompany } = require('./companyHandler');

/**
 * Syncs one Airtable **Deals** row into HubSpot and associates it with its
 * Company.
 *
 * Per the brief, deals are associated to a Company only — not directly to a
 * Contact. The contact relationship is reachable through the shared company.
 */

/**
 * @param {Record<string, any>} fields
 * @returns {Record<string, string>}
 */
function mapDealFields(fields) {
  return compactProperties({
    dealname: fields.deal_name,
    amount: parseAmount(fields.amount),
    dealstage: mapStatusToDealStage(fields.status),
    closedate: parseDate(fields.close_date),
    pipeline: config.hubspot.defaultPipeline,
  });
}

/**
 * @param {object} params
 * @param {{ id: string, fields: Record<string, any> }} params.record
 * @param {import('../services/hubspotService').HubSpotService} params.hubspot
 * @param {import('../services/airtableService').AirtableService} params.airtable
 * @param {import('winston').Logger} params.logger
 */
async function handleDeal({ record, hubspot, airtable, logger }) {
  const { id: airtableRecordId, fields } = record;

  if (!fields.deal_name) {
    throw new ValidationError('deal_name is required to sync a Deal', {
      context: { airtableRecordId },
    });
  }

  if (fields.close_date && parseDate(fields.close_date) === null) {
    // Not fatal — the deal syncs without a close date rather than being
    // rejected outright by HubSpot.
    logger.warn('close_date could not be parsed and was omitted', {
      airtableRecordId,
      closeDate: fields.close_date,
    });
  }

  const result = await hubspot.upsert({
    objectType: OBJECT_TYPES.DEALS,
    airtableRecordId,
    properties: mapDealFields(fields),
    knownId: fields.hubspot_record_id,
    // Deals have no natural key: two genuinely different deals can share a
    // name and amount. Matching is therefore limited to the stored HubSpot id
    // and our own external id, which is the correct conservative choice.
    logContext: { airtableRecordId, table: 'Deals' },
  });

  if (String(fields.hubspot_record_id || '') !== String(result.id)) {
    await airtable.writeBackHubspotId(
      config.airtable.tables.deals,
      airtableRecordId,
      result.id
    );
  }

  const companyHubspotId = await resolveParentHubspotId({
    fields,
    linkFieldNames: ['Company', 'Companies', 'Linked Company'],
    businessKeyField: 'company_id',
    parentTable: config.airtable.tables.companies,
    airtable,
    logger,
    syncParent: async (companyRecord) => {
      const synced = await handleCompany({
        record: companyRecord,
        hubspot,
        airtable,
        logger,
      });
      return { hubspotId: synced.hubspotId };
    },
  });

  if (companyHubspotId) {
    await hubspot.associate(
      OBJECT_TYPES.DEALS,
      result.id,
      OBJECT_TYPES.COMPANIES,
      companyHubspotId,
      { airtableRecordId, table: 'Deals' }
    );
  }

  logger.info('Deal synced', {
    airtableRecordId,
    hubspotId: result.id,
    action: result.action,
    matchedBy: result.matchedBy,
    dealStage: mapDealFields(fields).dealstage,
    associatedCompanyId: companyHubspotId,
  });

  return {
    objectType: OBJECT_TYPES.DEALS,
    hubspotId: result.id,
    action: result.action,
    associatedCompanyId: companyHubspotId,
  };
}

module.exports = { handleDeal, mapDealFields };
