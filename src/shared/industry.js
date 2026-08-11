'use strict';

/**
 * HubSpot's `industry` property is a fixed enumeration, and it rejects the
 * whole record if given anything outside it. Source systems store free text
 * ("Technology", "Robotics"), so every value must be translated before it is
 * sent.
 *
 * This lives in `shared/` because both parts of the project need it. It
 * originally existed only in the migration, which is why the Airtable sync
 * passed `industry` through untranslated and HubSpot rejected every company —
 * and, by cascade, every contact and deal that triggered a company sync.
 *
 * Note there is deliberately **no `OTHER` fallback**: HubSpot's enumeration
 * does not contain `OTHER`, so using it as a catch-all would reintroduce the
 * same failure. An unrecognised value yields `null` and the property is
 * omitted, which costs one field rather than the entire record.
 */

/** Every value HubSpot's `industry` enumeration accepts. */
const HUBSPOT_INDUSTRIES = new Set([
  'ACCOUNTING', 'AIRLINES_AVIATION', 'ALTERNATIVE_DISPUTE_RESOLUTION',
  'ALTERNATIVE_MEDICINE', 'ANIMATION', 'APPAREL_FASHION',
  'ARCHITECTURE_PLANNING', 'ARTS_AND_CRAFTS', 'AUTOMOTIVE',
  'AVIATION_AEROSPACE', 'BANKING', 'BIOTECHNOLOGY', 'BROADCAST_MEDIA',
  'BUILDING_MATERIALS', 'BUSINESS_SUPPLIES_AND_EQUIPMENT', 'CAPITAL_MARKETS',
  'CHEMICALS', 'CIVIC_SOCIAL_ORGANIZATION', 'CIVIL_ENGINEERING',
  'COMMERCIAL_REAL_ESTATE', 'COMPUTER_NETWORK_SECURITY', 'COMPUTER_GAMES',
  'COMPUTER_HARDWARE', 'COMPUTER_NETWORKING', 'COMPUTER_SOFTWARE', 'INTERNET',
  'CONSTRUCTION', 'CONSUMER_ELECTRONICS', 'CONSUMER_GOODS',
  'CONSUMER_SERVICES', 'COSMETICS', 'DAIRY', 'DEFENSE_SPACE', 'DESIGN',
  'EDUCATION_MANAGEMENT', 'E_LEARNING',
  'ELECTRICAL_ELECTRONIC_MANUFACTURING', 'ENTERTAINMENT',
  'ENVIRONMENTAL_SERVICES', 'EVENTS_SERVICES', 'EXECUTIVE_OFFICE',
  'FACILITIES_SERVICES', 'FARMING', 'FINANCIAL_SERVICES', 'FINE_ART',
  'FISHERY', 'FOOD_BEVERAGES', 'FOOD_PRODUCTION', 'FUND_RAISING', 'FURNITURE',
  'GAMBLING_CASINOS', 'GLASS_CERAMICS_CONCRETE', 'GOVERNMENT_ADMINISTRATION',
  'GOVERNMENT_RELATIONS', 'GRAPHIC_DESIGN', 'HEALTH_WELLNESS_AND_FITNESS',
  'HIGHER_EDUCATION', 'HOSPITAL_HEALTH_CARE', 'HOSPITALITY', 'HUMAN_RESOURCES',
  'IMPORT_AND_EXPORT', 'INDIVIDUAL_FAMILY_SERVICES', 'INDUSTRIAL_AUTOMATION',
  'INFORMATION_SERVICES', 'INFORMATION_TECHNOLOGY_AND_SERVICES', 'INSURANCE',
  'INTERNATIONAL_AFFAIRS', 'INTERNATIONAL_TRADE_AND_DEVELOPMENT',
  'INVESTMENT_BANKING', 'INVESTMENT_MANAGEMENT', 'JUDICIARY',
  'LAW_ENFORCEMENT', 'LAW_PRACTICE', 'LEGAL_SERVICES', 'LEGISLATIVE_OFFICE',
  'LEISURE_TRAVEL_TOURISM', 'LIBRARIES', 'LOGISTICS_AND_SUPPLY_CHAIN',
  'LUXURY_GOODS_JEWELRY', 'MACHINERY', 'MANAGEMENT_CONSULTING', 'MARITIME',
  'MARKET_RESEARCH', 'MARKETING_AND_ADVERTISING',
  'MECHANICAL_OR_INDUSTRIAL_ENGINEERING', 'MEDIA_PRODUCTION',
  'MEDICAL_DEVICES', 'MEDICAL_PRACTICE', 'MENTAL_HEALTH_CARE', 'MILITARY',
  'MINING_METALS', 'MOTION_PICTURES_AND_FILM', 'MUSEUMS_AND_INSTITUTIONS',
  'MUSIC', 'NANOTECHNOLOGY', 'NEWSPAPERS',
  'NON_PROFIT_ORGANIZATION_MANAGEMENT', 'OIL_ENERGY', 'ONLINE_MEDIA',
  'OUTSOURCING_OFFSHORING', 'PACKAGE_FREIGHT_DELIVERY',
  'PACKAGING_AND_CONTAINERS', 'PAPER_FOREST_PRODUCTS', 'PERFORMING_ARTS',
  'PHARMACEUTICALS', 'PHILANTHROPY', 'PHOTOGRAPHY', 'PLASTICS',
  'POLITICAL_ORGANIZATION', 'PRIMARY_SECONDARY_EDUCATION', 'PRINTING',
  'PROFESSIONAL_TRAINING_COACHING', 'PROGRAM_DEVELOPMENT', 'PUBLIC_POLICY',
  'PUBLIC_RELATIONS_AND_COMMUNICATIONS', 'PUBLIC_SAFETY', 'PUBLISHING',
  'RAILROAD_MANUFACTURE', 'RANCHING', 'REAL_ESTATE',
  'RECREATIONAL_FACILITIES_AND_SERVICES', 'RELIGIOUS_INSTITUTIONS',
  'RENEWABLES_ENVIRONMENT', 'RESEARCH', 'RESTAURANTS', 'RETAIL',
  'SECURITY_AND_INVESTIGATIONS', 'SEMICONDUCTORS', 'SHIPBUILDING',
  'SPORTING_GOODS', 'SPORTS', 'STAFFING_AND_RECRUITING', 'SUPERMARKETS',
  'TELECOMMUNICATIONS', 'TEXTILES', 'THINK_TANKS', 'TOBACCO',
  'TRANSLATION_AND_LOCALIZATION', 'TRANSPORTATION_TRUCKING_RAILROAD',
  'UTILITIES', 'VENTURE_CAPITAL_PRIVATE_EQUITY', 'VETERINARY', 'WAREHOUSING',
  'WHOLESALE', 'WINE_AND_SPIRITS', 'WIRELESS', 'WRITING_AND_EDITING',
  'MOBILE_GAMES',
]);

/**
 * Everyday labels (as used in the CSV export and the Airtable base) mapped
 * onto HubSpot's enumeration. Keys are compared lower-cased and trimmed.
 */
const INDUSTRY_ALIASES = {
  'agriculture': 'FARMING',
  'biotech': 'BIOTECHNOLOGY',
  'biotechnology': 'BIOTECHNOLOGY',
  'construction': 'CONSTRUCTION',
  'consulting': 'MANAGEMENT_CONSULTING',
  'defense': 'DEFENSE_SPACE',
  'defence': 'DEFENSE_SPACE',
  'education': 'HIGHER_EDUCATION',
  'energy': 'OIL_ENERGY',
  'engineering': 'MECHANICAL_OR_INDUSTRIAL_ENGINEERING',
  'finance': 'FINANCIAL_SERVICES',
  'fintech': 'FINANCIAL_SERVICES',
  'food & beverage': 'FOOD_BEVERAGES',
  'food and beverage': 'FOOD_BEVERAGES',
  'healthcare': 'HOSPITAL_HEALTH_CARE',
  'health care': 'HOSPITAL_HEALTH_CARE',
  'hospitality': 'HOSPITALITY',
  'insurance': 'INSURANCE',
  'legal': 'LEGAL_SERVICES',
  'logistics': 'LOGISTICS_AND_SUPPLY_CHAIN',
  'manufacturing': 'MACHINERY',
  'marketing': 'MARKETING_AND_ADVERTISING',
  'advertising': 'MARKETING_AND_ADVERTISING',
  'media': 'BROADCAST_MEDIA',
  'pharmaceuticals': 'PHARMACEUTICALS',
  'pharma': 'PHARMACEUTICALS',
  'r&d': 'RESEARCH',
  'real estate': 'REAL_ESTATE',
  'retail': 'RETAIL',
  'robotics': 'MECHANICAL_OR_INDUSTRIAL_ENGINEERING',
  'software': 'COMPUTER_SOFTWARE',
  'technology': 'INFORMATION_TECHNOLOGY_AND_SERVICES',
  'tech': 'INFORMATION_TECHNOLOGY_AND_SERVICES',
  'it': 'INFORMATION_TECHNOLOGY_AND_SERVICES',
  'telecom': 'TELECOMMUNICATIONS',
  'telecommunications': 'TELECOMMUNICATIONS',
  'transportation': 'TRANSPORTATION_TRUCKING_RAILROAD',
  'automotive': 'AUTOMOTIVE',
  'aerospace': 'AVIATION_AEROSPACE',
  'accounting': 'ACCOUNTING',
  'banking': 'BANKING',
  'wholesale': 'WHOLESALE',
  'distribution': 'WHOLESALE',
  'security': 'SECURITY_AND_INVESTIGATIONS',
  'hr': 'HUMAN_RESOURCES',
  'human resources': 'HUMAN_RESOURCES',
  'entertainment': 'ENTERTAINMENT',
  'internet': 'INTERNET',
  'nonprofit': 'NON_PROFIT_ORGANIZATION_MANAGEMENT',
  'non-profit': 'NON_PROFIT_ORGANIZATION_MANAGEMENT',
};

/**
 * Translates a free-text industry into a value HubSpot will accept.
 *
 * @param {unknown} value
 * @returns {string|null} a HubSpot enumeration value, or null when the input
 *   cannot be mapped — in which case the caller should omit the property
 */
function mapIndustry(value) {
  if (value === null || value === undefined) return null;

  const raw = String(value).trim();
  if (!raw) return null;

  // Already a HubSpot enumeration value (e.g. re-syncing a record we wrote).
  const upper = raw.toUpperCase().replace(/[\s-]+/g, '_');
  if (HUBSPOT_INDUSTRIES.has(upper)) return upper;

  const alias = INDUSTRY_ALIASES[raw.toLowerCase()];
  return alias || null;
}

module.exports = { mapIndustry, HUBSPOT_INDUSTRIES, INDUSTRY_ALIASES };
