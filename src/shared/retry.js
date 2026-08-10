'use strict';

const { isRetryable } = require('./errors');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Reads the wait hinted by the server. HubSpot returns `Retry-After` in
 * seconds on 429; honouring it is both faster and politer than guessing.
 *
 * @param {unknown} error
 * @returns {number|null} milliseconds, or null when no hint is present
 */
function retryAfterMs(error) {
  const header =
    error?.response?.headers?.['retry-after'] ??
    error?.headers?.['retry-after'];
  if (header === undefined) return null;
  const seconds = Number(header);
  return Number.isFinite(seconds) ? seconds * 1000 : null;
}

/**
 * Runs `operation`, retrying transient failures with exponential backoff and
 * full jitter. Jitter matters here: without it, a burst of webhook invocations
 * that all hit the same 429 would retry in lockstep and trip the limit again.
 *
 * @template T
 * @param {() => Promise<T>} operation
 * @param {object} [options]
 * @param {number} [options.retries=5] maximum retry attempts (not counting the first try)
 * @param {number} [options.baseDelayMs=500]
 * @param {number} [options.maxDelayMs=20000]
 * @param {import('winston').Logger} [options.logger]
 * @param {Record<string, unknown>} [options.context] merged into retry log lines
 * @returns {Promise<T>}
 */
async function withRetry(operation, options = {}) {
  const {
    retries = 5,
    baseDelayMs = 500,
    maxDelayMs = 20000,
    logger,
    context = {},
  } = options;

  let attempt = 0;

  for (;;) {
    try {
      return await operation();
    } catch (error) {
      if (attempt >= retries || !isRetryable(error)) throw error;

      attempt += 1;
      const exponential = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
      const delay = retryAfterMs(error) ?? Math.random() * exponential;

      logger?.warn('Retrying after transient failure', {
        ...context,
        attempt,
        maxAttempts: retries,
        delayMs: Math.round(delay),
        status: error.status || error.response?.status,
        reason: error.message,
      });

      await sleep(delay);
    }
  }
}

/**
 * Serialises calls and spaces them out so we never exceed a target rate.
 * HubSpot's private-app limit is 190 requests / 10s; a simple client-side
 * throttle keeps us well inside it and makes 429s the exception rather than
 * the normal control flow.
 */
class RateLimiter {
  /** @param {number} requestsPerSecond */
  constructor(requestsPerSecond) {
    this.minIntervalMs = requestsPerSecond > 0 ? 1000 / requestsPerSecond : 0;
    this.queue = Promise.resolve();
    this.lastStartedAt = 0;
  }

  /**
   * @template T
   * @param {() => Promise<T>} operation
   * @returns {Promise<T>}
   */
  schedule(operation) {
    const run = this.queue.then(async () => {
      const waitMs = this.lastStartedAt + this.minIntervalMs - Date.now();
      if (waitMs > 0) await sleep(waitMs);
      this.lastStartedAt = Date.now();
    });

    // Keep the chain alive even when an operation rejects.
    this.queue = run.catch(() => {});
    return run.then(operation);
  }
}

module.exports = { withRetry, RateLimiter, sleep, retryAfterMs };
