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

const DEFAULT_STAGE = 'qualifiedtobuy';

const STAGE_BY_STATUS = {
  won: 'closedwon',
  'closed won': 'closedwon',
  closedwon: 'closedwon',
  lost: 'closedlost',
  'closed lost': 'closedlost',
  closedlost: 'closedlost',
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

module.exports = { mapStatusToDealStage, DEFAULT_STAGE, STAGE_BY_STATUS };
