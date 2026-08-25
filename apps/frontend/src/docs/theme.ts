// @ts-expect-error -- tailwind.config.js is plain JS (it is regenerated from
// the Stitch design system, so it stays JS) and sits outside tsconfig's
// `include`, so it carries no declarations. This module is the single place
// that untyped import happens; everything downstream uses the types below.
import tailwindConfig from '../../tailwind.config.js';

export interface FontSizeOptions {
  lineHeight: string;
  letterSpacing?: string;
  fontWeight: string;
}

export interface DesignTheme {
  colors: Record<string, string>;
  spacing: Record<string, string>;
  borderRadius: Record<string, string>;
  fontFamily: Record<string, string[]>;
  fontSize: Record<string, [string, FontSizeOptions]>;
}

/**
 * The generated Tailwind theme, read at its source so the Design Tokens docs
 * page renders the real values rather than a second copy that can drift.
 */
export const theme = (tailwindConfig as { theme: { extend: DesignTheme } })
  .theme.extend;
