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

describe('AirtableWebhookApi', () => {
  const { AirtableWebhookApi } = require('../src/integration/services/airtableWebhookApi');

  /** @param {object} body @param {number} [status] */
  function stubFetch(body, status = 200) {
    return jest.fn().mockResolvedValue({
      ok: status < 400,
      status,
      json: async () => body,
    });
  }

  let originalFetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  const api = () =>
    new AirtableWebhookApi({
      apiKey: 'pat-test',
      baseId: 'appTest',
      apiBaseUrl: 'https://airtable.test/v0',
      logger: silentLogger(),
    });

  it('builds URLs from the injected host, not a hardcoded one', async () => {
    global.fetch = stubFetch({ webhooks: [] });

    await api().list();

    expect(global.fetch.mock.calls[0][0]).toBe(
      'https://airtable.test/v0/bases/appTest/webhooks'
    );
  });

  it('authenticates with the personal access token', async () => {
    global.fetch = stubFetch({ webhooks: [] });

    await api().list();

    expect(global.fetch.mock.calls[0][1].headers.Authorization).toBe('Bearer pat-test');
  });

  it('registers a webhook watching table data adds and updates', async () => {
    global.fetch = stubFetch({ id: 'achX', macSecretBase64: 'c2VjcmV0' });

    const result = await api().create('https://example.test/airtable-webhook');

    const body = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(body.notificationUrl).toBe('https://example.test/airtable-webhook');
    expect(body.specification.options.filters).toEqual({
      dataTypes: ['tableData'],
      // Deletions are deliberately not watched — removing an Airtable row must
      // not destroy a CRM record.
      changeTypes: ['add', 'update'],
    });
    expect(result.macSecretBase64).toBe('c2VjcmV0');
  });

  it('refuses a non-https notification URL', async () => {
    global.fetch = stubFetch({});

    await expect(api().create('http://insecure.test/hook')).rejects.toThrow(/https/);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('surfaces an Airtable error message', async () => {
    global.fetch = stubFetch({ error: { message: 'INVALID_PERMISSIONS' } }, 403);

    await expect(api().list()).rejects.toThrow('INVALID_PERMISSIONS');
  });

  it('hits the refresh endpoint for the given webhook', async () => {
    global.fetch = stubFetch({ expirationTime: '2026-01-08T00:00:00.000Z' });

    await api().refresh('achX');

    expect(global.fetch.mock.calls[0][0]).toBe(
      'https://airtable.test/v0/bases/appTest/webhooks/achX/refresh'
    );
    expect(global.fetch.mock.calls[0][1].method).toBe('POST');
  });
});

describe('isBlankRecord', () => {
  const { isBlankRecord } = require('../src/integration/syncService');

  // Airtable seeds every new table with empty rows. They carry a
  // `last modified time` like any other record, so a rescan finds them —
  // but they are not failures, and counting them as such would make a real
  // failure count meaningless.
  it('treats a row with no user data as blank', () => {
    expect(isBlankRecord({})).toBe(true);
    expect(isBlankRecord({ last_modified: '2026-08-11T00:00:00.000Z' })).toBe(true);
    expect(isBlankRecord({ last_modified: 'x', hubspot_record_id: '' })).toBe(true);
  });

  it('treats a row with any user data as populated', () => {
    expect(isBlankRecord({ company_name: 'Acme' })).toBe(false);
    expect(isBlankRecord({ number_of_employees: 0 })).toBe(false);
    expect(isBlankRecord({ Company: ['recX'] })).toBe(false);
  });

  it('ignores empty strings and cleared link fields', () => {
    expect(isBlankRecord({ deal_name: '', Company: [] })).toBe(true);
  });

  it('does not treat a synced-but-empty row as populated', () => {
    // hubspot_record_id is our own write-back, not user data.
    expect(isBlankRecord({ hubspot_record_id: '12345' })).toBe(true);
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
