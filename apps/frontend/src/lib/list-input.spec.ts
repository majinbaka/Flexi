import { describe, expect, it } from 'vitest';
import { parseDomainList, parseEmailList } from './list-input';

describe('parseEmailList', () => {
  it('splits on commas, semicolons, newlines and stray whitespace', () => {
    expect(
      parseEmailList(
        'ana@acme.test, ben@acme.test; cleo@acme.test\ndee@acme.test',
      ),
    ).toEqual([
      'ana@acme.test',
      'ben@acme.test',
      'cleo@acme.test',
      'dee@acme.test',
    ]);
  });

  it('lowercases and collapses duplicates that differ only in case', () => {
    expect(parseEmailList('Ana@Acme.test, ana@acme.test')).toEqual([
      'ana@acme.test',
    ]);
  });

  it('yields nothing for an empty or separator-only string', () => {
    expect(parseEmailList('')).toEqual([]);
    expect(parseEmailList('  ,;\n ')).toEqual([]);
  });
});

describe('parseDomainList', () => {
  it('strips a leading @ and lowercases', () => {
    expect(parseDomainList('@ACME.com, Partner.IO')).toEqual([
      'acme.com',
      'partner.io',
    ]);
  });

  it('collapses a domain listed both with and without the @', () => {
    expect(parseDomainList('@acme.com, acme.com')).toEqual(['acme.com']);
  });

  it('yields nothing for an empty string, which means "any domain"', () => {
    expect(parseDomainList('')).toEqual([]);
  });
});
