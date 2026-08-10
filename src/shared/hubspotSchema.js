'use strict';

const config = require('./config');

/**
 * HubSpot object types and the custom properties this project relies on.
 *
 * Both parts of the project stamp every record with the id it came from in the
 * source system (`external_source_id`). That single property is what makes the
 * whole thing idempotent: re-running the migration, or replaying an Airtable
 * webhook, resolves to the record that already exists instead of creating a
 * second one. The previous implementation stuffed those ids into the
 * `description` field, which is not searchable as an exact match and is
 * overwritten by anyone editing the record in the HubSpot UI.
 *
 * Run `npm run bootstrap` once per portal to create these properties.
 */

const OBJECT_TYPES = {
  COMPANIES: 'companies',
  CONTACTS: 'contacts',
  DEALS: 'deals',
  LINE_ITEMS: 'line_items',
};

/** Name of the external-id property, identical on every object type. */
const EXTERNAL_ID_PROPERTY = config.hubspot.externalIdProperty;

/** Records which system a record was synced from, for auditability. */
const SOURCE_SYSTEM_PROPERTY = config.hubspot.sourceSystemProperty;

const PROPERTY_GROUPS = {
  [OBJECT_TYPES.COMPANIES]: 'companyinformation',
  [OBJECT_TYPES.CONTACTS]: 'contactinformation',
  [OBJECT_TYPES.DEALS]: 'dealinformation',
  [OBJECT_TYPES.LINE_ITEMS]: 'lineiteminformation',
};

/**
 * Property definitions to create on each object type, in HubSpot's
 * `/crm/v3/properties` schema format.
 *
 * @param {string} objectType
 * @returns {object[]}
 */
function propertyDefinitions(objectType) {
  return [
    {
      name: EXTERNAL_ID_PROPERTY,
      label: 'External Source ID',
      description:
        'Primary key of this record in the system it was synced from (CSV migration or Airtable). Used for duplicate detection — do not edit.',
      groupName: PROPERTY_GROUPS[objectType],
      type: 'string',
      fieldType: 'text',
      hasUniqueValue: true,
    },
    {
      name: SOURCE_SYSTEM_PROPERTY,
      label: 'External Source System',
      description: 'Which system this record was synced from.',
      groupName: PROPERTY_GROUPS[objectType],
      type: 'enumeration',
      fieldType: 'select',
      options: [
        { label: 'CSV Migration', value: 'csv_migration', displayOrder: 0 },
        { label: 'Airtable', value: 'airtable', displayOrder: 1 },
      ],
    },
  ];
}

/**
 * Builds the namespaced external id for a record.
 *
 * Namespacing by object type keeps company #12 and deal #12 distinct, and the
 * source prefix keeps a migrated record separate from an Airtable record that
 * happens to reuse the same numeric id.
 *
 * @param {string} source e.g. `csv` or `airtable`
 * @param {string} objectType
 * @param {string|number} id
 * @returns {string}
 */
function buildExternalId(source, objectType, id) {
  return `${source}:${objectType}:${id}`;
}

module.exports = {
  OBJECT_TYPES,
  EXTERNAL_ID_PROPERTY,
  SOURCE_SYSTEM_PROPERTY,
  PROPERTY_GROUPS,
  propertyDefinitions,
  buildExternalId,
};
