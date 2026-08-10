'use strict';

/**
 * Pure value transforms shared by the migration and the integration.
 *
 * These are deliberately free of I/O and configuration so they can be unit
 * tested exhaustively — the CSV export and the Airtable base both contain
 * messy, inconsistently formatted values, and this is where that mess is
 * normalised before anything reaches HubSpot.
 */

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Two-digit zero padding. */
const pad = (value) => String(value).padStart(2, '0');

const MONTHS_BY_NAME = {
  jan: '01', january: '01',
  feb: '02', february: '02',
  mar: '03', march: '03',
  apr: '04', april: '04',
  may: '05',
  jun: '06', june: '06',
  jul: '07', july: '07',
  aug: '08', august: '08',
  sep: '09', sept: '09', september: '09',
  oct: '10', october: '10',
  nov: '11', november: '11',
  dec: '12', december: '12',
};

/**
 * True when the parts form a real calendar date (rejects 2021-02-30).
 */
function isRealDate(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function assemble(year, month, day) {
  const y = Number(year);
  const m = Number(month);
  const d = Number(day);
  if (!isRealDate(y, m, d)) return null;
  return `${y}-${pad(m)}-${pad(d)}`;
}

/**
 * Normalises the many date shapes present in the source data into the
 * `YYYY-MM-DD` that HubSpot's date properties accept.
 *
 * Formats handled (all observed in the provided CSVs):
 *   YYYY-MM-DD, YYYY/MM/DD, MM/DD/YYYY, DD/MM/YYYY, MM-DD-YYYY, DD-MM-YYYY,
 *   MM/YYYY, MM-YYYY (partial — normalised to the first of the month),
 *   "March 2022" style month-and-year strings.
 *
 * Ambiguous day/month pairs (e.g. 05/06/2024) are read as US month-first,
 * matching the dominant convention in the export; a value is only re-read as
 * day-first when month-first would be an impossible date.
 *
 * @param {unknown} value
 * @returns {string|null} `YYYY-MM-DD`, or null when the value cannot be parsed
 */
function parseDate(value) {
  if (value === null || value === undefined) return null;

  const input = String(value).trim();
  if (!input) return null;

  // Already ISO.
  const iso = input.match(ISO_DATE);
  if (iso) return assemble(iso[1], iso[2], iso[3]);

  // YYYY/MM/DD — year first is unambiguous.
  const yearFirst = input.match(/^(\d{4})[/](\d{1,2})[/](\d{1,2})$/);
  if (yearFirst) return assemble(yearFirst[1], yearFirst[2], yearFirst[3]);

  // MM/DD/YYYY, DD/MM/YYYY, MM-DD-YYYY, DD-MM-YYYY.
  //
  // The missing branch for the dash-separated variants is what caused 20 deals
  // to be rejected by HubSpot in the first migration run: `09-17-2021` fell
  // through unparsed and was sent verbatim as `closedate`.
  const dayMonth = input.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
  if (dayMonth) {
    const [, first, second, year] = dayMonth;
    return (
      assemble(year, first, second) || // month-first (US), the common case
      assemble(year, second, first) || // day-first fallback
      null
    );
  }

  // MM/YYYY or MM-YYYY — partial dates; anchor to the first of the month.
  const monthYear = input.match(/^(\d{1,2})[-/](\d{4})$/);
  if (monthYear) return assemble(monthYear[2], monthYear[1], 1);

  // YYYY/MM or YYYY-MM.
  const yearMonth = input.match(/^(\d{4})[-/](\d{1,2})$/);
  if (yearMonth) return assemble(yearMonth[1], yearMonth[2], 1);

  // "March 2022", "Mar 2022", "2022 March".
  const named = input.toLowerCase().match(/^([a-z]+)\.?\s+(\d{4})$|^(\d{4})\s+([a-z]+)\.?$/);
  if (named) {
    const monthName = named[1] || named[4];
    const year = named[2] || named[3];
    const month = MONTHS_BY_NAME[monthName];
    if (month) return assemble(year, month, 1);
  }

  return null;
}

/**
 * Parses a currency-ish string (`"$48,469"`, `141994.39`) into a number.
 *
 * @param {unknown} value
 * @returns {number|null} null when there is no usable numeric content
 */
function parseAmount(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;

  const cleaned = String(value).replace(/[^0-9.\-]/g, '');
  if (!cleaned || cleaned === '-' || cleaned === '.') return null;

  const parsed = Number.parseFloat(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Parses an integer property such as headcount or quantity.
 *
 * @param {unknown} value
 * @returns {number|null}
 */
function parseInteger(value) {
  const amount = parseAmount(value);
  return amount === null ? null : Math.trunc(amount);
}

/**
 * The source data expresses booleans as 1/0, True/False, Yes/No and y/n.
 *
 * @param {unknown} value
 * @returns {boolean|null}
 */
function parseBoolean(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'boolean') return value;

  const normalised = String(value).trim().toLowerCase();
  if (['true', '1', 'yes', 'y', 't'].includes(normalised)) return true;
  if (['false', '0', 'no', 'n', 'f'].includes(normalised)) return false;
  return null;
}

/**
 * Normalises an email for use as a matching key. HubSpot treats the email
 * property as case-insensitive, so we lower-case it to keep our own
 * duplicate detection consistent with theirs.
 *
 * @param {unknown} value
 * @returns {string|null}
 */
function normaliseEmail(value) {
  if (!value) return null;
  const email = String(value).trim().toLowerCase();
  // Deliberately permissive: we only reject values that clearly are not an
  // address, and let HubSpot be the authority on the rest.
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}

/**
 * Strips a domain down to a bare hostname so `https://www.acme.com/` and
 * `acme.com` resolve to the same company during idempotency checks.
 *
 * @param {unknown} value
 * @returns {string|null}
 */
function normaliseDomain(value) {
  if (!value) return null;
  const domain = String(value)
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/.*$/, '');
  return domain || null;
}

/**
 * Reduces a phone number to digits. Extensions and formatting vary wildly in
 * the export; HubSpot stores the string as given, so we only tidy it.
 *
 * @param {unknown} value
 * @returns {string|null}
 */
function cleanPhone(value) {
  if (!value) return null;
  const digits = String(value).replace(/[^0-9]/g, '');
  return digits || null;
}

/**
 * Splits an array into fixed-size chunks, for HubSpot's batch endpoints.
 *
 * @template T
 * @param {T[]} items
 * @param {number} size
 * @returns {T[][]}
 */
function chunk(items, size) {
  if (size <= 0) throw new RangeError('chunk size must be greater than zero');
  const chunks = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

/**
 * Removes null/undefined/empty-string entries from a HubSpot property bag.
 *
 * This matters on update: sending `{ phone: '' }` would blank an existing
 * value in HubSpot, so an absent source value must mean "leave alone", not
 * "clear".
 *
 * @param {Record<string, unknown>} properties
 * @returns {Record<string, string>}
 */
function compactProperties(properties) {
  const result = {};
  for (const [key, value] of Object.entries(properties)) {
    if (value === null || value === undefined || value === '') continue;
    result[key] = typeof value === 'string' ? value : String(value);
  }
  return result;
}

module.exports = {
  parseDate,
  parseAmount,
  parseInteger,
  parseBoolean,
  normaliseEmail,
  normaliseDomain,
  cleanPhone,
  chunk,
  compactProperties,
};
