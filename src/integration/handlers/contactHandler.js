'use strict';

const config = require('../../shared/config');
const { OBJECT_TYPES } = require('../../shared/hubspotSchema');
const {
  normaliseEmail,
  cleanPhone,
  compactProperties,
} = require('../../shared/transforms');
const { ValidationError } = require('../../shared/errors');
const { resolveParentHubspotId } = require('./resolveParent');
const { handleCompany } = require('./companyHandler');

/**
 * Syncs one Airtable **Contacts** row into HubSpot and associates it with its
 * Company.
 */

/**
 * @param {Record<string, any>} fields
 * @returns {Record<string, string>}
 */
function mapContactFields(fields) {
  return compactProperties({
    firstname: fields.first_name,
    lastname: fields.last_name,
    email: normaliseEmail(fields.email),
    phone: cleanPhone(fields.phone),
  });
}

/**
 * @param {object} params
 * @param {{ id: string, fields: Record<string, any> }} params.record
 * @param {import('../services/hubspotService').HubSpotService} params.hubspot
 * @param {import('../services/airtableService').AirtableService} params.airtable
 * @param {import('winston').Logger} params.logger
 */
async function handleContact({ record, hubspot, airtable, logger }) {
  const { id: airtableRecordId, fields } = record;

  const email = normaliseEmail(fields.email);
  if (!email) {
    // Email is HubSpot's unique key for contacts. Creating a contact without
    // one produces a record that can never be matched again, so this is a hard
    // validation failure rather than a warning.
    throw new ValidationError(
      `A valid email is required to sync a Contact (got "${fields.email ?? ''}")`,
      { context: { airtableRecordId } }
    );
  }

  const result = await hubspot.upsert({
    objectType: OBJECT_TYPES.CONTACTS,
    airtableRecordId,
    properties: mapContactFields(fields),
    knownId: fields.hubspot_record_id,
    naturalKey: { property: 'email', value: email },
    logContext: { airtableRecordId, table: 'Contacts' },
  });

  if (String(fields.hubspot_record_id || '') !== String(result.id)) {
    await airtable.writeBackHubspotId(
      config.airtable.tables.contacts,
      airtableRecordId,
      result.id
    );
  }

  // Association is attempted after the contact is safely saved. If the company
  // cannot be resolved, the contact still exists and the association is picked
  // up on the next event for this row.
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
      OBJECT_TYPES.CONTACTS,
      result.id,
      OBJECT_TYPES.COMPANIES,
      companyHubspotId,
      { airtableRecordId, table: 'Contacts' }
    );
  }

  logger.info('Contact synced', {
    airtableRecordId,
    hubspotId: result.id,
    action: result.action,
    matchedBy: result.matchedBy,
    associatedCompanyId: companyHubspotId,
  });

  return {
    objectType: OBJECT_TYPES.CONTACTS,
    hubspotId: result.id,
    action: result.action,
    associatedCompanyId: companyHubspotId,
  };
}

module.exports = { handleContact, mapContactFields };
