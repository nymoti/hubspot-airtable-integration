'use strict';

const { HubSpotService } = require('../src/integration/services/hubspotService');
const { EXTERNAL_ID_PROPERTY } = require('../src/shared/hubspotSchema');
const { OBJECT_TYPES } = require('../src/shared/hubspotSchema');
const { FakeHubSpotClient, silentLogger } = require('./helpers/mocks');

/**
 * The create-vs-update decision, exercised through every path that can lead to
 * a duplicate. These are the cases the brief's "safe to receive the same event
 * more than once" requirement actually turns on.
 */
describe('HubSpotService.upsert idempotency', () => {
  let client;
  let service;

  beforeEach(() => {
    client = new FakeHubSpotClient();
    service = new HubSpotService({ client, logger: silentLogger() });
  });

  const upsertCompany = (overrides = {}) =>
    service.upsert({
      objectType: OBJECT_TYPES.COMPANIES,
      airtableRecordId: 'recCompany1',
      properties: { name: 'Acme Corp', domain: 'acme.com' },
      naturalKey: { property: 'domain', value: 'acme.com' },
      ...overrides,
    });

  it('creates the record the first time it is seen', async () => {
    const result = await upsertCompany();

    expect(result.action).toBe('created');
    expect(client.all(OBJECT_TYPES.COMPANIES)).toHaveLength(1);
  });

  it('stamps the external id so the record can be found again', async () => {
    const result = await upsertCompany();
    const stored = await client.getObject(OBJECT_TYPES.COMPANIES, result.id);

    expect(stored.properties[EXTERNAL_ID_PROPERTY]).toBe(
      'airtable:companies:recCompany1'
    );
  });

  it('updates instead of creating when Airtable already holds the HubSpot id', async () => {
    const first = await upsertCompany();
    const second = await upsertCompany({ knownId: first.id });

    expect(second.action).toBe('updated');
    expect(second.matchedBy).toBe('hubspot_record_id');
    expect(client.all(OBJECT_TYPES.COMPANIES)).toHaveLength(1);
  });

  // The critical replay case: the record was created in HubSpot but the
  // write-back to Airtable had not landed when the event was redelivered, so
  // `hubspot_record_id` is still empty. Without the external-id tier this
  // produces a duplicate — which is exactly what the original implementation
  // did.
  it('does not duplicate when an event is replayed before the write-back lands', async () => {
    await upsertCompany();
    const replay = await upsertCompany({ knownId: undefined });

    expect(replay.action).toBe('updated');
    expect(replay.matchedBy).toBe('external_source_id');
    expect(client.all(OBJECT_TYPES.COMPANIES)).toHaveLength(1);
  });

  it('survives ten identical deliveries with a single record', async () => {
    for (let i = 0; i < 10; i += 1) await upsertCompany();

    expect(client.all(OBJECT_TYPES.COMPANIES)).toHaveLength(1);
    expect(client.calls.create).toBe(1);
  });

  it('adopts a pre-existing record found by its natural key', async () => {
    // Simulates a company created by the Part 1 migration, or by hand in the
    // HubSpot UI, that Airtable knows nothing about yet.
    const preExisting = await client.createObject(OBJECT_TYPES.COMPANIES, {
      name: 'Acme Corp',
      domain: 'acme.com',
    });

    const result = await upsertCompany();

    expect(result.action).toBe('updated');
    expect(result.matchedBy).toBe('natural_key');
    expect(result.id).toBe(preExisting.id);
    expect(client.all(OBJECT_TYPES.COMPANIES)).toHaveLength(1);
  });

  it('back-fills the external id onto an adopted record', async () => {
    await client.createObject(OBJECT_TYPES.COMPANIES, {
      name: 'Acme Corp',
      domain: 'acme.com',
    });
    const result = await upsertCompany();

    // The next event must resolve via tier 2 without needing another search
    // against the natural key.
    const stored = await client.getObject(OBJECT_TYPES.COMPANIES, result.id);
    expect(stored.properties[EXTERNAL_ID_PROPERTY]).toBe(
      'airtable:companies:recCompany1'
    );
  });

  it('recreates the record when the stored HubSpot id points at a deleted record', async () => {
    // A stale id must not wedge the sync permanently.
    const result = await upsertCompany({
      knownId: '999999',
      naturalKey: { property: 'domain', value: 'nowhere.com' },
      properties: { name: 'Ghost Ltd', domain: 'nowhere.com' },
    });

    expect(result.action).toBe('created');
    expect(client.all(OBJECT_TYPES.COMPANIES)).toHaveLength(1);
  });

  it('keeps records for different Airtable rows separate', async () => {
    await upsertCompany();
    await service.upsert({
      objectType: OBJECT_TYPES.COMPANIES,
      airtableRecordId: 'recCompany2',
      properties: { name: 'Globex', domain: 'globex.com' },
      naturalKey: { property: 'domain', value: 'globex.com' },
    });

    expect(client.all(OBJECT_TYPES.COMPANIES)).toHaveLength(2);
  });

  it('namespaces external ids by object type', async () => {
    // Company row `rec1` and deal row `rec1` must not collide.
    const company = await service.upsert({
      objectType: OBJECT_TYPES.COMPANIES,
      airtableRecordId: 'rec1',
      properties: { name: 'Acme' },
    });
    const deal = await service.upsert({
      objectType: OBJECT_TYPES.DEALS,
      airtableRecordId: 'rec1',
      properties: { dealname: 'Acme Renewal' },
    });

    const storedCompany = await client.getObject(OBJECT_TYPES.COMPANIES, company.id);
    const storedDeal = await client.getObject(OBJECT_TYPES.DEALS, deal.id);

    expect(storedCompany.properties[EXTERNAL_ID_PROPERTY]).toBe('airtable:companies:rec1');
    expect(storedDeal.properties[EXTERNAL_ID_PROPERTY]).toBe('airtable:deals:rec1');
  });

  it('does not consult the natural key once the stored id resolves', async () => {
    const first = await upsertCompany();
    const searchesAfterCreate = client.calls.search;

    await upsertCompany({ knownId: first.id });

    // Tier 1 short-circuits, so no search request is issued at all.
    expect(client.calls.search).toBe(searchesAfterCreate);
  });
});

describe('association idempotency', () => {
  it('re-asserting an association does not create a second one', async () => {
    const client = new FakeHubSpotClient();
    const service = new HubSpotService({ client, logger: silentLogger() });

    await service.associate(OBJECT_TYPES.CONTACTS, '1', OBJECT_TYPES.COMPANIES, '2');
    await service.associate(OBJECT_TYPES.CONTACTS, '1', OBJECT_TYPES.COMPANIES, '2');

    expect(client.associations.size).toBe(1);
    expect(
      client.hasAssociation(OBJECT_TYPES.CONTACTS, '1', OBJECT_TYPES.COMPANIES, '2')
    ).toBe(true);
  });
});
