'use strict';

const config = require('../../shared/config');
const { OBJECT_TYPES } = require('../../shared/hubspotSchema');
const {
  normaliseDomain,
  parseInteger,
  compactProperties,
} = require('../../shared/transforms');
const { ValidationError } = require('../../shared/errors');

/**
 * Syncs one Airtable **Companies** row into HubSpot.
 *
 * Companies are the root of the association graph — contacts and deals both
 * hang off them — so this handler is also called indirectly by the contact and
 * deal handlers when they encounter a company that has not been synced yet.
 */

/**
 * Maps an Airtable Companies row onto HubSpot company properties.
 *
 * @param {Record<string, any>} fields
 * @returns {Record<string, string>}
 */
function mapCompanyFields(fields) {
  return compactProperties({
    name: fields.company_name,
    domain: normaliseDomain(fields.domain),
    industry: fields.industry,
    numberofemployees: parseInteger(fields.number_of_employees),
  });
}

/**
 * @param {object} params
 * @param {{ id: string, fields: Record<string, any> }} params.record
 * @param {import('../services/hubspotService').HubSpotService} params.hubspot
 * @param {import('../services/airtableService').AirtableService} params.airtable
 * @param {import('winston').Logger} params.logger
 * @returns {Promise<{ objectType: string, hubspotId: string, action: string }>}
 */
async function handleCompany({ record, hubspot, airtable, logger }) {
  const { id: airtableRecordId, fields } = record;

  if (!fields.company_name) {
    throw new ValidationError('company_name is required to sync a Company', {
      context: { airtableRecordId },
    });
  }

  const properties = mapCompanyFields(fields);

  const result = await hubspot.upsert({
    objectType: OBJECT_TYPES.COMPANIES,
    airtableRecordId,
    properties,
    knownId: fields.hubspot_record_id,
    // Domain is HubSpot's own deduplication key for companies, so matching on
    // it prevents creating a second "Acme Corp" beside one that already exists.
    naturalKey: { property: 'domain', value: normaliseDomain(fields.domain) },
    logContext: { airtableRecordId, table: 'Companies' },
  });

  // Only write back when the value would actually change — an unnecessary
  // Airtable update would trigger another webhook and loop.
  if (String(fields.hubspot_record_id || '') !== String(result.id)) {
    await airtable.writeBackHubspotId(
      config.airtable.tables.companies,
      airtableRecordId,
      result.id
    );
  }

  logger.info('Company synced', {
    airtableRecordId,
    hubspotId: result.id,
    action: result.action,
    matchedBy: result.matchedBy,
  });

  return {
    objectType: OBJECT_TYPES.COMPANIES,
    hubspotId: result.id,
    action: result.action,
  };
}

module.exports = { handleCompany, mapCompanyFields };
