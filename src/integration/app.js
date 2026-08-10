'use strict';

const { randomUUID } = require('crypto');
const { timingSafeEqual } = require('crypto');
const express = require('express');
const config = require('../shared/config');
const logger = require('../shared/logger');
const { SyncService } = require('./syncService');
const { RescanService } = require('./rescanService');
const { verifyNotification, MAC_HEADER } = require('./airtableWebhookAuth');
const { ValidationError, MissingReferenceError } = require('../shared/errors');

/**
 * The HTTP surface of the integration.
 *
 * The same Express app backs both entry points — `npm run dev` locally and the
 * GCP Cloud Function in production — so there is exactly one implementation of
 * routing, authentication and error mapping to reason about and to test.
 *
 * ## Status codes are a retry contract
 *
 * Airtable (and any queue placed in front of this later) decides whether to
 * redeliver based on the status code, so the mapping is deliberate:
 *
 *   200 — handled, or safely skipped. Do not retry.
 *   400 — the payload or record is invalid. Retrying cannot help, so it is
 *         reported as handled-with-error rather than inviting a redelivery
 *         storm against a record that will never be valid.
 *   401 — bad or missing shared secret.
 *   429/5xx — transient. Retrying is appropriate and desirable.
 */

/**
 * Constant-time comparison so the shared secret cannot be recovered by
 * measuring how long a rejection takes.
 *
 * @param {string} a
 * @param {string} b
 */
function secretsMatch(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * Rejects requests that do not present the shared secret.
 *
 * The endpoint is public by necessity — Airtable must be able to reach it — so
 * a shared secret is the minimum bar to stop anyone who finds the URL from
 * writing into the CRM. It is optional only in local development.
 */
function authenticate(req, res, next) {
  if (!config.webhookSecret) {
    if (config.env === 'production') {
      logger.error('WEBHOOK_SECRET is not set; refusing to accept requests');
      return res.status(500).json({ error: 'Service is misconfigured' });
    }
    return next();
  }

  const presented = req.get('X-Webhook-Secret') || '';
  if (!secretsMatch(presented, config.webhookSecret)) {
    logger.warn('Rejected request with invalid webhook secret', {
      path: req.path,
      ip: req.ip,
    });
    return res.status(401).json({ error: 'Unauthorized' });
  }

  return next();
}

/**
 * @param {object} [options]
 * @param {SyncService} [options.syncService] injectable for tests
 * @returns {import('express').Express}
 */
function createApp(options = {}) {
  const syncService = options.syncService || new SyncService();
  const rescanService =
    options.rescanService || new RescanService({ syncService });
  const app = express();

  // The raw body is retained because Airtable's HMAC is computed over the
  // exact bytes sent; re-serialising the parsed object would change key order
  // and whitespace, and the signature would never verify.
  app.use(
    express.json({
      limit: '1mb',
      verify: (req, res, buffer) => {
        req.rawBody = buffer;
      },
    })
  );

  // Bind a correlation id early so it appears on request logs and is returned
  // to the caller, making a report of "this record didn't sync" traceable.
  app.use((req, res, next) => {
    req.correlationId = req.get('X-Correlation-Id') || randomUUID();
    res.set('X-Correlation-Id', req.correlationId);
    next();
  });

  /** Liveness probe — deliberately unauthenticated and dependency-free. */
  app.get('/health', (req, res) => {
    res.status(200).json({ status: 'ok', uptimeSeconds: process.uptime() });
  });

  /** The endpoint Airtable automations post to. */
  app.post('/webhook', authenticate, async (req, res) => {
    try {
      const result = await syncService.process(req.body, {
        correlationId: req.correlationId,
      });
      res.status(200).json(result);
    } catch (error) {
      handleError(error, req, res);
    }
  });

  /**
   * The endpoint Airtable's Webhooks API notifies.
   *
   * The notification is only a doorbell — it names the base and webhook, never
   * the records that changed — so the handler answers it by re-syncing
   * everything modified in the recent past. See `rescanService.js` for why
   * that is preferred over cursor-based payload reading.
   */
  app.post('/airtable-webhook', async (req, res) => {
    const authentic = verifyNotification({
      rawBody: req.rawBody,
      header: req.get(MAC_HEADER),
      macSecret: config.airtable.webhook.macSecret,
    });

    if (!authentic) {
      logger.warn('Rejected Airtable notification with an invalid signature', {
        correlationId: req.correlationId,
        ip: req.ip,
        // Distinguishes "someone found the URL" from "the secret is not
        // configured", which look identical from the outside.
        macSecretConfigured: Boolean(config.airtable.webhook.macSecret),
      });
      return res.status(401).json({ error: 'Invalid signature' });
    }

    try {
      const result = await rescanService.run({ correlationId: req.correlationId });
      // The per-record detail is useful in the logs but noisy in a response
      // Airtable discards anyway.
      const { results, ...summary } = result;
      res.status(200).json(summary);
    } catch (error) {
      handleError(error, req, res);
    }
  });

  /**
   * Manual rescan, protected by the same shared secret as `/webhook`.
   *
   * Useful for backfilling after the service has been down, and for
   * demonstrating the sync without waiting on a notification.
   */
  app.post('/rescan', authenticate, async (req, res) => {
    try {
      const minutes = Number(req.query.minutes);
      const since = Number.isFinite(minutes)
        ? new Date(Date.now() - minutes * 60_000)
        : undefined;

      const result = await rescanService.run({
        correlationId: req.correlationId,
        since,
      });
      const { results, ...summary } = result;
      res.status(200).json(summary);
    } catch (error) {
      handleError(error, req, res);
    }
  });

  // 404 for anything else.
  app.use((req, res) => {
    res.status(404).json({ error: 'Not found', path: req.path });
  });

  return app;
}

/**
 * Maps an error onto a status code and a response body, and logs it once.
 *
 * @param {Error & { status?: number, retryable?: boolean, details?: unknown }} error
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
function handleError(error, req, res) {
  const correlationId = req.correlationId;

  // Permanent, caller-side problems: log at warn and tell the sender not to
  // bother retrying.
  if (error instanceof ValidationError || error instanceof MissingReferenceError) {
    logger.warn('Event rejected', {
      correlationId,
      code: error.code,
      error: error.message,
      context: error.context,
    });
    return res.status(400).json({
      error: error.message,
      code: error.code,
      correlationId,
      retryable: false,
    });
  }

  const retryable = error.retryable === true || (error.status ?? 500) >= 500;
  const status = retryable ? error.status === 429 ? 429 : 503 : 400;

  logger.error('Event failed', {
    correlationId,
    code: error.code,
    status: error.status,
    details: error.details,
    retryable,
    error: error.message,
    stack: error.stack,
  });

  res.status(status).json({
    error: error.message,
    code: error.code || 'INTERNAL_ERROR',
    correlationId,
    retryable,
  });
}

module.exports = { createApp, authenticate, secretsMatch };
