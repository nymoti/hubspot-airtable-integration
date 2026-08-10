'use strict';

const {
  resolveParentHubspotId,
  firstLinkedRecordId,
} = require('../src/integration/handlers/resolveParent');
const { MissingReferenceError } = require('../src/shared/errors');
const { FakeAirtableService, silentLogger } = require('./helpers/mocks');

describe('firstLinkedRecordId', () => {
  it('reads the first id from an Airtable link array', () => {
    expect(firstLinkedRecordId({ Company: ['recA', 'recB'] }, ['Company'])).toBe('recA');
  });

  it('accepts any of the candidate field names', () => {
    expect(
      firstLinkedRecordId({ 'Linked Company': ['recC'] }, ['Company', 'Linked Company'])
    ).toBe('recC');
  });

  it('accepts a flattened single-record link', () => {
    expect(firstLinkedRecordId({ Company: 'recD' }, ['Company'])).toBe('recD');
  });

  it('returns null for a cleared or absent link', () => {
    expect(firstLinkedRecordId({ Company: [] }, ['Company'])).toBeNull();
    expect(firstLinkedRecordId({}, ['Company'])).toBeNull();
  });
});

describe('resolveParentHubspotId', () => {
  const baseParams = {
    linkFieldNames: ['Company', 'Linked Company'],
    businessKeyField: 'company_id',
    parentTable: 'Companies',
    logger: silentLogger(),
  };

  it('returns the parent id when the parent is already synced', async () => {
    const airtable = new FakeAirtableService({
      Companies: [
        { id: 'recCo1', fields: { company_id: 'C-1', hubspot_record_id: '5000' } },
      ],
    });

    const id = await resolveParentHubspotId({
      ...baseParams,
      fields: { Company: ['recCo1'] },
      airtable,
      syncParent: jest.fn(),
    });

    expect(id).toBe('5000');
  });

  it('falls back to the business key when the link field is empty', async () => {
    // Some rows carry `company_id` but no Airtable link.
    const airtable = new FakeAirtableService({
      Companies: [
        { id: 'recCo1', fields: { company_id: 'C-7', hubspot_record_id: '5007' } },
      ],
    });

    const id = await resolveParentHubspotId({
      ...baseParams,
      fields: { company_id: 'C-7' },
      airtable,
      syncParent: jest.fn(),
    });

    expect(id).toBe('5007');
  });

  // Webhooks arrive in whatever order Airtable fires them, so a child can
  // easily be processed before its parent has ever been synced.
  it('syncs the parent on demand when it has no HubSpot id yet', async () => {
    const airtable = new FakeAirtableService({
      Companies: [{ id: 'recCo1', fields: { company_id: 'C-1', company_name: 'Acme' } }],
    });
    const syncParent = jest.fn().mockResolvedValue({ hubspotId: '5100' });

    const id = await resolveParentHubspotId({
      ...baseParams,
      fields: { Company: ['recCo1'] },
      airtable,
      syncParent,
    });

    expect(syncParent).toHaveBeenCalledTimes(1);
    expect(syncParent.mock.calls[0][0].id).toBe('recCo1');
    expect(id).toBe('5100');
  });

  it('returns null when the parent is optional and missing', async () => {
    const airtable = new FakeAirtableService({ Companies: [] });

    const id = await resolveParentHubspotId({
      ...baseParams,
      fields: { company_id: 'does-not-exist' },
      airtable,
      syncParent: jest.fn(),
    });

    expect(id).toBeNull();
  });

  it('throws when the parent is required and missing', async () => {
    const airtable = new FakeAirtableService({ Deals: [] });

    await expect(
      resolveParentHubspotId({
        ...baseParams,
        parentTable: 'Deals',
        linkFieldNames: ['Deal'],
        businessKeyField: 'deal_id',
        fields: { deal_id: 'nope' },
        airtable,
        syncParent: jest.fn(),
        required: true,
      })
    ).rejects.toThrow(MissingReferenceError);
  });

  it('prefers the link field over the business key when both are present', async () => {
    const airtable = new FakeAirtableService({
      Companies: [
        { id: 'recLinked', fields: { company_id: 'C-1', hubspot_record_id: '111' } },
        { id: 'recOther', fields: { company_id: 'C-2', hubspot_record_id: '222' } },
      ],
    });

    const id = await resolveParentHubspotId({
      ...baseParams,
      fields: { Company: ['recLinked'], company_id: 'C-2' },
      airtable,
      syncParent: jest.fn(),
    });

    expect(id).toBe('111');
  });
});
