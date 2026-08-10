'use strict';

/**
 * Maps the Airtable `status` field onto a HubSpot deal stage.
 *
 * The brief specifies the rule directly: Won → closedwon, Lost → closedlost,
 * anything else → qualifiedtobuy. It is implemented as an explicit allow-list
 * plus a default, so an unexpected status (a new option added in Airtable, a
 * typo, an empty cell) degrades to a sensible open stage instead of failing
 * the sync.
 *
 * Matching is case- and whitespace-insensitive because Airtable single-select
 * options are free text and drift over time ("won", "Won ", "WON").
 */

const config = require('../shared/config');

const DEFAULT_STAGE = config.hubspot.defaultDealStage;
const WON_STAGE = config.hubspot.wonDealStage;
const LOST_STAGE = config.hubspot.lostDealStage;

const STAGE_BY_STATUS = {
  won: WON_STAGE,
  'closed won': WON_STAGE,
  closedwon: WON_STAGE,
  lost: LOST_STAGE,
  'closed lost': LOST_STAGE,
  closedlost: LOST_STAGE,
};

/**
 * @param {unknown} status the raw Airtable `status` value
 * @returns {string} a HubSpot deal stage internal id
 */
function mapStatusToDealStage(status) {
  if (status === null || status === undefined) return DEFAULT_STAGE;

  const normalised = String(status).trim().toLowerCase().replace(/[_-]+/g, ' ');
  return STAGE_BY_STATUS[normalised] || DEFAULT_STAGE;
}

module.exports = {
  mapStatusToDealStage,
  DEFAULT_STAGE,
  WON_STAGE,
  LOST_STAGE,
  STAGE_BY_STATUS,
};
