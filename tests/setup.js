'use strict';

/**
 * Test environment.
 *
 * Credentials are stubbed so `config` validation passes without a real portal,
 * and no test in this suite is permitted to reach the network — the HubSpot and
 * Airtable clients are always injected as mocks.
 */

process.env.NODE_ENV = 'test';
process.env.HUBSPOT_ACCESS_TOKEN = 'pat-test-token';
process.env.AIRTABLE_API_KEY = 'pat-test-airtable-key';
process.env.AIRTABLE_BASE_ID = 'appTestBase';
process.env.WEBHOOK_SECRET = 'test-secret';
process.env.LOG_LEVEL = 'error';
process.env.LOG_TO_FILE = 'false';
