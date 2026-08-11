'use strict';

const request = require('supertest');
const { createApp, queryParam } = require('../src/integration/app');
const { normaliseEvent, ENTITIES } = require('../src/integration/normaliseEvent');
const { ValidationError } = require('../src/shared/errors');

describe('normaliseEvent', () => {
  it('accepts the canonical payload shape', () => {
    const event = normaliseEvent({
      table: 'Companies',
      recordId: 'recA',
      fields: { company_name: 'Acme' },
    });

    expect(event).toMatchObject({
      entity: ENTITIES.COMPANY,
      table: 'Companies',
      recordId: 'recA',
    });
  });

  it('accepts the nested record shape', () => {
    const event = normaliseEvent({
      table_name: 'Line Items',
      record: { id: 'recB', fields: { product_name: 'Widget' } },
    });

    expect(event.entity).toBe(ENTITIES.LINE_ITEM);
    expect(event.recordId).toBe('recB');
  });

  it.each([
    ['Companies', ENTITIES.COMPANY],
    ['contacts', ENTITIES.CONTACT],
    ['Deal', ENTITIES.DEAL],
    ['line_items', ENTITIES.LINE_ITEM],
    ['Line Items', ENTITIES.LINE_ITEM],
  ])('resolves table name %s', (table, expected) => {
    expect(normaliseEvent({ table, recordId: 'rec1' }).entity).toBe(expected);
  });

  it('rejects an unknown table', () => {
    expect(() => normaliseEvent({ table: 'Invoices', recordId: 'rec1' })).toThrow(
      ValidationError
    );
  });

  it('rejects a payload with no record id', () => {
    expect(() => normaliseEvent({ table: 'Companies' })).toThrow(ValidationError);
  });

  it('rejects a non-object body', () => {
    expect(() => normaliseEvent('not json')).toThrow(ValidationError);
  });
});

describe('POST /webhook', () => {
  const secret = process.env.WEBHOOK_SECRET;

  /** @param {object} syncService */
  const appWith = (syncService) => createApp({ syncService });

  it('returns 200 and the sync result on success', async () => {
    const syncService = {
      process: jest.fn().mockResolvedValue({ status: 'synced', hubspotId: '1' }),
    };

    const response = await request(appWith(syncService))
      .post('/webhook')
      .set('X-Webhook-Secret', secret)
      .send({ table: 'Companies', recordId: 'recA' });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ status: 'synced', hubspotId: '1' });
    expect(syncService.process).toHaveBeenCalledTimes(1);
  });

  it('rejects a request with the wrong shared secret', async () => {
    const syncService = { process: jest.fn() };

    const response = await request(appWith(syncService))
      .post('/webhook')
      .set('X-Webhook-Secret', 'wrong')
      .send({ table: 'Companies', recordId: 'recA' });

    expect(response.status).toBe(401);
    expect(syncService.process).not.toHaveBeenCalled();
  });

  it('rejects a request with no secret at all', async () => {
    const response = await request(appWith({ process: jest.fn() }))
      .post('/webhook')
      .send({ table: 'Companies', recordId: 'recA' });

    expect(response.status).toBe(401);
  });

  // The status code is a retry instruction, so a permanent failure must not
  // invite redelivery.
  it('answers 400 and retryable:false for an invalid payload', async () => {
    const syncService = {
      process: jest.fn().mockRejectedValue(new ValidationError('bad payload')),
    };

    const response = await request(appWith(syncService))
      .post('/webhook')
      .set('X-Webhook-Secret', secret)
      .send({ table: 'Nope' });

    expect(response.status).toBe(400);
    expect(response.body.retryable).toBe(false);
  });

  it('answers 429 when HubSpot rate-limits us, so the event is redelivered', async () => {
    const rateLimited = Object.assign(new Error('rate limited'), {
      status: 429,
      retryable: true,
      code: 'HUBSPOT_API_ERROR',
    });
    const syncService = { process: jest.fn().mockRejectedValue(rateLimited) };

    const response = await request(appWith(syncService))
      .post('/webhook')
      .set('X-Webhook-Secret', secret)
      .send({ table: 'Companies', recordId: 'recA' });

    expect(response.status).toBe(429);
    expect(response.body.retryable).toBe(true);
  });

  it('answers 503 for a transient HubSpot outage', async () => {
    const outage = Object.assign(new Error('service unavailable'), {
      status: 502,
      retryable: true,
    });
    const syncService = { process: jest.fn().mockRejectedValue(outage) };

    const response = await request(appWith(syncService))
      .post('/webhook')
      .set('X-Webhook-Secret', secret)
      .send({ table: 'Companies', recordId: 'recA' });

    expect(response.status).toBe(503);
  });

  it('echoes a correlation id so a failed sync can be traced in the logs', async () => {
    const syncService = { process: jest.fn().mockResolvedValue({ status: 'synced' }) };

    const response = await request(appWith(syncService))
      .post('/webhook')
      .set('X-Webhook-Secret', secret)
      .set('X-Correlation-Id', 'trace-123')
      .send({ table: 'Companies', recordId: 'recA' });

    expect(response.headers['x-correlation-id']).toBe('trace-123');
  });
});

describe('queryParam', () => {
  it('reads from req.query when Express populated it', () => {
    expect(queryParam({ query: { minutes: '60' } }, 'minutes')).toBe('60');
  });

  // Under the GCP Functions Framework the app runs as a handler on the
  // framework's own request object, and `req.query` is undefined. Reading it
  // directly threw "Cannot read properties of undefined" on every /rescan call
  // in production while working fine locally.
  it('falls back to parsing the URL when req.query is undefined', () => {
    expect(queryParam({ url: '/rescan?minutes=1440' }, 'minutes')).toBe('1440');
    expect(queryParam({ originalUrl: '/rescan?minutes=30&x=1' }, 'minutes')).toBe('30');
  });

  it('returns undefined rather than throwing when there is no query string', () => {
    expect(queryParam({ url: '/rescan' }, 'minutes')).toBeUndefined();
    expect(queryParam({}, 'minutes')).toBeUndefined();
  });
});

describe('body parsing', () => {
  const express = require('express');

  /**
   * Mounts the app behind a parser that has already consumed the request
   * stream — exactly what the GCP Functions Framework does before handing the
   * request to our app.
   */
  function underFrameworkLikeParser(syncService) {
    const outer = express();
    outer.use(express.json());
    outer.use(createApp({ syncService }));
    return outer;
  }

  // Parsing a second time threw "stream is not readable" and failed every
  // request carrying a body — i.e. every real Airtable notification, while
  // working perfectly on the local dev server.
  it('handles a body already parsed upstream instead of re-reading the stream', async () => {
    const syncService = { process: jest.fn().mockResolvedValue({ status: 'synced' }) };

    const response = await request(underFrameworkLikeParser(syncService))
      .post('/webhook')
      .set('X-Webhook-Secret', process.env.WEBHOOK_SECRET)
      .send({ table: 'Companies', recordId: 'recABC' });

    expect(response.status).toBe(200);
    expect(syncService.process).toHaveBeenCalledWith(
      expect.objectContaining({ table: 'Companies', recordId: 'recABC' }),
      expect.anything()
    );
  });

  it('still parses the body when nothing upstream has', async () => {
    const syncService = { process: jest.fn().mockResolvedValue({ status: 'synced' }) };

    const response = await request(createApp({ syncService }))
      .post('/webhook')
      .set('X-Webhook-Secret', process.env.WEBHOOK_SECRET)
      .send({ table: 'Deals', recordId: 'recXYZ' });

    expect(response.status).toBe(200);
    expect(syncService.process).toHaveBeenCalledWith(
      expect.objectContaining({ table: 'Deals', recordId: 'recXYZ' }),
      expect.anything()
    );
  });
});

describe('GET /health', () => {
  it('responds without requiring the shared secret', async () => {
    const response = await request(createApp({ syncService: { process: jest.fn() } })).get(
      '/health'
    );

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('ok');
  });
});
