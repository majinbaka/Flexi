import { parseQueryNumber } from './query-number';

describe('parseQueryNumber', () => {
  it('parses numeric query strings', () => {
    expect(parseQueryNumber('2')).toBe(2);
    expect(parseQueryNumber(' 25 ')).toBe(25);
    expect(parseQueryNumber('0')).toBe(0);
    expect(parseQueryNumber('-1')).toBe(-1);
  });

  it('returns undefined only when the parameter is absent', () => {
    expect(parseQueryNumber(undefined)).toBeUndefined();
    expect(parseQueryNumber([])).toBeUndefined();
  });

  it('reports blank values as NaN instead of falling back to a default', () => {
    // Issue #33: `?page=` used to mean "no value" on the table catalog and
    // "page 0" on the row list; both now surface a validation error.
    expect(parseQueryNumber('')).toBeNaN();
    expect(parseQueryNumber('   ')).toBeNaN();
  });

  it('reports non-numeric and non-string values as NaN', () => {
    expect(parseQueryNumber('not-a-number')).toBeNaN();
    expect(parseQueryNumber({ page: 2 })).toBeNaN();
    expect(parseQueryNumber(null)).toBeNaN();
  });

  it('collapses repeated query params to the first value', () => {
    expect(parseQueryNumber(['25', '100'])).toBe(25);
    expect(parseQueryNumber(['', '25'])).toBeNaN();
  });
});
