/**
 * Turning one free-text box into a list of values.
 *
 * Commas, semicolons and newlines all separate, because all three are what
 * a spreadsheet column or a mail client's recipient list turns into on the
 * clipboard. Both parsers de-duplicate rather than reporting a repeat: the
 * invite batch is all-or-nothing and a domain whitelist is a set, so
 * refusing either over a value the operator listed twice would be
 * pedantry.
 *
 * They live here rather than beside the forms that use them so those files
 * export components only -- which is what keeps fast refresh working (see
 * `react-refresh/only-export-components`).
 */

const SEPARATORS = /[\s,;]+/;

function parseUnique(
  raw: string,
  normalise: (value: string) => string,
): string[] {
  const seen = new Set<string>();

  for (const candidate of raw.split(SEPARATORS)) {
    const value = normalise(candidate.trim());
    if (value) seen.add(value);
  }

  return [...seen];
}

/** Addresses, lowercased. Validity is checked by the caller and the server. */
export function parseEmailList(raw: string): string[] {
  return parseUnique(raw, (value) => value.toLowerCase());
}

/**
 * Bare domains, lowercased and without the `@`. The backend stores them
 * that way, so the same normalisation happens here rather than letting the
 * two representations diverge in the field.
 */
export function parseDomainList(raw: string): string[] {
  return parseUnique(raw, (value) => value.toLowerCase().replace(/^@/, ''));
}
