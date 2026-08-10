'use strict';

const {
  parseDate,
  parseAmount,
  parseInteger,
  parseBoolean,
  normaliseEmail,
  normaliseDomain,
  cleanPhone,
  chunk,
  compactProperties,
} = require('../src/shared/transforms');

describe('parseDate', () => {
  it('passes through ISO dates', () => {
    expect(parseDate('2022-06-05')).toBe('2022-06-05');
  });

  it('converts slash-separated year-first dates', () => {
    expect(parseDate('2021/09/07')).toBe('2021-09-07');
  });

  it('reads slash-separated day/month dates as US month-first', () => {
    expect(parseDate('04/06/2024')).toBe('2024-04-06');
    expect(parseDate('12/31/2023')).toBe('2023-12-31');
  });

  // This is the defect that caused 20 deals to be rejected in the first
  // migration run: MM-DD-YYYY had no branch and was passed through verbatim,
  // and HubSpot rejected the record with a 400.
  it.each([
    ['09-17-2021', '2021-09-17'],
    ['08-05-2022', '2022-08-05'],
    ['12-04-2023', '2023-12-04'],
    ['01-16-2023', '2023-01-16'],
  ])('parses dash-separated MM-DD-YYYY (%s)', (input, expected) => {
    expect(parseDate(input)).toBe(expected);
  });

  it('falls back to day-first when month-first would be impossible', () => {
    // There is no 17th month, so this can only be 17 June.
    expect(parseDate('17-06-2021')).toBe('2021-06-17');
  });

  it('anchors partial month/year dates to the first of the month', () => {
    expect(parseDate('02/2024')).toBe('2024-02-01');
    expect(parseDate('11-2023')).toBe('2023-11-01');
    expect(parseDate('2023-11')).toBe('2023-11-01');
  });

  it('parses month names', () => {
    expect(parseDate('March 2022')).toBe('2022-03-01');
    expect(parseDate('Sept 2021')).toBe('2021-09-01');
  });

  it('rejects impossible calendar dates', () => {
    expect(parseDate('2021-02-30')).toBeNull();
    expect(parseDate('2021-13-01')).toBeNull();
  });

  it('returns null for empty and unparseable values', () => {
    expect(parseDate('')).toBeNull();
    expect(parseDate(null)).toBeNull();
    expect(parseDate(undefined)).toBeNull();
    expect(parseDate('not a date')).toBeNull();
  });
});

describe('parseAmount', () => {
  it('strips currency formatting', () => {
    expect(parseAmount('$48,469')).toBe(48469);
    expect(parseAmount('141994.39')).toBe(141994.39);
    expect(parseAmount('$1,234.56')).toBe(1234.56);
  });

  it('handles numbers and negatives', () => {
    expect(parseAmount(250)).toBe(250);
    expect(parseAmount('-99.5')).toBe(-99.5);
  });

  it('returns null rather than 0 when there is no value', () => {
    // The distinction matters: 0 would overwrite a real amount in HubSpot,
    // whereas null causes the property to be omitted from the update.
    expect(parseAmount('')).toBeNull();
    expect(parseAmount(null)).toBeNull();
    expect(parseAmount('n/a')).toBeNull();
  });
});

describe('parseInteger', () => {
  it('truncates toward zero', () => {
    expect(parseInteger('3684')).toBe(3684);
    expect(parseInteger('12.9')).toBe(12);
  });

  it('returns null for unusable input', () => {
    expect(parseInteger('unknown')).toBeNull();
  });
});

describe('parseBoolean', () => {
  it.each([
    ['1', true], ['True', true], ['yes', true], ['Y', true], [true, true],
    ['0', false], ['False', false], ['No', false], ['n', false], [false, false],
  ])('parses %s', (input, expected) => {
    expect(parseBoolean(input)).toBe(expected);
  });

  it('returns null for values it cannot interpret', () => {
    expect(parseBoolean('maybe')).toBeNull();
    expect(parseBoolean('')).toBeNull();
  });
});

describe('normaliseEmail', () => {
  it('lower-cases and trims', () => {
    expect(normaliseEmail('  Hope.Beer@DuffWorks.com ')).toBe('hope.beer@duffworks.com');
  });

  it('rejects values that are not addresses', () => {
    expect(normaliseEmail('not-an-email')).toBeNull();
    expect(normaliseEmail('')).toBeNull();
    expect(normaliseEmail(null)).toBeNull();
  });
});

describe('normaliseDomain', () => {
  it('reduces a URL to a bare host', () => {
    expect(normaliseDomain('https://www.acme.com/pricing')).toBe('acme.com');
    expect(normaliseDomain('HOOLICORP.COM')).toBe('hoolicorp.com');
  });

  it('returns null when empty', () => {
    expect(normaliseDomain('')).toBeNull();
  });
});

describe('cleanPhone', () => {
  it('keeps digits only', () => {
    expect(cleanPhone('+1-555-0537')).toBe('15550537');
    expect(cleanPhone('555.0611')).toBe('5550611');
  });

  it('returns null when there are no digits', () => {
    expect(cleanPhone('n/a')).toBeNull();
  });
});

describe('chunk', () => {
  it('splits into fixed-size groups', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it('returns an empty array for empty input', () => {
    expect(chunk([], 10)).toEqual([]);
  });

  it('rejects a non-positive size instead of looping forever', () => {
    expect(() => chunk([1], 0)).toThrow(RangeError);
  });
});

describe('compactProperties', () => {
  it('drops null, undefined and empty values', () => {
    // An absent source value must mean "leave the HubSpot property alone",
    // never "clear it".
    expect(
      compactProperties({ name: 'Acme', domain: null, phone: '', employees: undefined })
    ).toEqual({ name: 'Acme' });
  });

  it('stringifies numbers, and keeps zero', () => {
    expect(compactProperties({ amount: 0, quantity: 3 })).toEqual({
      amount: '0',
      quantity: '3',
    });
  });
});
