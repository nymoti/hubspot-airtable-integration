#!/usr/bin/env node
'use strict';

/**
 * Registers, lists, refreshes and deletes the Airtable webhook.
 *
 * Airtable's free plan blocks the automation actions that can call an external
 * URL, but the Webhooks API is open to every plan — so this is how the sync is
 * triggered in real time.
 *
 * Usage:
 *   node scripts/manage-airtable-webhook.js create https://…/airtable-webhook
 *   node scripts/manage-airtable-webhook.js list
 *   node scripts/manage-airtable-webhook.js refresh [webhookId]
 *   node scripts/manage-airtable-webhook.js delete <webhookId>
 *
 * `create` prints a MAC secret exactly once. Store it as
 * AIRTABLE_WEBHOOK_MAC_SECRET — it cannot be retrieved later, and without it
 * the service rejects every notification as unsigned.
 */

const logger = require('../src/shared/logger');
const { AirtableWebhookApi } = require('../src/integration/services/airtableWebhookApi');

const [, , command, argument] = process.argv;

async function create(notificationUrl) {
  if (!notificationUrl) {
    throw new Error('Usage: manage-airtable-webhook.js create <https://…/airtable-webhook>');
  }

  const api = new AirtableWebhookApi();

  // Airtable allows a limited number of webhooks per base, and a stale one
  // pointing at an old function URL would keep failing silently.
  const existing = await api.list();
  if (existing.length > 0) {
    logger.warn('Base already has webhooks registered', {
      count: existing.length,
      ids: existing.map((hook) => hook.id),
      hint: 'Delete stale ones with: manage-airtable-webhook.js delete <id>',
    });
  }

  const webhook = await api.create(notificationUrl);

  logger.info('Webhook registered', {
    id: webhook.id,
    notificationUrl,
    expiresAt: webhook.expirationTime,
  });

  // Printed to stdout rather than logged, so it can be piped straight into
  // Secret Manager without log formatting around it.
  process.stdout.write(
    [
      '',
      '─'.repeat(72),
      'Store this now — Airtable will not show it again:',
      '',
      `AIRTABLE_WEBHOOK_MAC_SECRET=${webhook.macSecretBase64}`,
      '',
      'The webhook expires in 7 days unless refreshed. Schedule:',
      '  node scripts/manage-airtable-webhook.js refresh',
      '─'.repeat(72),
      '',
    ].join('\n')
  );
}

async function list() {
  const webhooks = await new AirtableWebhookApi().list();

  if (webhooks.length === 0) {
    logger.warn('No webhooks registered on this base');
    return;
  }

  for (const webhook of webhooks) {
    logger.info('Webhook', {
      id: webhook.id,
      notificationUrl: webhook.notificationUrl,
      expiresAt: webhook.expirationTime,
      // Airtable disables delivery after repeated failures; this is the field
      // that explains a webhook that has silently stopped working.
      isHookEnabled: webhook.isHookEnabled,
      lastSuccessfulNotificationTime: webhook.lastSuccessfulNotificationTime,
    });
  }
}

/**
 * Refreshes one webhook, or all of them when no id is given — the form the
 * scheduled job uses, since it should not need to know the id.
 */
async function refresh(webhookId) {
  const api = new AirtableWebhookApi();
  const targets = webhookId ? [{ id: webhookId }] : await api.list();

  if (targets.length === 0) {
    throw new Error('No webhooks to refresh. Register one with `create` first.');
  }

  for (const target of targets) {
    const result = await api.refresh(target.id);
    logger.info('Webhook refreshed', {
      id: target.id,
      expiresAt: result?.expirationTime,
    });
  }
}

async function remove(webhookId) {
  if (!webhookId) throw new Error('Usage: manage-airtable-webhook.js delete <webhookId>');
  await new AirtableWebhookApi().delete(webhookId);
  logger.info('Webhook deleted', { id: webhookId });
}

const COMMANDS = { create, list, refresh, delete: remove };

async function main() {
  const handler = COMMANDS[command];
  if (!handler) {
    throw new Error(
      `Unknown command "${command ?? ''}". Expected one of: ${Object.keys(COMMANDS).join(', ')}`
    );
  }
  await handler(argument);
}

main().catch((error) => {
  logger.error('Webhook management failed', {
    command,
    error: error.message,
    status: error.status,
  });
  process.exitCode = 1;
});
