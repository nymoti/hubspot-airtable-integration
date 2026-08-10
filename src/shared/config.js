'use strict';

require('dotenv').config();

/**
 * Centralised, validated configuration.
 *
 * Every module reads config from here rather than touching `process.env`
 * directly, so that a missing variable fails loudly at startup instead of
 * surfacing as a confusing 401 halfway through a migration run.
 */

function required(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing required environment variable: ${name}. See .env.example.`
    );
  }
  return value;
}

function optional(name, fallback) {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

function toInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const config = {
  env: optional('NODE_ENV', 'development'),

  hubspot: {
    get accessToken() {
      return required('HUBSPOT_ACCESS_TOKEN');
    },
    baseUrl: optional('HUBSPOT_BASE_URL', 'https://api.hubapi.com'),
    // HubSpot private apps allow 190 requests / 10s. We stay comfortably under.
    maxRequestsPerSecond: toInt(optional('HUBSPOT_MAX_RPS'), 8),
    maxRetries: toInt(optional('HUBSPOT_MAX_RETRIES'), 5),
    batchSize: toInt(optional('HUBSPOT_BATCH_SIZE'), 100),
  },

  airtable: {
    get apiKey() {
      return required('AIRTABLE_API_KEY');
    },
    get baseId() {
      return required('AIRTABLE_BASE_ID');
    },
    tables: {
      companies: optional('AIRTABLE_TABLE_COMPANIES', 'Companies'),
      contacts: optional('AIRTABLE_TABLE_CONTACTS', 'Contacts'),
      deals: optional('AIRTABLE_TABLE_DEALS', 'Deals'),
      lineItems: optional('AIRTABLE_TABLE_LINE_ITEMS', 'Line Items'),
    },

    /**
     * "Last modified time" field, present on all four tables. The rescan uses
     * it to find what changed since the previous notification.
     */
    modifiedField: optional('AIRTABLE_MODIFIED_FIELD', 'last_modified'),

    webhook: {
      /**
       * Base64 MAC secret returned when the webhook was registered. Airtable
       * signs every notification with it; without it we cannot tell a genuine
       * notification from anyone who guessed the URL.
       */
      macSecret: optional('AIRTABLE_WEBHOOK_MAC_SECRET', ''),

      /**
       * How far back a notification-triggered rescan looks. Generous on
       * purpose: re-processing an unchanged record is a no-op thanks to the
       * idempotent upsert, whereas missing one leaves HubSpot stale. The
       * window absorbs clock skew and delayed notifications.
       */
      lookbackMinutes: toInt(optional('RESCAN_LOOKBACK_MINUTES'), 10),

      /** Safety bound on how many records one rescan will process. */
      maxRecordsPerScan: toInt(optional('RESCAN_MAX_RECORDS'), 200),
    },
  },

  // Shared secret Airtable must send as `X-Webhook-Secret`. Optional in local
  // development, strongly recommended in production.
  webhookSecret: optional('WEBHOOK_SECRET', ''),

  logging: {
    level: optional('LOG_LEVEL', 'info'),
    // On Cloud Functions stdout is already captured by Cloud Logging, so file
    // transports are disabled there.
    toFile: optional('LOG_TO_FILE', 'true') === 'true',
    directory: optional('LOG_DIR', 'logs'),
  },

  server: {
    port: toInt(optional('PORT'), 3000),
  },

  migration: {
    dataDir: optional('MIGRATION_DATA_DIR', 'data'),
    // Import records whose parent company is missing from companies.csv
    // instead of dropping them. See README "Referential integrity".
    importOrphans: optional('MIGRATION_IMPORT_ORPHANS', 'true') === 'true',
    dryRun: optional('MIGRATION_DRY_RUN', 'false') === 'true',
  },
};

module.exports = config;
