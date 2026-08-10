'use strict';

/**
 * GCP Cloud Functions entry point (2nd gen, `nodejs20` runtime).
 *
 * The Functions Framework expects the exported handler at the repository root,
 * which is all this file provides — the implementation is the same Express app
 * used by the local dev server, so there is no deployment-only code path that
 * could drift out of test coverage.
 *
 * Deploy:
 *   gcloud functions deploy airtable-hubspot-sync \
 *     --gen2 --runtime=nodejs20 --region=us-central1 \
 *     --source=. --entry-point=airtableWebhook --trigger-http
 *
 * See README.md for the full deployment procedure and secret configuration.
 */

const functions = require('@google-cloud/functions-framework');
const { createApp } = require('./src/integration/app');

// Built once at cold start and reused across invocations: Cloud Functions keeps
// the instance warm between requests, so the HubSpot and Airtable clients (and
// their rate limiters) persist rather than being rebuilt per event.
const app = createApp();

functions.http('airtableWebhook', app);

module.exports = { app };
