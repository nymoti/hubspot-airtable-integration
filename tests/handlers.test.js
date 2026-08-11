'use strict';

const { HubSpotService } = require('../src/integration/services/hubspotService');
const { OBJECT_TYPES } = require('../src/shared/hubspotSchema');
const { handleCompany } = require('../src/integration/handlers/companyHandler');
const { handleContact } = require('../src/integration/handlers/contactHandler');
const { handleDeal } = require('../src/integration/handlers/dealHandler');
const { handleLineItem } = require('../src/integration/handlers/lineItemHandler');
const { ValidationError, MissingReferenceError } = require('../src/shared/errors');
const { FakeHubSpotClient, FakeAirtableService, silentLogger } = require('./helpers/mocks');

/**
 * Handler behaviour: field mapping, write-back, and association resolution.
 */

function buildContext(tables = {}) {
  const client = new FakeHubSpotClient();
  const hubspot = new HubSpotService({ client, logger: silentLogger() });
  const airtable = new FakeAirtableService(tables);
  return { client, hubspot, airtable, logger: silentLogger() };
}

const COMPANY_RECORD = {
  id: 'recCompany1',
  fields: {
    company_id: 'C-1',
    company_name: 'Acme Corp',
    domain: 'https://www.acme.com',
    industry: 'Technology',
    number_of_employees: '250',
  },
};

describe('handleCompany', () => {
  it('creates the company and writes the HubSpot id back to Airtable', async () => {
    const ctx = buildContext({ Companies: [COMPANY_RECORD] });

    const result = await handleCompany({ record: COMPANY_RECORD, ...ctx });

    expect(result.action).toBe('created');
    expect(ctx.airtable.writeBacks).toEqual([
      { tableName: 'Companies', recordId: 'recCompany1', hubspotId: result.hubspotId },
    ]);
  });

  it('normalises the domain before sending it to HubSpot', async () => {
    const ctx = buildContext({ Companies: [COMPANY_RECORD] });
    const result = await handleCompany({ record: COMPANY_RECORD, ...ctx });

    const stored = await ctx.client.getObject(OBJECT_TYPES.COMPANIES, result.hubspotId);
    expect(stored.properties.domain).toBe('acme.com');
    expect(stored.properties.numberofemployees).toBe('250');
  });

  it('does not write back again when Airtable already holds the same id', async () => {
    const ctx = buildContext({ Companies: [COMPANY_RECORD] });
    const first = await handleCompany({ record: COMPANY_RECORD, ...ctx });

    // A redundant Airtable update would trigger another webhook and loop.
    const withId = {
      ...COMPANY_RECORD,
      fields: { ...COMPANY_RECORD.fields, hubspot_record_id: first.hubspotId },
    };
    await handleCompany({ record: withId, ...ctx });

    expect(ctx.airtable.writeBacks).toHaveLength(1);
  });

  // Airtable stores free text ("Technology"), HubSpot requires an enumeration
  // value. Sending it raw made HubSpot reject every company, and by cascade
  // every contact and deal that triggered a company sync.
  it('translates industry into a HubSpot enumeration value', async () => {
    const ctx = buildContext({ Companies: [COMPANY_RECORD] });
    const result = await handleCompany({ record: COMPANY_RECORD, ...ctx });

    const stored = await ctx.client.getObject(OBJECT_TYPES.COMPANIES, result.hubspotId);
    expect(stored.properties.industry).toBe('INFORMATION_TECHNOLOGY_AND_SERVICES');
  });

  it('omits industry entirely when it cannot be mapped', async () => {
    const ctx = buildContext();
    const record = {
      id: 'recCompany9',
      fields: { company_name: 'Odd Co', industry: 'Underwater Basket Weaving' },
    };

    const result = await handleCompany({ record, ...ctx });
    const stored = await ctx.client.getObject(OBJECT_TYPES.COMPANIES, result.hubspotId);

    // Losing one field beats losing the record.
    expect(stored.properties.industry).toBeUndefined();
    expect(stored.properties.name).toBe('Odd Co');
  });

  it('rejects a company with no name', async () => {
    const ctx = buildContext();
    await expect(
      handleCompany({ record: { id: 'rec1', fields: {} }, ...ctx })
    ).rejects.toThrow(ValidationError);
  });
});

describe('handleContact', () => {
  const contactRecord = {
    id: 'recContact1',
    fields: {
      contact_id: 'CT-1',
      first_name: 'Ada',
      last_name: 'Lovelace',
      email: 'Ada.Lovelace@ACME.com',
      company_id: 'C-1',
      Company: ['recCompany1'],
    },
  };

  it('creates the contact and associates it to its company', async () => {
    const ctx = buildContext({
      Companies: [
        {
          ...COMPANY_RECORD,
          fields: { ...COMPANY_RECORD.fields, hubspot_record_id: '5000' },
        },
      ],
    });
    await ctx.client.createObject(OBJECT_TYPES.COMPANIES, { name: 'Acme Corp' });
    ctx.client.store(OBJECT_TYPES.COMPANIES).set('5000', { name: 'Acme Corp' });

    const result = await handleContact({ record: contactRecord, ...ctx });

    expect(result.action).toBe('created');
    expect(result.associatedCompanyId).toBe('5000');
    expect(
      ctx.client.hasAssociation(
        OBJECT_TYPES.CONTACTS,
        result.hubspotId,
        OBJECT_TYPES.COMPANIES,
        '5000'
      )
    ).toBe(true);
  });

  it('lower-cases the email, since it is the matching key', async () => {
    const ctx = buildContext({ Companies: [] });
    const result = await handleContact({
      record: { id: 'recContact1', fields: { email: 'Ada.Lovelace@ACME.com' } },
      ...ctx,
    });

    const stored = await ctx.client.getObject(OBJECT_TYPES.CONTACTS, result.hubspotId);
    expect(stored.properties.email).toBe('ada.lovelace@acme.com');
  });

  it('rejects a contact without a valid email', async () => {
    const ctx = buildContext();
    await expect(
      handleContact({ record: { id: 'rec1', fields: { first_name: 'Ada' } }, ...ctx })
    ).rejects.toThrow(ValidationError);
  });

  it('still saves the contact when its company cannot be resolved', async () => {
    // A missing company must not cost us the contact record.
    const ctx = buildContext({ Companies: [] });

    const result = await handleContact({
      record: { id: 'recContact1', fields: { email: 'ada@acme.com', company_id: 'nope' } },
      ...ctx,
    });

    expect(result.action).toBe('created');
    expect(result.associatedCompanyId).toBeNull();
  });
});

describe('handleDeal', () => {
  const dealRecord = {
    id: 'recDeal1',
    fields: {
      deal_id: 'D-1',
      deal_name: 'Acme Renewal',
      amount: '$12,500',
      status: 'Won',
      close_date: '09-17-2021',
      company_id: 'C-1',
      Company: ['recCompany1'],
    },
  };

  it('maps status, amount and close date onto HubSpot properties', async () => {
    const ctx = buildContext({ Companies: [] });
    const result = await handleDeal({ record: dealRecord, ...ctx });

    const stored = await ctx.client.getObject(OBJECT_TYPES.DEALS, result.hubspotId);
    expect(stored.properties).toMatchObject({
      dealname: 'Acme Renewal',
      amount: '12500',
      dealstage: 'closedwon',
      closedate: '2021-09-17',
    });
  });

  it('associates the deal to its company and not to a contact', async () => {
    const ctx = buildContext({
      Companies: [
        {
          ...COMPANY_RECORD,
          fields: { ...COMPANY_RECORD.fields, hubspot_record_id: '5000' },
        },
      ],
    });
    ctx.client.store(OBJECT_TYPES.COMPANIES).set('5000', { name: 'Acme Corp' });

    const result = await handleDeal({ record: dealRecord, ...ctx });

    expect(
      ctx.client.hasAssociation(
        OBJECT_TYPES.DEALS,
        result.hubspotId,
        OBJECT_TYPES.COMPANIES,
        '5000'
      )
    ).toBe(true);
    expect(ctx.client.associations.size).toBe(1);
  });

  it('rejects a deal with no name', async () => {
    const ctx = buildContext();
    await expect(
      handleDeal({ record: { id: 'rec1', fields: { amount: '10' } }, ...ctx })
    ).rejects.toThrow(ValidationError);
  });
});

describe('handleLineItem', () => {
  const lineItemRecord = {
    id: 'recLine1',
    fields: {
      product_name: 'Enterprise Licence',
      quantity: '3',
      unit_price: '500',
      deal_id: 'D-1',
      Deal: ['recDeal1'],
    },
  };

  const dealRow = {
    id: 'recDeal1',
    fields: { deal_id: 'D-1', deal_name: 'Acme Renewal', hubspot_record_id: '7000' },
  };

  it('creates a line item object and attaches it to the deal', async () => {
    const ctx = buildContext({ Deals: [dealRow] });
    ctx.client.store(OBJECT_TYPES.DEALS).set('7000', { dealname: 'Acme Renewal' });

    const result = await handleLineItem({ record: lineItemRecord, ...ctx });

    const stored = await ctx.client.getObject(OBJECT_TYPES.LINE_ITEMS, result.hubspotId);
    expect(stored.properties).toMatchObject({
      name: 'Enterprise Licence',
      quantity: '3',
      price: '500',
    });
    expect(
      ctx.client.hasAssociation(
        OBJECT_TYPES.LINE_ITEMS,
        result.hubspotId,
        OBJECT_TYPES.DEALS,
        '7000'
      )
    ).toBe(true);
  });

  it('does not inflate the deal amount on redelivery', async () => {
    // The previous implementation added the line total onto the deal's amount,
    // so a replayed event double-counted revenue.
    const ctx = buildContext({ Deals: [dealRow] });
    ctx.client.store(OBJECT_TYPES.DEALS).set('7000', {
      dealname: 'Acme Renewal',
      amount: '12500',
    });

    await handleLineItem({ record: lineItemRecord, ...ctx });
    await handleLineItem({ record: lineItemRecord, ...ctx });

    const deal = await ctx.client.getObject(OBJECT_TYPES.DEALS, '7000');
    expect(deal.properties.amount).toBe('12500');
    expect(ctx.client.all(OBJECT_TYPES.LINE_ITEMS)).toHaveLength(1);
  });

  it('fails loudly when the parent deal cannot be resolved', async () => {
    // Unlike a contact, a line item has nowhere to live without its deal.
    const ctx = buildContext({ Deals: [] });

    await expect(
      handleLineItem({
        record: { id: 'recLine1', fields: { product_name: 'Widget' } },
        ...ctx,
      })
    ).rejects.toThrow(MissingReferenceError);
  });

  it('rejects a line item with no product name', async () => {
    const ctx = buildContext({ Deals: [dealRow] });
    await expect(
      handleLineItem({ record: { id: 'rec1', fields: { quantity: '1' } }, ...ctx })
    ).rejects.toThrow(ValidationError);
  });
});
