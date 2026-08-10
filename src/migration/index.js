#!/usr/bin/env node
'use strict';

/**
 * Entry point for Part 1 — the CSV → HubSpot migration.
 *
 * Usage:
 *   npm run migrate              import companies, contacts, deals and associations
 *   npm run migrate -- --dry-run validate and report without writing to HubSpot
 *
 * The migration is safe to re-run: records are matched on `external_source_id`
 * and updated in place rather than duplicated.
 */

const logger = require('../shared/logger');
const config = require('../shared/config');
const { Migrator } = require('./migrator');

async function main() {
  if (process.argv.includes('--dry-run')) {
    config.migration.dryRun = true;
  }

  const migrator = new Migrator();
  const summary = await migrator.run();

  // A non-zero exit code lets CI or a wrapper script notice partial failures.
  const problems = Object.values(summary.counts).reduce(
    (total, counts) => total + counts.rejected + counts.failed,
    0
  );
  process.exitCode = problems > 0 ? 1 : 0;
}

main().catch((error) => {
  logger.error('Migration aborted', {
    error: error.message,
    code: error.code,
    status: error.status,
    details: error.details,
    stack: error.stack,
  });
  process.exitCode = 1;
});
