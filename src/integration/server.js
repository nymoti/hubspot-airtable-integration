#!/usr/bin/env node
'use strict';

/**
 * Local development server.
 *
 * Runs the same Express app the Cloud Function serves, so behaviour verified
 * here (with an ngrok tunnel pointed at an Airtable automation, for example)
 * matches what is deployed.
 *
 * Usage: npm run dev
 */

const config = require('../shared/config');
const logger = require('../shared/logger');
const { createApp } = require('./app');

const app = createApp();

const server = app.listen(config.server.port, () => {
  logger.info('Integration service listening', {
    port: config.server.port,
    env: config.env,
    webhookAuth: config.webhookSecret ? 'enabled' : 'disabled (development only)',
  });
});

/** Finish in-flight webhooks before exiting, so no event is lost on deploy. */
function shutdown(signal) {
  logger.info('Shutting down', { signal });
  server.close(() => process.exit(0));
  // Do not hang forever if a connection refuses to close.
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled promise rejection', {
    error: reason instanceof Error ? reason.message : String(reason),
    stack: reason instanceof Error ? reason.stack : undefined,
  });
});
