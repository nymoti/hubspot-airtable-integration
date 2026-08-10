'use strict';

const fs = require('fs');
const path = require('path');
const config = require('../shared/config');
const logger = require('../shared/logger');
const { OBJECT_TYPES } = require('../shared/hubspotSchema');

/**
 * Collects the outcome of every row so the run can be audited afterwards.
 *
 * The first version of this migration reported only aggregate counts, which is
 * why "395 of 400 contacts" sat unexplained: the identity of the missing rows,
 * and the reason each was missing, had already been thrown away. The report
 * keeps both, and writes them to `logs/migration-report.json` alongside a
 * `logs/migration-failures.csv` that can be corrected and re-fed to the
 * migration (which is idempotent, so re-running is safe).
 */
class MigrationReport {
  constructor(options = {}) {
    this.log = options.logger || logger;
    this.outputDir = options.outputDir || config.logging.directory;
    this.startedAt = new Date().toISOString();

    /** Per-object-type tallies. */
    this.counts = {};
    for (const objectType of Object.values(OBJECT_TYPES)) {
      this.counts[objectType] = {
        created: 0,
        updated: 0,
        rejected: 0,
        failed: 0,
      };
    }

    /** Rows rejected before any API call (bad or missing data). */
    this.rejections = [];
    /** Rows HubSpot refused to accept. */
    this.failures = [];
    /** Non-fatal data-quality notes. */
    this.warnings = [];
    /** Associations that could not be written. */
    this.missingAssociations = [];
    /** Successful association counts by label. */
    this.associationCounts = {};
  }

  /** @param {string} objectType */
  created(objectType) {
    this.counts[objectType].created += 1;
  }

  /** @param {string} objectType */
  updated(objectType) {
    this.counts[objectType].updated += 1;
  }

  /**
   * A row that never reached HubSpot because the source data was unusable.
   * @param {string} objectType
   * @param {Record<string, string>} row
   * @param {string} reason
   */
  reject(objectType, row, reason) {
    this.counts[objectType].rejected += 1;
    this.rejections.push({ objectType, reason, row });
    this.log.warn('Row rejected before import', { objectType, reason, row });
  }

  /**
   * A row HubSpot refused.
   * @param {string} objectType
   * @param {Record<string, string>} row
   * @param {Error & { status?: number, details?: unknown }} error
   */
  fail(objectType, row, error) {
    this.counts[objectType].failed += 1;
    this.failures.push({
      objectType,
      reason: error.message,
      status: error.status,
      details: error.details,
      row,
    });
  }

  /**
   * @param {string} objectType
   * @param {string} sourceId
   * @param {string} message
   */
  warn(objectType, sourceId, message) {
    this.warnings.push({ objectType, sourceId, message });
  }

  /**
   * @param {string} label
   * @param {Record<string, unknown>} detail
   */
  unassociated(label, detail) {
    this.missingAssociations.push({ label, ...detail });
  }

  /**
   * @param {string} label
   * @param {number} count
   */
  associated(label, count) {
    this.associationCounts[label] = count;
  }

  /**
   * Writes the report to disk and returns the summary.
   *
   * @param {{ durationMs: number, totals: Record<string, number> }} meta
   * @returns {object}
   */
  finalise(meta) {
    const summary = {
      startedAt: this.startedAt,
      finishedAt: new Date().toISOString(),
      durationMs: meta.durationMs,
      sourceRowCounts: meta.totals,
      counts: this.counts,
      associations: this.associationCounts,
      rejected: this.rejections.length,
      failed: this.failures.length,
      warnings: this.warnings.length,
      missingAssociations: this.missingAssociations.length,
    };

    const report = {
      summary,
      rejections: this.rejections,
      failures: this.failures,
      warnings: this.warnings,
      missingAssociations: this.missingAssociations,
    };

    try {
      fs.mkdirSync(this.outputDir, { recursive: true });

      const reportPath = path.join(this.outputDir, 'migration-report.json');
      fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

      const problemRows = [...this.rejections, ...this.failures];
      if (problemRows.length > 0) {
        const csvPath = path.join(this.outputDir, 'migration-failures.csv');
        fs.writeFileSync(csvPath, this.toCsv(problemRows));
        this.log.warn('Some rows did not import', {
          count: problemRows.length,
          reportPath,
          csvPath,
        });
      }

      this.log.info('Report written', { reportPath });
    } catch (error) {
      // A failure to write the report must not mask the migration's own result.
      this.log.error('Could not write migration report', {
        error: error.message,
        outputDir: this.outputDir,
      });
    }

    return summary;
  }

  /**
   * Renders rejected/failed rows as CSV, preserving the original columns so
   * the file can be corrected and re-imported directly.
   *
   * @param {Array<{ objectType: string, reason: string, row: Record<string,string> }>} entries
   * @returns {string}
   */
  toCsv(entries) {
    const columns = new Set(['object_type', 'failure_reason']);
    for (const entry of entries) {
      Object.keys(entry.row || {}).forEach((key) => columns.add(key));
    }

    const header = [...columns];
    const escape = (value) => {
      const text = value === undefined || value === null ? '' : String(value);
      return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    };

    const lines = entries.map((entry) =>
      header
        .map((column) => {
          if (column === 'object_type') return escape(entry.objectType);
          if (column === 'failure_reason') return escape(entry.reason);
          return escape(entry.row?.[column]);
        })
        .join(',')
    );

    return [header.join(','), ...lines].join('\n');
  }
}

module.exports = { MigrationReport };
