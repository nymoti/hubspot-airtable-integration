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
            `Your HubSpot private app is missing the schema write scope for "${objectType}".\n` +
              'Add these four scopes to the private app, save, and re-run `npm run bootstrap`:\n' +
              '  crm.schemas.companies.write\n' +
              '  crm.schemas.contacts.write\n' +
              '  crm.schemas.deals.write\n' +
              '  crm.schemas.line_items.write\n' +
              'HubSpot → Settings → Integrations → Private Apps → your app → Scopes.',
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
