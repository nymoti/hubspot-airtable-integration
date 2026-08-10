'use strict';

const { withRetry, RateLimiter } = require('../src/shared/retry');
const { isRetryable, ValidationError, HubSpotApiError } = require('../src/shared/errors');

describe('isRetryable', () => {
  it('treats rate limits and server errors as transient', () => {
    expect(isRetryable({ status: 429 })).toBe(true);
    expect(isRetryable({ status: 500 })).toBe(true);
    expect(isRetryable({ status: 503 })).toBe(true);
  });

  it('treats client validation errors as permanent', () => {
    expect(isRetryable({ status: 400 })).toBe(false);
    expect(isRetryable({ status: 404 })).toBe(false);
    expect(isRetryable(new ValidationError('bad'))).toBe(false);
  });

  it('treats socket faults as transient', () => {
    expect(isRetryable({ code: 'ECONNRESET' })).toBe(true);
    expect(isRetryable({ code: 'ETIMEDOUT' })).toBe(true);
  });
});

describe('withRetry', () => {
  const noDelay = { baseDelayMs: 0, maxDelayMs: 0 };

  it('returns the result when the first attempt succeeds', async () => {
    const operation = jest.fn().mockResolvedValue('ok');
    await expect(withRetry(operation, noDelay)).resolves.toBe('ok');
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('retries a 429 and succeeds', async () => {
    const operation = jest
      .fn()
      .mockRejectedValueOnce(new HubSpotApiError('rate limited', { status: 429, retryable: true }))
      .mockResolvedValue('ok');

    await expect(withRetry(operation, noDelay)).resolves.toBe('ok');
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it('does not retry a permanent failure', async () => {
    const operation = jest.fn().mockRejectedValue(new ValidationError('invalid'));

    await expect(withRetry(operation, noDelay)).rejects.toThrow(ValidationError);
    // Retrying a 400 only wastes the budget and delays the real signal.
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('gives up after the retry budget and rethrows the last error', async () => {
    const operation = jest
      .fn()
      .mockRejectedValue(new HubSpotApiError('down', { status: 503, retryable: true }));

    await expect(withRetry(operation, { ...noDelay, retries: 3 })).rejects.toThrow('down');
    expect(operation).toHaveBeenCalledTimes(4); // 1 initial + 3 retries
  });

  it('honours a Retry-After header instead of guessing', async () => {
    const error = new HubSpotApiError('slow down', { status: 429, retryable: true });
    error.headers = { 'retry-after': '0' };

    const operation = jest.fn().mockRejectedValueOnce(error).mockResolvedValue('ok');

    await expect(withRetry(operation, noDelay)).resolves.toBe('ok');
    expect(operation).toHaveBeenCalledTimes(2);
  });
});

describe('RateLimiter', () => {
  it('runs operations in the order they were scheduled', async () => {
    const limiter = new RateLimiter(1000); // effectively no wait
    const order = [];

    await Promise.all([
      limiter.schedule(async () => order.push(1)),
      limiter.schedule(async () => order.push(2)),
      limiter.schedule(async () => order.push(3)),
    ]);

    expect(order).toEqual([1, 2, 3]);
  });

  it('keeps processing after an operation rejects', async () => {
    const limiter = new RateLimiter(1000);

    await expect(limiter.schedule(() => Promise.reject(new Error('boom')))).rejects.toThrow(
      'boom'
    );
    // A rejected call must not poison the queue for everything behind it.
    await expect(limiter.schedule(async () => 'still working')).resolves.toBe(
      'still working'
    );
  });

  it('spaces calls out to respect the configured rate', async () => {
    const limiter = new RateLimiter(50); // 20ms apart
    const start = Date.now();

    await limiter.schedule(async () => null);
    await limiter.schedule(async () => null);
    await limiter.schedule(async () => null);

    expect(Date.now() - start).toBeGreaterThanOrEqual(35);
  });
});
