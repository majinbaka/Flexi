/**
 * Single choke point for validating user-supplied Postgres table/column
 * identifiers (dynamic-table names, field/column names) before they can
 * reach any DDL/DML string. This is deliberately separate from
 * `resolveTenantSchema()` (same directory): that function validates
 * *schema* names derived from a trusted, server-issued tenantId; this one
 * validates *table/column* names supplied directly by a tenant admin
 * through the API, which is a different trust boundary even though the
 * safety rule (character allowlist + length cap) is identical.
 *
 * Postgres identifiers cannot be parameterized like query values, so the
 * only safe approach is: validate first, then use. No second,
 * independently-written identifier sanitizer should exist anywhere in the
 * DynamicTables module (AD-3) -- every table/column name validation call
 * goes through this function.
 */
const IDENTIFIER_PATTERN = /^[A-Za-z_][\w$]*$/;

// Postgres silently truncates identifiers longer than this (NAMEDATALEN=64,
// i.e. 63 usable bytes) instead of erroring -- without this check, two
// distinct user-supplied names long enough to share the same 63-byte prefix
// could collide on the same truncated column/table name with no error
// raised anywhere.
const MAX_IDENTIFIER_LENGTH = 63;

export function sanitizeIdentifier(name: string): string {
  if (!name) {
    // Single choke point for identifier safety -- don't rely on every
    // caller to have already checked truthiness before calling in.
    throw new Error('Refusing to sanitize an empty identifier');
  }

  if (!IDENTIFIER_PATTERN.test(name)) {
    throw new Error(`Refusing unsafe identifier: ${name}`);
  }

  if (name.length > MAX_IDENTIFIER_LENGTH) {
    throw new Error(
      `Refusing identifier longer than ${MAX_IDENTIFIER_LENGTH} bytes ` +
        `(Postgres would silently truncate it, risking a collision): ${name}`,
    );
  }

  return name;
}
