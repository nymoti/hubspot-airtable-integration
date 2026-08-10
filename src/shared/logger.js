'use strict';

const path = require('path');
const winston = require('winston');
const config = require('./config');

/**
 * Structured logger shared by the migration CLI and the integration service.
 *
 * Output is newline-delimited JSON on stdout. GCP Cloud Logging ingests that
 * natively: it promotes `severity`, `message` and `logging.googleapis.com/*`
 * fields, and keeps everything else as queryable `jsonPayload`. That means a
 * query like `jsonPayload.airtableRecordId="recXXXX"` returns the full trace of
 * one record through the service without any extra tooling.
 */

// Winston npm levels -> Cloud Logging LogSeverity.
const SEVERITY_BY_LEVEL = {
  error: 'ERROR',
  warn: 'WARNING',
  info: 'INFO',
  http: 'INFO',
  verbose: 'DEBUG',
  debug: 'DEBUG',
  silly: 'DEBUG',
};

const cloudLoggingSeverity = winston.format((info) => {
  info.severity = SEVERITY_BY_LEVEL[info.level] || 'DEFAULT';
  return info;
});

const structuredFormat = winston.format.combine(
  winston.format.timestamp(),
  winston.format.errors({ stack: true }),
  cloudLoggingSeverity(),
  winston.format.json()
);

// Human-readable format for local terminal use.
const consoleFormat = winston.format.combine(
  winston.format.colorize(),
  winston.format.timestamp({ format: 'HH:mm:ss' }),
  winston.format.errors({ stack: true }),
  winston.format.printf(({ timestamp, level, message, stack, ...meta }) => {
    const context = Object.keys(meta).length
      ? ` ${JSON.stringify(meta)}`
      : '';
    return `${timestamp} ${level} ${message}${context}${stack ? `\n${stack}` : ''}`;
  })
);

const isCloudFunction = Boolean(
  process.env.K_SERVICE || process.env.FUNCTION_TARGET
);

const transports = [
  new winston.transports.Console({
    // Cloud Functions and production want JSON; a developer at a terminal
    // wants something readable.
    format: isCloudFunction || config.env === 'production'
      ? structuredFormat
      : consoleFormat,
  }),
];

// Cloud Functions have an ephemeral, read-only-ish filesystem; file transports
// are only useful when running locally or as a long-lived container.
if (config.logging.toFile && !isCloudFunction) {
  transports.push(
    new winston.transports.File({
      filename: path.join(config.logging.directory, 'error.log'),
      level: 'error',
      format: structuredFormat,
    }),
    new winston.transports.File({
      filename: path.join(config.logging.directory, 'combined.log'),
      format: structuredFormat,
    })
  );
}

const logger = winston.createLogger({
  level: config.logging.level,
  silent: config.logging.silent,
  defaultMeta: { service: process.env.K_SERVICE || 'hubspot-sync' },
  transports,
  exitOnError: false,
});

/**
 * Returns a logger that stamps every entry with the given context. Used to
 * bind a correlation id (and the record being processed) for the lifetime of
 * one webhook invocation, so all its log lines can be retrieved together.
 *
 * @param {Record<string, unknown>} context
 * @returns {winston.Logger}
 */
function withContext(context) {
  return logger.child(context);
}

module.exports = logger;
module.exports.withContext = withContext;
