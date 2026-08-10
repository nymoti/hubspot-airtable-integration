'use strict';

const { createHmac, timingSafeEqual } = require('crypto');

/**
 * Verification of Airtable webhook notifications.
 *
 * Airtable signs every notification with an HMAC-SHA256 over the raw request
 * body, keyed by the base64 MAC secret it returned when the webhook was
 * registered, and sends it as:
 *
 *     X-Airtable-Content-MAC: hmac-sha256=<hex digest>
 *
 * This is the only thing standing between our CRM and anyone who discovers the
 * function URL, since the notification endpoint has to be publicly reachable.
 * It must be computed over the *raw bytes*, not over re-serialised JSON —
 * `JSON.stringify(req.body)` would reorder keys and change whitespace, and the
 * digest would never match.
 */

const HEADER = 'x-airtable-content-mac';
const PREFIX = 'hmac-sha256=';

/**
 * @param {Buffer|string} rawBody exact bytes of the request body
 * @param {string} macSecretBase64 the secret Airtable returned at registration
 * @returns {string} the expected header value
 */
function expectedSignature(rawBody, macSecretBase64) {
  const key = Buffer.from(macSecretBase64, 'base64');
  const digest = createHmac('sha256', key).update(rawBody).digest('hex');
  return `${PREFIX}${digest}`;
}

/**
 * Constant-time comparison of two signatures.
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function signaturesMatch(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * @param {object} params
 * @param {Buffer|string} params.rawBody
 * @param {string} params.header the `X-Airtable-Content-MAC` value
 * @param {string} params.macSecret base64 secret
 * @returns {boolean}
 */
function verifyNotification({ rawBody, header, macSecret }) {
  if (!macSecret || !header || !rawBody) return false;
  return signaturesMatch(header, expectedSignature(rawBody, macSecret));
}

module.exports = {
  verifyNotification,
  expectedSignature,
  signaturesMatch,
  MAC_HEADER: HEADER,
};
