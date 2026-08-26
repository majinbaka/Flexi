/**
 * Single parser for numeric pagination values arriving as Express query
 * strings, shared by every paginated controller so the same raw input can
 * never mean two different things on two endpoints (issue #33: `?page=`
 * silently fell back to the default on `GET /api/tables` while the parallel
 * `GET /api/tables/:tableId/rows` rejected it).
 *
 * Contract: only an absent value yields `undefined` (the caller's "apply the
 * default" signal). Anything present but unusable -- a blank/whitespace-only
 * string, a non-numeric string, or a non-string scalar such as a parsed
 * object -- yields `NaN`, so the service layer's positive-integer check
 * reports a `VALIDATION_ERROR` instead of the controller silently
 * substituting a pagination default.
 *
 * Repeated query params (`?page=1&page=2`) collapse to the first value,
 * matching how the rest of the query parsing here treats arrays.
 */
export function parseQueryNumber(value: unknown): number | undefined {
  const scalar = Array.isArray(value) ? value[0] : value;

  if (scalar === undefined) {
    return undefined;
  }
  if (typeof scalar !== 'string' || !scalar.trim()) {
    return Number.NaN;
  }

  return Number(scalar);
}
