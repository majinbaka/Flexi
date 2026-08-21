/**
 * Single choke point that turns a verified tenantId into a Postgres schema
 * name. Every dynamic-table data-access call must resolve its schema through
 * here -- never string-concatenate `tenant_${tenantId}` anywhere else.
 *
 * Postgres identifiers cannot be parameterized like query values, so the
 * only safe approach is: validate first, then use. The allowlist below is
 * applied even though `tenantId` is expected to already be a server-issued
 * Prisma cuid (see prisma/schema.prisma:199) from a verified JWT claim --
 * defense in depth against the general class of injection bug where an
 * unsanitized, tenant-controlled string reaches a `.withSchema()`-style API
 * that quotes/interpolates it into DDL or search_path without validation.
 */
const SCHEMA_NAME_PATTERN = /^[A-Za-z_][\w$]*$/;

// Postgres silently truncates identifiers longer than this (NAMEDATALEN=64,
// i.e. 63 usable bytes) instead of erroring -- without this check, two
// distinct tenantIds long enough to share the same 63-byte prefix could
// collide on the same truncated schema name with no error raised anywhere.
const MAX_SCHEMA_NAME_LENGTH = 63;

export function resolveTenantSchema(tenantId: string): string {
  if (!tenantId) {
    // This is the single choke point for schema-name safety -- don't rely
    // on every caller to have already checked truthiness before calling in.
    throw new Error('Refusing to resolve a schema name for an empty tenantId');
  }

  const schema = `tenant_${tenantId}`;

  if (!SCHEMA_NAME_PATTERN.test(schema)) {
    // Unreachable for a well-formed cuid, but fail loudly rather than let an
    // unsafe string reach Knex if that assumption is ever wrong.
    throw new Error(
      `Refusing unsafe schema name derived from tenantId: ${tenantId}`,
    );
  }

  if (schema.length > MAX_SCHEMA_NAME_LENGTH) {
    throw new Error(
      `Refusing schema name longer than ${MAX_SCHEMA_NAME_LENGTH} bytes ` +
        `(Postgres would silently truncate it, risking a cross-tenant ` +
        `collision): derived from tenantId ${tenantId}`,
    );
  }

  return schema;
}
