'use strict';

/**
 * Error types used across both parts of the project.
 *
 * The distinction that matters operationally is `retryable`: transient faults
 * (429, 5xx, socket errors) should be retried, while validation faults (400,
 * 409 on a required property) never will succeed on retry and must be surfaced
 * to a human instead of consuming the retry budget.
 */

class AppError extends Error {
  /**
   * @param {string} message
   * @param {{ code?: string, retryable?: boolean, context?: Record<string, unknown>, cause?: Error }} [options]
   */
  constructor(message, options = {}) {
    super(message);
    this.name = this.constructor.name;
    this.code = options.code || 'APP_ERROR';
    this.retryable = Boolean(options.retryable);
    this.context = options.context || {};
    if (options.cause) this.cause = options.cause;
    Error.captureStackTrace(this, this.constructor);
  }

  /** Shape suitable for structured logging. */
  toJSON() {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      context: this.context,
    };
  }
}

/** A request to the HubSpot API failed. */
class HubSpotApiError extends AppError {
  constructor(message, options = {}) {
    super(message, { code: 'HUBSPOT_API_ERROR', ...options });
    this.status = options.status;
    /** HubSpot's per-field validation details, when present. */
    this.details = options.details;
  }
}

/** A request to the Airtable API failed. */
class AirtableApiError extends AppError {
  constructor(message, options = {}) {
    super(message, { code: 'AIRTABLE_API_ERROR', ...options });
    this.status = options.status;
  }
}

/** An inbound payload or CSV row could not be turned into a valid record. */
class ValidationError extends AppError {
  constructor(message, options = {}) {
    super(message, { code: 'VALIDATION_ERROR', retryable: false, ...options });
  }
}

/** A referenced parent record (company, deal) could not be resolved. */
class MissingReferenceError extends AppError {
  constructor(message, options = {}) {
    super(message, { code: 'MISSING_REFERENCE', retryable: false, ...options });
  }
}

/**
 * Decides whether a raw error from an HTTP client is worth retrying.
 * Rate limits and server-side faults are; everything else is not.
 *
 * @param {unknown} error
 * @returns {boolean}
 */
function isRetryable(error) {
  if (!error) return false;
  if (error instanceof AppError) return error.retryable;

  const status = error.status || error.response?.status;
  if (status === 429) return true;
  if (typeof status === 'number' && status >= 500) return true;

  const transientCodes = new Set([
    'ECONNRESET',
    'ETIMEDOUT',
    'ECONNABORTED',
    'ENOTFOUND',
    'EAI_AGAIN',
    'EPIPE',
    'ECONNREFUSED',
  ]);
  return transientCodes.has(error.code);
}

module.exports = {
  AppError,
  HubSpotApiError,
  AirtableApiError,
  ValidationError,
  MissingReferenceError,
  isRetryable,
};
