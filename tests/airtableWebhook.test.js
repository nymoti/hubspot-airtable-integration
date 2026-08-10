'use strict';

const request = require('supertest');
const { createHmac } = require('crypto');

const config = require('../src/shared/config');
const { createApp } = require('../src/integration/app');
const { RescanService } = require('../src/integration/rescanService');
const {
  verifyNotification,
  expectedSignature,
} = require('../src/integration/airtableWebhookAuth');
const { ValidationError } = require('../src/shared/errors');
const { silentLogger } = require('./helpers/mocks');

const MAC_SECRET = Buffer.from('a-test-mac-secret-value').toString('base64');

describe('Airtable notification signatures', () => {
  const body = JSON.stringify({ base: { id: 'appX' }, webhook: { id: 'achX' } });

  it('accepts a correctly signed notification', () => {
    const header = expectedSignature(body, MAC_SECRET);
    expect(verifyNotification({ rawBody: body, header, macSecret: MAC_SECRET })).toBe(true);
  });

  it('computes the digest Airtable documents', () => {
    // hmac-sha256=<hex>, keyed by the base64-decoded secret.
    const digest = createHmac('sha256', Buffer.from(MAC_SECRET, 'base64'))
      .update(body)
      .digest('hex');
    expect(expectedSignature(body, MAC_SECRET)).toBe(`hmac-sha256=${digest}`);
  });

  it('rejects a tampered body', () => {
    const header = expectedSignature(body, MAC_SECRET);
    const tampered = JSON.stringify({ base: { id: 'attacker' } });
    expect(verifyNotification({ rawBody: tampered, header, macSecret: MAC_SECRET })).toBe(
      false
    );
  });

  it('rejects a signature made with the wrong secret', () => {
    const header = expectedSignature(body, Buffer.from('wrong').toString('base64'));
    expect(verifyNotification({ rawBody: body, header, macSecret: MAC_SECRET })).toBe(false);
  });

  it('rejects when the header or secret is missing', () => {
    expect(verifyNotification({ rawBody: body, header: '', macSecret: MAC_SECRET })).toBe(
      false
    );
    // An unconfigured secret must fail closed, never open.
    expect(
      verifyNotification({ rawBody: body, header: 'hmac-sha256=abc', macSecret: '' })
    ).toBe(false);
  });
});

describe('POST /airtable-webhook', () => {
  const body = { base: { id: 'appX' }, webhook: { id: 'achX' }, timestamp: '2026-01-01' };
  const raw = JSON.stringify(body);
  let originalSecret;

  beforeEach(() => {
    originalSecret = config.airtable.webhook.macSecret;
    config.airtable.webhook.macSecret = MAC_SECRET;
  });

  afterEach(() => {
    config.airtable.webhook.macSecret = originalSecret;
  });

  const appWith = (rescanService) =>
    createApp({ syncService: { process: jest.fn() }, rescanService });

  it('runs a rescan when the signature is valid', async () => {
    const rescanService = {
      run: jest.fn().mockResolvedValue({ scanned: 3, synced: 3, failed: 0, results: [] }),
    };

    const response = await request(appWith(rescanService))
      .post('/airtable-webhook')
      .set('Content-Type', 'application/json')
      .set('X-Airtable-Content-MAC', expectedSignature(raw, MAC_SECRET))
      .send(raw);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ scanned: 3, synced: 3 });
    expect(rescanService.run).toHaveBeenCalledTimes(1);
  });

  it('rejects an unsigned notification without doing any work', async () => {
    const rescanService = { run: jest.fn() };

    const response = await request(appWith(rescanService))
      .post('/airtable-webhook')
      .set('Content-Type', 'application/json')
      .send(raw);

    expect(response.status).toBe(401);
    expect(rescanService.run).not.toHaveBeenCalled();
  });

  it('rejects a forged signature', async () => {
    const rescanService = { run: jest.fn() };

    const response = await request(appWith(rescanService))
      .post('/airtable-webhook')
      .set('Content-Type', 'application/json')
      .set('X-Airtable-Content-MAC', 'hmac-sha256=deadbeef')
      .send(raw);

    expect(response.status).toBe(401);
    expect(rescanService.run).not.toHaveBeenCalled();
  });

  it('omits per-record detail from the response', async () => {
    const rescanService = {
      run: jest.fn().mockResolvedValue({
        scanned: 1,
        synced: 1,
        results: [{ hubspotId: '1' }],
      }),
    };

    const response = await request(appWith(rescanService))
      .post('/airtable-webhook')
      .set('Content-Type', 'application/json')
      .set('X-Airtable-Content-MAC', expectedSignature(raw, MAC_SECRET))
      .send(raw);

    expect(response.body.results).toBeUndefined();
  });
});

describe('RescanService', () => {
  /** Airtable stub returning canned modified records per table. */
  function fakeAirtable(byTable) {
    return {
      listModifiedSince: jest.fn(async (tableName) => byTable[tableName] || []),
    };
  }

  it('syncs every modified record it finds', async () => {
    const airtable = fakeAirtable({
      Companies: [{ id: 'recCo1', fields: {} }],
      Deals: [{ id: 'recD1', fields: {} }],
    });
    const syncService = {
      process: jest.fn().mockResolvedValue({ status: 'synced' }),
      airtable,
    };

    const result = await new RescanService({ syncService, airtable }).run();

    expect(result.scanned).toBe(2);
    expect(result.synced).toBe(2);
    expect(result.failed).toBe(0);
  });

  // Parents must be synced before children so associations resolve in one pass.
  it('scans tables parents-first', async () => {
    const airtable = fakeAirtable({});
    const syncService = { process: jest.fn(), airtable };

    await new RescanService({ syncService, airtable }).run();

    const order = airtable.listModifiedSince.mock.calls.map(([table]) => table);
    expect(order).toEqual(['Companies', 'Contacts', 'Deals', 'Line Items']);
  });

  it('continues past a record that fails', async () => {
    const airtable = fakeAirtable({
      Companies: [
        { id: 'recGood1', fields: {} },
        { id: 'recBad', fields: {} },
        { id: 'recGood2', fields: {} },
      ],
    });
    const syncService = {
      airtable,
      process: jest.fn(async (body) => {
        if (body.recordId === 'recBad') throw new ValidationError('missing email');
        return { status: 'synced' };
      }),
    };

    const result = await new RescanService({ syncService, airtable }).run();

    // One bad row must not abandon the scan.
    expect(result.synced).toBe(2);
    expect(result.failed).toBe(1);
    expect(syncService.process).toHaveBeenCalledTimes(3);
  });

  it('honours an explicit since, for backfills', async () => {
    const airtable = fakeAirtable({});
    const syncService = { process: jest.fn(), airtable };
    const since = new Date('2026-01-01T00:00:00.000Z');

    await new RescanService({ syncService, airtable }).run({ since });

    expect(airtable.listModifiedSince.mock.calls[0][1]).toEqual(since);
  });

  it('defaults to the configured lookback window', async () => {
    const airtable = fakeAirtable({});
    const syncService = { process: jest.fn(), airtable };

    const before = Date.now();
    await new RescanService({ syncService, airtable }).run();

    const since = airtable.listModifiedSince.mock.calls[0][1];
    const windowMs = config.airtable.webhook.lookbackMinutes * 60_000;
    expect(since.getTime()).toBeGreaterThanOrEqual(before - windowMs - 1000);
    expect(since.getTime()).toBeLessThanOrEqual(before - windowMs + 1000);
  });

  it('counts skipped records separately from synced ones', async () => {
    const airtable = fakeAirtable({ Companies: [{ id: 'recGone', fields: {} }] });
    const syncService = {
      airtable,
      process: jest.fn().mockResolvedValue({ status: 'skipped', reason: 'record_not_found' }),
    };

    const result = await new RescanService({ syncService, airtable }).run();

    expect(result.synced).toBe(0);
    expect(result.skipped).toBe(1);
  });
});
