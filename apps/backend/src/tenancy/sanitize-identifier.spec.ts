import { sanitizeIdentifier } from './sanitize-identifier';

/**
 * Covers the I/O & Edge-Case Matrix rows for `sanitizeIdentifier()` from
 * spec-dynamic-table-builder's Story 1: valid identifier, injection attempt,
 * over-length, boundary-length, and the reserved-`_meta_`-prefix pass-through
 * (character-safety only -- the `_meta_` business rule itself belongs to
 * Story 2's CAP-1, not this function).
 */
describe('sanitizeIdentifier', () => {
  it('returns a valid identifier unchanged', () => {
    expect(sanitizeIdentifier('my_table_1')).toBe('my_table_1');
  });

  it.each([
    ['SQL injection attempt', 'a"; DROP TABLE users; --'],
    ['space', 'my table'],
    ['dot', 'a.b'],
    ['semicolon', 'abc;'],
    ['leading digit', '1abc'],
    ['hyphen', 'my-table'],
  ])('throws for adversarial/unsafe identifier: %s', (_label, name) => {
    expect(() => sanitizeIdentifier(name)).toThrow(
      /Refusing unsafe identifier/,
    );
  });

  it('throws for an empty identifier', () => {
    expect(() => sanitizeIdentifier('')).toThrow(
      /Refusing to sanitize an empty identifier/,
    );
  });

  it('throws for an identifier exceeding 63 bytes (NAMEDATALEN cap)', () => {
    const overLength = 'a'.repeat(64);

    expect(() => sanitizeIdentifier(overLength)).toThrow(
      /longer than 63 bytes/,
    );
  });

  it('accepts an identifier exactly at the 63-byte boundary', () => {
    const boundary = 'a'.repeat(63);

    expect(sanitizeIdentifier(boundary)).toBe(boundary);
  });

  it('returns a reserved `_meta_`-prefixed identifier unchanged (character-safety only; the prefix-reservation business rule is enforced elsewhere, by Story 2 CAP-1)', () => {
    expect(sanitizeIdentifier('_meta_tables')).toBe('_meta_tables');
  });
});
