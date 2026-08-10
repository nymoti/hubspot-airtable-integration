'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');

const config = require('../src/shared/config');
const { Migrator } = require('../src/migration/migrator');
const { MigrationReport } = require('../src/migration/report');
const { EXTERNAL_ID_PROPERTY, OBJECT_TYPES } = require('../src/shared/hubspotSchema');
const { HubSpotApiError } = require('../src/shared/errors');
const { silentLogger } = require('./helpers/mocks');

/**
 * Migration orchestration, driven from real CSV fixtures written to a temp
 * directory. HubSpot is a stub that records what it was asked to do.
 */

let tempDir;
let originalDataDir;

const COMPANIES_CSV = `company_id,company_name,domain,industry,number_of_employees
1,Hooli Corp,hoolicorp.com,Robotics,2011
2,Summit Technologies,summittechnologies.com,Biotech,3684
`;

// Contact 3 references company 307, which does not exist — the exact shape of
// the referential gap that silently dropped five contacts in the first run.
const CONTACTS_CSV = `contact_id,first_name,last_name,email,phone,company_id,lifecycle_stage
1,Hope,Beer,hope.beer@duffworks.com,5550422,1,subscriber
2,Rhodey,Rhodes,rhodey.rhodes@anchorcorp.com,555.0611,2,opportunity
3,Wong,Leeds,wong.leeds@fusionsolutions.com,555-0699,307,subscriber
4,No,Email,,555-0000,1,lead
`;

// Deal 2 carries an MM-DD-YYYY close date; deals 3 and 4 share a name, which
// broke the original name-based result matching.
const DEALS_CSV = `deal_id,deal_name,amount,deal_stage,close_date,company_id,contact_id
1,Meridian Dynamics Renewal,"$48,469",closedlost,2022-06-05,1,1
2,Summit Holdings Renewal,15898.88,appointmentscheduled,09-17-2021,2,2
3,Duplicate Name Deal,1000,closedwon,2023-01-01,1,1
4,Duplicate Name Deal,2000,closedwon,2023-02-01,2,2
`;

/** Minimal HubSpot stub: assigns ids and echoes properties back. */
class StubHubSpot {
  constructor(options = {}) {
    this.created = { companies: [], contacts: [], deals: [], line_items: [] };
    this.updated = [];
    this.associations = [];
    this.existing = options.existing || new Map();
    this.rejectExternalIds = options.rejectExternalIds || new Set();
    this.nextId = 100;
  }

  async batchRead(objectType, ids) {
    return ids
      .filter((id) => this.existing.has(id))
      .map((id) => ({
        id: this.existing.get(id),
        properties: { [EXTERNAL_ID_PROPERTY]: id },
      }));
  }

  async batchCreate(objectType, inputs) {
    const rejected = inputs.find((input) =>
      this.rejectExternalIds.has(input.properties[EXTERNAL_ID_PROPERTY])
    );
    if (rejected) {
      // HubSpot's batch endpoint is all-or-nothing and does not identify the
      // offending record.
      throw new HubSpotApiError('Invalid input in batch', { status: 400 });
    }

    const results = inputs.map((input) => {
      const id = String(this.nextId++);
      this.created[objectType].push({ id, properties: input.properties });
      return { id, properties: input.properties };
    });
    return { results };
  }

  async createObject(objectType, properties) {
    if (this.rejectExternalIds.has(properties[EXTERNAL_ID_PROPERTY])) {
      throw new HubSpotApiError('PROPERTY_DOESNT_EXIST', { status: 400 });
    }
    const id = String(this.nextId++);
    this.created[objectType].push({ id, properties });
    return { id, properties };
  }

  async batchUpdate(objectType, inputs) {
    inputs.forEach((input) => this.updated.push({ objectType, ...input }));
    return { results: inputs };
  }

  async updateObject(objectType, id, properties) {
    this.updated.push({ objectType, id, properties });
    return { id, properties };
  }

  async batchAssociate(fromType, toType, inputs) {
    inputs.forEach((pair) =>
      this.associations.push({ fromType, toType, from: pair.from.id, to: pair.to.id })
    );
    return {};
  }

  async associate(fromType, fromId, toType, toId) {
    this.associations.push({ fromType, toType, from: fromId, to: toId });
  }
}

function buildMigrator(hubspot) {
  return new Migrator({
    hubspot,
    logger: silentLogger(),
    report: new MigrationReport({
      logger: silentLogger(),
      outputDir: path.join(tempDir, 'logs'),
    }),
  });
}

beforeAll(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-test-'));
  fs.writeFileSync(path.join(tempDir, 'companies.csv'), COMPANIES_CSV);
  fs.writeFileSync(path.join(tempDir, 'contacts.csv'), CONTACTS_CSV);
  fs.writeFileSync(path.join(tempDir, 'deals.csv'), DEALS_CSV);

  originalDataDir = config.migration.dataDir;
  config.migration.dataDir = tempDir;
});

afterAll(() => {
  config.migration.dataDir = originalDataDir;
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('Migrator', () => {
  it('imports every object type', async () => {
    const hubspot = new StubHubSpot();
    const summary = await buildMigrator(hubspot).run();

    expect(summary.counts.companies.created).toBe(2);
    expect(summary.counts.deals.created).toBe(4);
  });

  // Previously these rows were dropped without trace because their company
  // was missing from companies.csv.
  it('imports a contact whose company is missing from the source data', async () => {
    const hubspot = new StubHubSpot();
    await buildMigrator(hubspot).run();

    const emails = hubspot.created.contacts.map((c) => c.properties.email);
    expect(emails).toContain('wong.leeds@fusionsolutions.com');
  });

  it('rejects a contact with no email and records the reason', async () => {
    const hubspot = new StubHubSpot();
    const migrator = buildMigrator(hubspot);
    await migrator.run();

    expect(migrator.report.counts.contacts.rejected).toBe(1);
    expect(migrator.report.rejections[0].reason).toMatch(/email/i);
  });

  it('parses the MM-DD-YYYY close date that HubSpot previously rejected', async () => {
    const hubspot = new StubHubSpot();
    await buildMigrator(hubspot).run();

    const deal = hubspot.created.deals.find(
      (d) => d.properties.dealname === 'Summit Holdings Renewal'
    );
    expect(deal.properties.closedate).toBe('2021-09-17');
  });

  // The original code matched batch results back to source rows by name, so
  // two deals sharing a name were mapped to the same HubSpot id.
  it('maps deals with identical names to distinct HubSpot ids', async () => {
    const hubspot = new StubHubSpot();
    const migrator = buildMigrator(hubspot);
    await migrator.run();

    const third = migrator.idMap.deals.get('3');
    const fourth = migrator.idMap.deals.get('4');

    expect(third).toBeDefined();
    expect(fourth).toBeDefined();
    expect(third).not.toBe(fourth);
  });

  it('writes all three association types', async () => {
    const hubspot = new StubHubSpot();
    await buildMigrator(hubspot).run();

    const pairs = new Set(
      hubspot.associations.map((a) => `${a.fromType}->${a.toType}`)
    );
    expect(pairs).toEqual(
      new Set(['contacts->companies', 'deals->companies', 'deals->contacts'])
    );
  });

  it('skips associations whose target was never migrated, and records them', async () => {
    const hubspot = new StubHubSpot();
    const migrator = buildMigrator(hubspot);
    await migrator.run();

    // Contact 3's company (307) does not exist, so no association is possible.
    const orphan = migrator.report.missingAssociations.find((entry) =>
      Object.values(entry).includes('307')
    );
    expect(orphan).toBeDefined();
  });

  it('falls back to individual creates when a batch is rejected', async () => {
    // One bad row must not take the rest of the batch down with it.
    const hubspot = new StubHubSpot({
      rejectExternalIds: new Set(['csv:companies:2']),
    });
    const migrator = buildMigrator(hubspot);
    await migrator.run();

    expect(migrator.report.counts.companies.created).toBe(1);
    expect(migrator.report.counts.companies.failed).toBe(1);
    expect(hubspot.created.companies[0].properties.name).toBe('Hooli Corp');
  });

  it('updates rather than duplicates on a second run', async () => {
    // Simulates every company already existing from a previous run.
    const hubspot = new StubHubSpot({
      existing: new Map([
        ['csv:companies:1', '9001'],
        ['csv:companies:2', '9002'],
      ]),
    });
    const migrator = buildMigrator(hubspot);
    await migrator.run();

    expect(migrator.report.counts.companies.created).toBe(0);
    expect(migrator.report.counts.companies.updated).toBe(2);
    expect(hubspot.created.companies).toHaveLength(0);
  });

  it('stamps every record with a namespaced external id', async () => {
    const hubspot = new StubHubSpot();
    await buildMigrator(hubspot).run();

    expect(hubspot.created.companies[0].properties[EXTERNAL_ID_PROPERTY]).toBe(
      'csv:companies:1'
    );
    expect(hubspot.created.deals[0].properties[EXTERNAL_ID_PROPERTY]).toBe(
      'csv:deals:1'
    );
  });

  it('writes a report naming every problem row', async () => {
    const hubspot = new StubHubSpot();
    const migrator = buildMigrator(hubspot);
    await migrator.run();

    const reportPath = path.join(tempDir, 'logs', 'migration-report.json');
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));

    expect(report.summary.counts[OBJECT_TYPES.CONTACTS].rejected).toBe(1);
    expect(report.rejections[0].row.contact_id).toBe('4');
  });
});
