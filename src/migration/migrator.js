'use strict';

const HubSpotClient = require('../shared/hubspotClient');
const logger = require('../shared/logger');
const config = require('../shared/config');
const { chunk } = require('../shared/transforms');
const {
  OBJECT_TYPES,
  EXTERNAL_ID_PROPERTY,
  buildExternalId,
} = require('../shared/hubspotSchema');
const { readCsv } = require('./csvReader');
const { mapCompany, mapContact, mapDeal, SOURCE } = require('./mappers');
const { MigrationReport } = require('./report');

/**
 * Orchestrates the CSV → HubSpot migration.
 *
 * Ordering is dictated by the association graph: companies must exist before
 * contacts and deals can point at them, and all three must exist before the
 * associations can be written. Within each stage the work is batched (100 per
 * call, HubSpot's maximum) with a per-record fallback, because HubSpot's batch
 * create endpoint is all-or-nothing — without the fallback a single malformed
 * row fails the other 99 alongside it.
 *
 * The migration is idempotent. Every record carries `external_source_id`
 * (`csv:companies:12`), so a second run reads the existing records back by
 * that property and updates them in place instead of creating duplicates.
 */
class Migrator {
  /**
   * @param {object} [options]
   * @param {HubSpotClient} [options.hubspot]
   * @param {import('winston').Logger} [options.logger]
   * @param {MigrationReport} [options.report]
   */
  constructor(options = {}) {
    this.hubspot = options.hubspot || new HubSpotClient();
    this.log = options.logger || logger;
    this.report = options.report || new MigrationReport();
    this.batchSize = config.hubspot.batchSize;

    /**
     * Source id → HubSpot id, per object type. Built as each stage runs and
     * consumed by the association stage.
     * @type {{ companies: Map<string,string>, contacts: Map<string,string>, deals: Map<string,string> }}
     */
    this.idMap = {
      companies: new Map(),
      contacts: new Map(),
      deals: new Map(),
    };
  }

  /**
   * Runs the full migration.
   * @returns {Promise<object>} the report summary
   */
  async run() {
    const startedAt = Date.now();
    this.log.info('Migration started', {
      dataDir: config.migration.dataDir,
      dryRun: config.migration.dryRun,
      importOrphans: config.migration.importOrphans,
    });

    const companies = await readCsv('companies.csv', config.migration.dataDir);
    const contacts = await readCsv('contacts.csv', config.migration.dataDir);
    const deals = await readCsv('deals.csv', config.migration.dataDir);

    this.log.info('CSV files loaded', {
      companies: companies.length,
      contacts: contacts.length,
      deals: deals.length,
    });

    await this.migrateObjects(OBJECT_TYPES.COMPANIES, companies, mapCompany, {
      sourceIdField: 'company_id',
    });

    await this.migrateObjects(OBJECT_TYPES.CONTACTS, contacts, mapContact, {
      sourceIdField: 'contact_id',
      parent: { field: 'company_id', objectType: OBJECT_TYPES.COMPANIES },
    });

    await this.migrateObjects(OBJECT_TYPES.DEALS, deals, mapDeal, {
      sourceIdField: 'deal_id',
      parent: { field: 'company_id', objectType: OBJECT_TYPES.COMPANIES },
    });

    await this.associateAll(contacts, deals);

    const summary = this.report.finalise({
      durationMs: Date.now() - startedAt,
      totals: {
        companies: companies.length,
        contacts: contacts.length,
        deals: deals.length,
      },
    });

    this.log.info('Migration finished', summary);
    return summary;
  }

  /**
   * Maps, deduplicates and upserts one object type.
   *
   * @param {string} objectType
   * @param {Array<Record<string,string>>} rows
   * @param {(row: Record<string,string>) => { properties: object|null, warnings: string[], error: string|null }} mapper
   * @param {{ sourceIdField: string, parent?: { field: string, objectType: string } }} options
   */
  async migrateObjects(objectType, rows, mapper, options) {
    const { sourceIdField, parent } = options;
    this.log.info('Stage started', { objectType, rows: rows.length });

    /** @type {Array<{ sourceId: string, externalId: string, properties: object, row: object }>} */
    const candidates = [];

    for (const row of rows) {
      const sourceId = row[sourceIdField];

      if (!sourceId) {
        this.report.reject(objectType, row, `Missing ${sourceIdField}`);
        continue;
      }

      // A row whose parent company is absent from companies.csv is a
      // referential-integrity gap in the *source data*, not a bug here. The
      // record itself is still valid, so by default it is imported without the
      // association and flagged in the report — dropping it (the previous
      // behaviour) loses real data silently.
      if (parent && !this.idMap[parent.objectType].has(row[parent.field])) {
        const reason = `Referenced ${parent.field}="${row[parent.field]}" does not exist in companies.csv`;

        if (!config.migration.importOrphans) {
          this.report.reject(objectType, row, reason);
          continue;
        }
        this.report.warn(objectType, sourceId, `${reason}; imported without company association`);
      }

      const { properties, warnings, error } = mapper(row);

      for (const warning of warnings) {
        this.report.warn(objectType, sourceId, warning);
      }

      if (error) {
        this.report.reject(objectType, row, error);
        continue;
      }

      candidates.push({
        sourceId,
        externalId: buildExternalId(SOURCE, objectType, sourceId),
        properties,
        row,
      });
    }

    if (config.migration.dryRun) {
      // Record a placeholder id for every candidate. Later stages check parent
      // references against this map, so without it a dry run would report
      // every contact and deal as an orphan — 800 false warnings burying the
      // seven real ones. A dry run that cannot predict the real run is worse
      // than no dry run at all.
      for (const candidate of candidates) {
        this.idMap[objectType].set(candidate.sourceId, `dry-run:${candidate.externalId}`);
      }

      this.log.warn('Dry run — skipping writes', {
        objectType,
        wouldUpsert: candidates.length,
        rejected: this.report.counts[objectType].rejected,
      });
      return;
    }

    const existing = await this.findExisting(objectType, candidates);

    const toCreate = candidates.filter((c) => !existing.has(c.externalId));
    const toUpdate = candidates
      .filter((c) => existing.has(c.externalId))
      .map((c) => ({ ...c, hubspotId: existing.get(c.externalId) }));

    // Record the already-known ids first so associations work even if a later
    // create fails.
    for (const item of toUpdate) {
      this.idMap[objectType].set(item.sourceId, item.hubspotId);
    }

    await this.createInBatches(objectType, toCreate);
    await this.updateInBatches(objectType, toUpdate);

    this.log.info('Stage finished', {
      objectType,
      created: this.report.counts[objectType].created,
      updated: this.report.counts[objectType].updated,
      rejected: this.report.counts[objectType].rejected,
      failed: this.report.counts[objectType].failed,
    });
  }

  /**
   * Looks up which candidates already exist in HubSpot, keyed by external id.
   *
   * `batch/read` with `idProperty` resolves 100 records per request, versus
   * one search request per record in the original implementation — roughly
   * 1,100 API calls saved on this dataset.
   *
   * @param {string} objectType
   * @param {Array<{ externalId: string }>} candidates
   * @returns {Promise<Map<string, string>>} external id → HubSpot id
   */
  async findExisting(objectType, candidates) {
    const found = new Map();

    for (const batch of chunk(candidates, this.batchSize)) {
      const results = await this.hubspot.batchRead(
        objectType,
        batch.map((c) => c.externalId),
        EXTERNAL_ID_PROPERTY,
        [EXTERNAL_ID_PROPERTY]
      );

      for (const result of results) {
        const externalId = result.properties?.[EXTERNAL_ID_PROPERTY];
        if (externalId) found.set(externalId, result.id);
      }
    }

    this.log.info('Existing records resolved', {
      objectType,
      candidates: candidates.length,
      alreadyInHubSpot: found.size,
    });

    return found;
  }

  /**
   * @param {string} objectType
   * @param {Array<{ sourceId: string, externalId: string, properties: object, row: object }>} items
   */
  async createInBatches(objectType, items) {
    for (const batch of chunk(items, this.batchSize)) {
      try {
        const response = await this.hubspot.batchCreate(
          objectType,
          batch.map((item) => ({ properties: item.properties }))
        );
        this.recordCreated(objectType, batch, response?.results ?? []);
      } catch (error) {
        // The batch endpoint rejects the whole request if any one record is
        // invalid, and does not say which. Fall back to individual creates so
        // the valid records still land and the invalid one is named precisely.
        this.log.warn('Batch create rejected, retrying records individually', {
          objectType,
          batchSize: batch.length,
          status: error.status,
          reason: error.message,
        });
        await this.createIndividually(objectType, batch);
      }
    }
  }

  /**
   * @param {string} objectType
   * @param {Array<{ sourceId: string, externalId: string, properties: object, row: object }>} batch
   * @param {Array<{ id: string, properties: Record<string,string> }>} results
   */
  recordCreated(objectType, batch, results) {
    const bySourceId = new Map(batch.map((item) => [item.externalId, item]));

    for (const result of results) {
      // Match on the external id we just wrote, never on a display name. The
      // deals export contains 32 duplicate `deal_name` values, so the previous
      // name-based matching mapped several records onto the wrong HubSpot id.
      const externalId = result.properties?.[EXTERNAL_ID_PROPERTY];
      const item = bySourceId.get(externalId);

      if (!item) {
        this.log.warn('Created record could not be matched back to a source row', {
          objectType,
          hubspotId: result.id,
          externalId,
        });
        continue;
      }

      this.idMap[objectType].set(item.sourceId, result.id);
      this.report.created(objectType);
    }
  }

  /**
   * @param {string} objectType
   * @param {Array<{ sourceId: string, properties: object, row: object }>} items
   */
  async createIndividually(objectType, items) {
    for (const item of items) {
      try {
        const created = await this.hubspot.createObject(
          objectType,
          item.properties,
          { objectType, sourceId: item.sourceId }
        );
        this.idMap[objectType].set(item.sourceId, created.id);
        this.report.created(objectType);
      } catch (error) {
        this.report.fail(objectType, item.row, error);
        this.log.error('Record could not be created', {
          objectType,
          sourceId: item.sourceId,
          status: error.status,
          details: error.details,
          properties: item.properties,
          error: error.message,
        });
      }
    }
  }

  /**
   * @param {string} objectType
   * @param {Array<{ sourceId: string, hubspotId: string, properties: object, row: object }>} items
   */
  async updateInBatches(objectType, items) {
    for (const batch of chunk(items, this.batchSize)) {
      try {
        await this.hubspot.batchUpdate(
          objectType,
          batch.map((item) => ({
            id: item.hubspotId,
            properties: item.properties,
          }))
        );
        batch.forEach(() => this.report.updated(objectType));
      } catch (error) {
        this.log.warn('Batch update rejected, retrying records individually', {
          objectType,
          batchSize: batch.length,
          reason: error.message,
        });

        for (const item of batch) {
          try {
            await this.hubspot.updateObject(
              objectType,
              item.hubspotId,
              item.properties,
              { objectType, sourceId: item.sourceId }
            );
            this.report.updated(objectType);
          } catch (individualError) {
            this.report.fail(objectType, item.row, individualError);
            this.log.error('Record could not be updated', {
              objectType,
              sourceId: item.sourceId,
              hubspotId: item.hubspotId,
              status: individualError.status,
              details: individualError.details,
              error: individualError.message,
            });
          }
        }
      }
    }
  }

  // -------------------------------------------------------------------
  // Associations
  // -------------------------------------------------------------------

  /**
   * Writes all three association types required by the brief.
   *
   * @param {Array<Record<string,string>>} contactRows
   * @param {Array<Record<string,string>>} dealRows
   */
  async associateAll(contactRows, dealRows) {
    await this.associate(
      'Contact → Company',
      OBJECT_TYPES.CONTACTS,
      OBJECT_TYPES.COMPANIES,
      this.buildPairs(contactRows, 'contact_id', 'contacts', 'company_id', 'companies')
    );

    await this.associate(
      'Deal → Company',
      OBJECT_TYPES.DEALS,
      OBJECT_TYPES.COMPANIES,
      this.buildPairs(dealRows, 'deal_id', 'deals', 'company_id', 'companies')
    );

    await this.associate(
      'Deal → Contact',
      OBJECT_TYPES.DEALS,
      OBJECT_TYPES.CONTACTS,
      this.buildPairs(dealRows, 'deal_id', 'deals', 'contact_id', 'contacts')
    );
  }

  /**
   * Resolves source-id pairs into HubSpot-id pairs, skipping (and recording)
   * any pair where either side failed to migrate.
   *
   * @returns {Array<{ from: { id: string }, to: { id: string } }>}
   */
  buildPairs(rows, fromField, fromType, toField, toType) {
    const pairs = [];

    for (const row of rows) {
      const fromId = this.idMap[fromType].get(row[fromField]);
      const toId = this.idMap[toType].get(row[toField]);

      if (!row[toField]) continue; // no reference in the source data at all

      if (!fromId || !toId) {
        this.report.unassociated(`${fromType}->${toType}`, {
          [fromField]: row[fromField],
          [toField]: row[toField],
          reason: !fromId
            ? `${fromType} record was not migrated`
            : `${toType} record ${row[toField]} was not migrated`,
        });
        continue;
      }

      pairs.push({ from: { id: fromId }, to: { id: toId } });
    }

    return pairs;
  }

  /**
   * @param {string} label
   * @param {string} fromType
   * @param {string} toType
   * @param {Array<{ from: { id: string }, to: { id: string } }>} pairs
   */
  async associate(label, fromType, toType, pairs) {
    this.log.info('Association stage started', { label, pairs: pairs.length });

    // Pair resolution has already run, so a dry run can report exactly how many
    // associations would be written and which references are dangling — the
    // most useful thing it produces — without issuing a single API call.
    if (config.migration.dryRun) {
      this.report.associated(label, pairs.length);
      this.log.warn('Dry run — skipping association writes', {
        label,
        wouldAssociate: pairs.length,
      });
      return;
    }

    let succeeded = 0;

    for (const batch of chunk(pairs, this.batchSize)) {
      try {
        await this.hubspot.batchAssociate(fromType, toType, batch);
        succeeded += batch.length;
      } catch (error) {
        this.log.warn('Association batch failed, retrying individually', {
          label,
          batchSize: batch.length,
          reason: error.message,
        });

        for (const pair of batch) {
          try {
            await this.hubspot.associate(
              fromType,
              pair.from.id,
              toType,
              pair.to.id
            );
            succeeded += 1;
          } catch (individualError) {
            this.report.unassociated(label, {
              fromId: pair.from.id,
              toId: pair.to.id,
              reason: individualError.message,
            });
          }
        }
      }
    }

    this.report.associated(label, succeeded);
    this.log.info('Association stage finished', {
      label,
      succeeded,
      attempted: pairs.length,
    });
  }
}

module.exports = { Migrator };
