'use strict';

const { MissingReferenceError } = require('../../shared/errors');

/**
 * Resolves the HubSpot id of a record's parent (a Contact's Company, a Deal's
 * Company, a Line Item's Deal).
 *
 * Webhooks arrive in whatever order Airtable fires them, and a user can easily
 * create a Contact seconds after its Company — before the Company's own
 * webhook has been processed. Rather than failing, this resolver syncs the
 * parent on demand and then continues. That makes each handler independent of
 * delivery order, which is the property that actually keeps associations
 * intact in production.
 *
 * The parent is located by, in order:
 *   1. the Airtable linked-record field (authoritative — it holds a record id);
 *   2. the business-key field (`company_id`, `deal_id`) as a fallback, for
 *      bases where the link has not been filled in.
 */

/**
 * Reads the first linked record id out of an Airtable link field.
 *
 * Link fields are arrays of record ids; a cleared link is either absent or an
 * empty array. Several field names are accepted because Airtable bases label
 * these differently ("Company", "Companies", "Linked Company").
 *
 * @param {Record<string, any>} fields
 * @param {string[]} candidateFieldNames
 * @returns {string|null}
 */
function firstLinkedRecordId(fields, candidateFieldNames) {
  for (const fieldName of candidateFieldNames) {
    const value = fields[fieldName];
    if (Array.isArray(value) && value.length > 0) return value[0];
    // A lookup/rollup can flatten a link to a bare string.
    if (typeof value === 'string' && value.startsWith('rec')) return value;
  }
  return null;
}

/**
 * @param {object} params
 * @param {Record<string, any>} params.fields fields of the child record
 * @param {string[]} params.linkFieldNames candidate Airtable link field names
 * @param {string} [params.businessKeyField] e.g. `company_id` on the child row
 * @param {string} [params.parentBusinessKeyField] e.g. `company_id` on the parent row
 * @param {string} params.parentTable Airtable table name of the parent
 * @param {(record: { id: string, fields: Record<string, any> }) => Promise<{ hubspotId: string }>} params.syncParent
 * @param {import('../services/airtableService').AirtableService} params.airtable
 * @param {import('winston').Logger} params.logger
 * @param {boolean} [params.required=false] throw when the parent cannot be resolved
 * @returns {Promise<string|null>} the parent's HubSpot id
 */
async function resolveParentHubspotId(params) {
  const {
    fields,
    linkFieldNames,
    businessKeyField,
    parentBusinessKeyField,
    parentTable,
    syncParent,
    airtable,
    logger,
    required = false,
  } = params;

  const missing = (reason) => {
    if (required) {
      throw new MissingReferenceError(reason, {
        context: { parentTable, businessKeyField },
      });
    }
    logger.warn('Parent record could not be resolved; association skipped', {
      parentTable,
      reason,
    });
    return null;
  };

  // 1. Airtable link field.
  let parentRecord = null;
  const linkedRecordId = firstLinkedRecordId(fields, linkFieldNames);

  if (linkedRecordId) {
    parentRecord = await airtable.getRecord(parentTable, linkedRecordId);
  }

  // 2. Business-key fallback.
  if (!parentRecord && businessKeyField && fields[businessKeyField]) {
    parentRecord = await airtable.findByField(
      parentTable,
      parentBusinessKeyField || businessKeyField,
      fields[businessKeyField]
    );
  }

  if (!parentRecord) {
    return missing(
      `No linked ${parentTable} record found (link fields: ${linkFieldNames.join(', ')}` +
        (businessKeyField ? `; ${businessKeyField}="${fields[businessKeyField] ?? ''}"` : '') +
        ')'
    );
  }

  // The parent is already in HubSpot.
  if (parentRecord.fields.hubspot_record_id) {
    return String(parentRecord.fields.hubspot_record_id);
  }

  // The parent has not been synced yet — sync it now so the association can be
  // written in this same invocation.
  logger.info('Parent not yet synced; syncing it before the child', {
    parentTable,
    parentRecordId: parentRecord.id,
  });

  try {
    const result = await syncParent(parentRecord);
    return (
      result?.hubspotId ??
      missing(`Syncing parent ${parentRecord.id} produced no HubSpot id`)
    );
  } catch (error) {
    // A parent that HubSpot rejects must not take its children down with it.
    // One invalid company previously failed its contacts and deals too, so a
    // single bad field turned into a cascade of unrelated failures. The child
    // is still worth saving; only the association is deferred, and the next
    // event retries it once the parent is fixed.
    logger.error('Parent could not be synced; continuing without the association', {
      parentTable,
      parentRecordId: parentRecord.id,
      code: error.code,
      error: error.message,
    });
    return missing(`Parent ${parentRecord.id} failed to sync: ${error.message}`);
  }
}

module.exports = { resolveParentHubspotId, firstLinkedRecordId };
