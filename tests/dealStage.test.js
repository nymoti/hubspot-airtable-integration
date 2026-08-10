'use strict';

const { mapStatusToDealStage, DEFAULT_STAGE } = require('../src/integration/dealStage');
const { mapDealStage, DEFAULT_DEAL_STAGE } = require('../src/migration/mappers');

describe('Airtable status → HubSpot deal stage', () => {
  it('maps Won to closedwon', () => {
    expect(mapStatusToDealStage('Won')).toBe('closedwon');
  });

  it('maps Lost to closedlost', () => {
    expect(mapStatusToDealStage('Lost')).toBe('closedlost');
  });

  it.each(['Open', 'In Progress', 'Negotiating', 'Proposal Sent'])(
    'maps any other status (%s) to qualifiedtobuy',
    (status) => {
      expect(mapStatusToDealStage(status)).toBe('qualifiedtobuy');
    }
  );

  it('is insensitive to case, padding and separators', () => {
    expect(mapStatusToDealStage('  won ')).toBe('closedwon');
    expect(mapStatusToDealStage('CLOSED-LOST')).toBe('closedlost');
    expect(mapStatusToDealStage('closed_won')).toBe('closedwon');
  });

  it('defaults when the status is missing entirely', () => {
    expect(mapStatusToDealStage(null)).toBe(DEFAULT_STAGE);
    expect(mapStatusToDealStage(undefined)).toBe(DEFAULT_STAGE);
    expect(mapStatusToDealStage('')).toBe(DEFAULT_STAGE);
  });
});

describe('CSV deal_stage mapping (migration)', () => {
  it('accepts stages that are already HubSpot internal ids', () => {
    expect(mapDealStage('closedwon')).toEqual({ stage: 'closedwon', warning: null });
    expect(mapDealStage('decisionmakerboughtin')).toEqual({
      stage: 'decisionmakerboughtin',
      warning: null,
    });
  });

  it('defaults an unknown stage and reports why', () => {
    const result = mapDealStage('negotiation');
    expect(result.stage).toBe(DEFAULT_DEAL_STAGE);
    expect(result.warning).toMatch(/Unrecognised deal_stage/);
  });

  it('defaults an empty stage', () => {
    expect(mapDealStage('').stage).toBe(DEFAULT_DEAL_STAGE);
  });
});
