'use strict';

const { mapCompany, mapContact, mapDeal, mapIndustry } = require('../src/migration/mappers');
const { EXTERNAL_ID_PROPERTY } = require('../src/shared/hubspotSchema');

describe('mapCompany', () => {
  const row = {
    company_id: '1',
    company_name: 'Hooli Corp',
    domain: 'hoolicorp.com',
    industry: 'Robotics',
    number_of_employees: '2011',
  };

  it('maps a well-formed row', () => {
    const { properties, error } = mapCompany(row);
    expect(error).toBeNull();
    expect(properties).toMatchObject({
      name: 'Hooli Corp',
      domain: 'hoolicorp.com',
      industry: 'MECHANICAL_OR_INDUSTRIAL_ENGINEERING',
      numberofemployees: '2011',
    });
  });

  it('stamps a namespaced external id for idempotency', () => {
    const { properties } = mapCompany(row);
    expect(properties[EXTERNAL_ID_PROPERTY]).toBe('csv:companies:1');
  });

  it('rejects a row with no name, since HubSpot requires one', () => {
    const { properties, error } = mapCompany({ ...row, company_name: '' });
    expect(properties).toBeNull();
    expect(error).toMatch(/company_name/);
  });

  it('warns but still imports when headcount is unparseable', () => {
    const { properties, warnings, error } = mapCompany({
      ...row,
      number_of_employees: 'lots',
    });
    expect(error).toBeNull();
    expect(properties.numberofemployees).toBeUndefined();
    expect(warnings.join(' ')).toMatch(/number_of_employees/);
  });
});

describe('mapIndustry', () => {
  it('maps known CSV industries onto HubSpot enumeration values', () => {
    expect(mapIndustry('Biotech')).toBe('BIOTECHNOLOGY');
    expect(mapIndustry('Food & Beverage')).toBe('FOOD_BEVERAGES');
    expect(mapIndustry('telecom')).toBe('TELECOMMUNICATIONS');
  });

  it('falls back to OTHER rather than sending a value HubSpot will reject', () => {
    expect(mapIndustry('Underwater Basket Weaving')).toBe('OTHER');
    expect(mapIndustry('')).toBe('OTHER');
  });
});

describe('mapContact', () => {
  const row = {
    contact_id: '1',
    first_name: 'Hope',
    last_name: 'Beer',
    email: 'Hope.Beer@duffworks.com',
    phone: '5550422',
    company_id: '227',
    lifecycle_stage: 'subscriber',
  };

  it('maps and normalises a well-formed row', () => {
    const { properties, error } = mapContact(row);
    expect(error).toBeNull();
    expect(properties).toMatchObject({
      firstname: 'Hope',
      lastname: 'Beer',
      email: 'hope.beer@duffworks.com',
      lifecyclestage: 'subscriber',
      [EXTERNAL_ID_PROPERTY]: 'csv:contacts:1',
    });
  });

  it('rejects a row with no usable email', () => {
    const { properties, error } = mapContact({ ...row, email: '' });
    expect(properties).toBeNull();
    expect(error).toMatch(/email/i);
  });

  it('omits an unrecognised lifecycle stage and warns', () => {
    const { properties, warnings } = mapContact({ ...row, lifecycle_stage: 'champion' });
    expect(properties.lifecyclestage).toBeUndefined();
    expect(warnings.join(' ')).toMatch(/lifecycle_stage/);
  });
});

describe('mapDeal', () => {
  const row = {
    deal_id: '1',
    deal_name: 'Meridian Dynamics Renewal',
    amount: '$48,469',
    deal_stage: 'closedlost',
    close_date: '2022-06-05',
    company_id: '184',
    contact_id: '126',
  };

  it('maps a well-formed row', () => {
    const { properties, error } = mapDeal(row);
    expect(error).toBeNull();
    expect(properties).toMatchObject({
      dealname: 'Meridian Dynamics Renewal',
      amount: '48469',
      dealstage: 'closedlost',
      closedate: '2022-06-05',
      [EXTERNAL_ID_PROPERTY]: 'csv:deals:1',
    });
  });

  // Regression test for the 20 deals HubSpot rejected in the first run.
  it('now parses the MM-DD-YYYY close dates that previously failed', () => {
    const { properties, warnings, error } = mapDeal({
      ...row,
      deal_id: '16',
      close_date: '09-17-2021',
    });
    expect(error).toBeNull();
    expect(properties.closedate).toBe('2021-09-17');
    expect(warnings).toHaveLength(0);
  });

  it('imports the deal without a close date when the date is unsalvageable', () => {
    // Degrading one property beats losing the whole record.
    const { properties, warnings, error } = mapDeal({ ...row, close_date: 'sometime soon' });
    expect(error).toBeNull();
    expect(properties.closedate).toBeUndefined();
    expect(properties.dealname).toBe('Meridian Dynamics Renewal');
    expect(warnings.join(' ')).toMatch(/close_date/);
  });

  it('rejects a row with no deal name', () => {
    const { properties, error } = mapDeal({ ...row, deal_name: '' });
    expect(properties).toBeNull();
    expect(error).toMatch(/deal_name/);
  });
});
