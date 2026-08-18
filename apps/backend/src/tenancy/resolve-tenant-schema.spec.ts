import { resolveTenantSchema } from './resolve-tenant-schema';

/**
 * Covers the I/O matrix's "Adversarial tenantId" and schema-resolution rows
 * from spec-schema-per-tenant-core.md. Exercised against a real Prisma cuid
 * shape (prisma/schema.prisma:199 -- Tenant.id is @default(cuid()): lowercase
 * alnum, no hyphens) rather than the source guide's UUID example -- a
 * hyphenated UUID would actually fail this same allowlist regex, since `-`
 * isn't in `\w`.
 */
describe('resolveTenantSchema', () => {
  const VALID_CUID = 'cljk3x9z10000qzrmn831p0e';

  it('returns tenant_<id> for a valid cuid tenantId, with no DB round trip', () => {
    expect(resolveTenantSchema(VALID_CUID)).toBe(`tenant_${VALID_CUID}`);
  });

  it('accepts a short/synthetic alnum id shape too', () => {
    expect(resolveTenantSchema('abc123')).toBe('tenant_abc123');
  });

  it.each([
    ['SQL statement injection', 'public; DROP TABLE'],
    ['quote-based injection', 'a" OR "1"="1'],
    ['space', 'tenant with space'],
    ['dot (schema-qualification attempt)', 'a.b'],
    ['semicolon', 'abc;'],
    [
      'hyphenated UUID shape (not a cuid, deliberately unsupported here)',
      '123e4567-e89b-12d3-a456-426614174000',
    ],
  ])('throws for adversarial/unsafe tenantId: %s', (_label, tenantId) => {
    expect(() => resolveTenantSchema(tenantId)).toThrow(
      /Refusing unsafe schema name/,
    );
  });

  it('throws for an empty tenantId rather than deriving "tenant_"', () => {
    expect(() => resolveTenantSchema('')).toThrow(
      /Refusing to resolve a schema name for an empty tenantId/,
    );
  });

  it("throws when the derived schema name would exceed Postgres's 63-byte identifier limit", () => {
    // 'tenant_'.length === 7, so 60 chars here pushes the derived schema
    // name to 67 bytes -- over the 63-byte limit Postgres silently
    // truncates at.
    const longTenantId = 'a'.repeat(60);

    expect(() => resolveTenantSchema(longTenantId)).toThrow(
      /longer than 63 bytes/,
    );
  });

  it('accepts a tenantId whose derived schema name lands exactly at the 63-byte limit', () => {
    // 'tenant_'.length === 7, so 56 chars lands the derived schema name at
    // exactly 63 bytes -- the boundary itself must still be accepted.
    const boundaryTenantId = 'a'.repeat(56);

    expect(resolveTenantSchema(boundaryTenantId)).toBe(
      `tenant_${boundaryTenantId}`,
    );
  });
});
