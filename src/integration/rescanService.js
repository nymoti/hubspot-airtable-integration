'use strict';

const { randomUUID } = require('crypto');
const config = require('../shared/config');
const logger = require('../shared/logger');
const { SyncService } = require('./syncService');
const { ENTITIES } = require('./normaliseEvent');
const { ValidationError, MissingReferenceError } = require('../shared/errors');

/**
 * Turns an Airtable webhook notification into concrete sync work.
 *
 * Airtable's notification is only a doorbell: it says "something in this base
 * changed", carrying no record ids. The documented way to learn what changed is
 * to call `listPayloads` with a cursor. This service takes a different route —
 * it re-syncs every record modified in the recent past, found through the
 * ordinary data API and a `last modified time` field.
 *
 * That trade is deliberate. Cursor-based payload reading requires durable
 * storage for the cursor, correct handling of cursor loss, and reconciliation
 * when a payload is missed — real complexity whose only benefit is avoiding
 * redundant work. Because every upsert here is idempotent, redundant work is
 * free: re-syncing an unchanged record resolves to the same HubSpot id and
 * writes the same values. So the system trades a few wasted API calls for the
 * removal of an entire class of state-management bugs, and gains a useful
 * property along the way — a missed notification self-heals on the next one,
 * rather than leaving a permanent gap.
 *
 * Tables are processed parents-first so associations resolve within a single
 * pass.
 */

const SCAN_ORDER = [
  { entity: ENTITIES.COMPANY, table: () => config.airtable.tables.companies },
  { entity: ENTITIES.CONTACT, table: () => config.airtable.tables.contacts },
  { entity: ENTITIES.DEAL, table: () => config.airtable.tables.deals },
  { entity: ENTITIES.LINE_ITEM, table: () => config.airtable.tables.lineItems },
];

class RescanService {
  /**
   * @param {object} [options]
   * @param {SyncService} [options.syncService]
   * @param {import('./services/airtableService').AirtableService} [options.airtable]
   */
  constructor(options = {}) {
    this.syncService = options.syncService || new SyncService();
    // Share the sync service's Airtable client so both use the same
    // credentials and retry behaviour.
    this.airtable = options.airtable || this.syncService.airtable;
  }

  /**
   * Syncs every record modified within the lookback window.
   *
   * @param {object} [options]
   * @param {string} [options.correlationId]
   * @param {Date} [options.since] overrides the lookback window
   * @returns {Promise<{ correlationId: string, scanned: number, synced: number, failed: number, results: object[] }>}
   */
  async run(options = {}) {
    const correlationId = options.correlationId || randomUUID();
    const startedAt = Date.now();

    const since =
      options.since ||
      new Date(Date.now() - config.airtable.webhook.lookbackMinutes * 60_000);

    const log = logger.child({ correlationId, since: since.toISOString() });
    log.info('Rescan started');

    const summary = { scanned: 0, synced: 0, skipped: 0, failed: 0 };
    const results = [];

    for (const { entity, table } of SCAN_ORDER) {
      const tableName = table();

      const records = await this.airtable.listModifiedSince(tableName, since, {
        maxRecords: config.airtable.webhook.maxRecordsPerScan,
      });

      if (records.length === 0) continue;

      log.info('Modified records found', { table: tableName, count: records.length });
      summary.scanned += records.length;

      for (const record of records) {
        try {
          const result = await this.syncService.process(
            { table: tableName, recordId: record.id },
            { correlationId }
          );
          results.push(result);
          if (result.status === 'synced') summary.synced += 1;
          else summary.skipped += 1;
        } catch (error) {
          // One bad record must not abandon the rest of the scan. Permanent
          // failures (bad data) are logged and moved past; the record will be
          // retried on the next notification, and will keep failing visibly
          // until someone fixes it in Airtable.
          summary.failed += 1;
          const permanent =
            error instanceof ValidationError || error instanceof MissingReferenceError;

          log[permanent ? 'warn' : 'error']('Record failed during rescan', {
            table: tableName,
            entity,
            airtableRecordId: record.id,
            permanent,
            code: error.code,
            error: error.message,
          });
        }
      }
    }

    const durationMs = Date.now() - startedAt;
    log.info('Rescan finished', { ...summary, durationMs });

    return { correlationId, durationMs, ...summary, results };
  }
}

module.exports = { RescanService, SCAN_ORDER };
