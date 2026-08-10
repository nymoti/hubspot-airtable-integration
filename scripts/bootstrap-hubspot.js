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

      await hubspot.createProperty(objectType, definition);
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
