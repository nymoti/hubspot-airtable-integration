'use strict';

/**
 * Maps CSV rows onto HubSpot property bags.
 *
 * Every mapper is pure and returns `{ properties, warnings }` rather than
 * throwing: a row with an unparseable close date should still be imported
 * (minus that one property) and the problem recorded, not silently dropped.
 * Rows that cannot be imported at all are rejected via `errors`.
 */

const config = require('../shared/config');
const {
  parseDate,
  parseAmount,
  parseInteger,
  normaliseEmail,
  normaliseDomain,
  cleanPhone,
  compactProperties,
} = require('../shared/transforms');
const {
  OBJECT_TYPES,
  EXTERNAL_ID_PROPERTY,
  SOURCE_SYSTEM_PROPERTY,
  buildExternalId,
} = require('../shared/hubspotSchema');

const SOURCE = 'csv';

/**
 * CSV `industry` values mapped onto HubSpot's fixed `industry` enumeration.
 * HubSpot rejects values outside this list, so anything unrecognised falls
 * back to `OTHER` rather than failing the record.
 */
const INDUSTRY_BY_CSV_VALUE = {
  agriculture: 'FARMING',
  biotech: 'BIOTECHNOLOGY',
  construction: 'CONSTRUCTION',
  defense: 'DEFENSE_SPACE',
  education: 'HIGHER_EDUCATION',
  energy: 'OIL_ENERGY',
  finance: 'FINANCIAL_SERVICES',
  'food & beverage': 'FOOD_BEVERAGES',
  healthcare: 'HOSPITAL_HEALTH_CARE',
  hospitality: 'HOSPITALITY',
  insurance: 'INSURANCE',
  logistics: 'LOGISTICS_AND_SUPPLY_CHAIN',
  manufacturing: 'MACHINERY',
  media: 'BROADCAST_MEDIA',
  pharmaceuticals: 'PHARMACEUTICALS',
  'r&d': 'RESEARCH',
  retail: 'RETAIL',
  robotics: 'MECHANICAL_OR_INDUSTRIAL_ENGINEERING',
  technology: 'INFORMATION_TECHNOLOGY_AND_SERVICES',
  telecom: 'TELECOMMUNICATIONS',
};

/**
 * The CSV `deal_stage` column already uses HubSpot's internal stage ids. They
 * are still validated against the known set so a typo in the export surfaces
 * as a warning instead of a 400 from the API.
 */
const KNOWN_DEAL_STAGES = new Set([
  'appointmentscheduled',
  'qualifiedtobuy',
  'presentationscheduled',
  'decisionmakerboughtin',
  'contractsent',
  'closedwon',
  'closedlost',
]);

const DEFAULT_DEAL_STAGE = config.hubspot.defaultDealStage;

/** HubSpot's `lifecyclestage` internal values. */
const KNOWN_LIFECYCLE_STAGES = new Set([
  'subscriber',
  'lead',
  'marketingqualifiedlead',
  'salesqualifiedlead',
  'opportunity',
  'customer',
  'evangelist',
  'other',
]);

/**
 * @param {string} value
 * @returns {string} a HubSpot `industry` enumeration value
 */
function mapIndustry(value) {
  if (!value) return 'OTHER';
  return INDUSTRY_BY_CSV_VALUE[String(value).trim().toLowerCase()] || 'OTHER';
}

/**
 * @param {string} value
 * @returns {{ stage: string, warning: string|null }}
 */
function mapDealStage(value) {
  const stage = String(value || '').trim().toLowerCase();
  if (KNOWN_DEAL_STAGES.has(stage)) return { stage, warning: null };
  return {
    stage: DEFAULT_DEAL_STAGE,
    warning: `Unrecognised deal_stage "${value}", defaulted to ${DEFAULT_DEAL_STAGE}`,
  };
}

/**
 * @param {Record<string, string>} row
 * @returns {{ properties: Record<string, string>|null, warnings: string[], error: string|null }}
 */
function mapCompany(row) {
  const warnings = [];

  const name = (row.company_name || '').trim();
  if (!name) {
    return {
      properties: null,
      warnings,
      error: 'company_name is empty; HubSpot companies require a name',
    };
  }

  const domain = normaliseDomain(row.domain);
  if (row.domain && !domain) {
    warnings.push(`Could not normalise domain "${row.domain}"`);
  }

  const employees = parseInteger(row.number_of_employees);
  if (row.number_of_employees && employees === null) {
    warnings.push(`Could not parse number_of_employees "${row.number_of_employees}"`);
  }

  return {
    properties: compactProperties({
      name,
      domain,
      industry: mapIndustry(row.industry),
      numberofemployees: employees,
      [EXTERNAL_ID_PROPERTY]: buildExternalId(
        SOURCE,
        OBJECT_TYPES.COMPANIES,
        row.company_id
      ),
      [SOURCE_SYSTEM_PROPERTY]: 'csv_migration',
    }),
    warnings,
    error: null,
  };
}

/**
 * @param {Record<string, string>} row
 * @returns {{ properties: Record<string, string>|null, warnings: string[], error: string|null }}
 */
function mapContact(row) {
  const warnings = [];

  const email = normaliseEmail(row.email);
  if (!email) {
    // Email is HubSpot's natural key for contacts. Without it we would have no
    // way to detect duplicates on a re-run, so the row is rejected explicitly
    // rather than creating an unmatchable record.
    return {
      properties: null,
      warnings,
      error: `Missing or invalid email "${row.email || ''}"`,
    };
  }

  const lifecycleStage = String(row.lifecycle_stage || '').trim().toLowerCase();
  if (lifecycleStage && !KNOWN_LIFECYCLE_STAGES.has(lifecycleStage)) {
    warnings.push(`Unrecognised lifecycle_stage "${row.lifecycle_stage}", omitted`);
  }

  return {
    properties: compactProperties({
      firstname: (row.first_name || '').trim(),
      lastname: (row.last_name || '').trim(),
      email,
      phone: cleanPhone(row.phone),
      lifecyclestage: KNOWN_LIFECYCLE_STAGES.has(lifecycleStage)
        ? lifecycleStage
        : null,
      [EXTERNAL_ID_PROPERTY]: buildExternalId(
        SOURCE,
        OBJECT_TYPES.CONTACTS,
        row.contact_id
      ),
      [SOURCE_SYSTEM_PROPERTY]: 'csv_migration',
    }),
    warnings,
    error: null,
  };
}

/**
 * @param {Record<string, string>} row
 * @returns {{ properties: Record<string, string>|null, warnings: string[], error: string|null }}
 */
function mapDeal(row) {
  const warnings = [];

  const name = (row.deal_name || '').trim();
  if (!name) {
    return {
      properties: null,
      warnings,
      error: 'deal_name is empty; HubSpot deals require a name',
    };
  }

  const { stage, warning: stageWarning } = mapDealStage(row.deal_stage);
  if (stageWarning) warnings.push(stageWarning);

  const amount = parseAmount(row.amount);
  if (row.amount && amount === null) {
    warnings.push(`Could not parse amount "${row.amount}"`);
  }

  // The original migration sent unparsed dates such as "09-17-2021" straight
  // through, and HubSpot rejected the whole record with a 400. Now an
  // unparseable date costs only that one property.
  const closeDate = parseDate(row.close_date);
  if (row.close_date && closeDate === null) {
    warnings.push(`Could not parse close_date "${row.close_date}", omitted`);
  }

  return {
    properties: compactProperties({
      dealname: name,
      amount,
      dealstage: stage,
      closedate: closeDate,
      pipeline: config.hubspot.defaultPipeline,
      [EXTERNAL_ID_PROPERTY]: buildExternalId(
        SOURCE,
        OBJECT_TYPES.DEALS,
        row.deal_id
      ),
      [SOURCE_SYSTEM_PROPERTY]: 'csv_migration',
    }),
    warnings,
    error: null,
  };
}

module.exports = {
  mapCompany,
  mapContact,
  mapDeal,
  mapIndustry,
  mapDealStage,
  INDUSTRY_BY_CSV_VALUE,
  KNOWN_DEAL_STAGES,
  DEFAULT_DEAL_STAGE,
  SOURCE,
};
