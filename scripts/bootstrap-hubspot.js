#!/usr/bin/env node
'use strict';

/**
 * One-time (idempotent) setup for a HubSpot portal.
 *
 * Creates the custom properties that both the migration and the integration
 * use for duplicate detection. Safe to re-run: existing properties are left
 * untouched.
 *
 * Usage: npm run bootstrap
 */

const HubSpotClient = require('../src/shared/hubspotClient');
const logger = require('../src/shared/logger');
const { OBJECT_TYPES, propertyDefinitions } = require('../src/shared/hubspotSchema');

/**
 * The scope that grants property creation, per object type.
 *
 * Line items are the exception: HubSpot has no `crm.schemas.line_items.write`
 * scope. Line items, products and quotes are all covered by the single
 * `e-commerce` scope instead.
 */
const SCHEMA_SCOPE_BY_OBJECT_TYPE = {
  [OBJECT_TYPES.COMPANIES]: 'crm.schemas.companies.write',
  [OBJECT_TYPES.CONTACTS]: 'crm.schemas.contacts.write',
  [OBJECT_TYPES.DEALS]: 'crm.schemas.deals.write',
  [OBJECT_TYPES.LINE_ITEMS]: 'e-commerce',
};

async function bootstrap() {
  const hubspot = new HubSpotClient();
  let created = 0;
  let existing = 0;

  for (const objectType of Object.values(OBJECT_TYPES)) {
    for (const definition of propertyDefinitions(objectType)) {
      const found = await hubspot.getProperty(objectType, definition.name);

      if (found) {
        existing += 1;
        logger.info('Property already present', {
          objectType,
          property: definition.name,
        });
        continue;
      }

      try {
        await hubspot.createProperty(objectType, definition);
      } catch (error) {
        // HubSpot answers a missing scope with a 403 listing every scope that
        // could conceivably grant the call — 26 of them, most irrelevant.
        // Translate it into the one thing the operator actually has to do.
        if (error.status === 403) {
          throw new Error(
            `Cannot create properties on "${objectType}" — the private app is missing ` +
              `the "${SCHEMA_SCOPE_BY_OBJECT_TYPE[objectType]}" scope.\n\n` +
              'Full set needed by this script:\n' +
              '  crm.schemas.companies.write\n' +
              '  crm.schemas.contacts.write\n' +
              '  crm.schemas.deals.write\n' +
              '  e-commerce                  (covers line items — there is no\n' +
              '                               crm.schemas.line_items.write scope)\n\n' +
              'HubSpot → Settings → Integrations → Private Apps → your app → Scopes.\n' +
              'Tick them, click Save, then confirm with "Continue updating".',
            { cause: error }
          );
        }
        throw error;
      }

      created += 1;
      logger.info('Property created', {
        objectType,
        property: definition.name,
      });
    }
  }

  logger.info('Bootstrap complete', { created, existing });
}

bootstrap().catch((error) => {
  logger.error('Bootstrap failed', {
    error: error.message,
    status: error.status,
    details: error.details,
  });
  process.exitCode = 1;
});
