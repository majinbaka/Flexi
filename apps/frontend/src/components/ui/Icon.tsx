import type { CSSProperties } from 'react';

export interface IconProps {
  /** Material Symbols Outlined ligature name, e.g. `database`, `add_box`. */
  name: string;
  /** Optical size in px. Stitch screens use 18-24px depending on context. */
  size?: number;
  filled?: boolean;
  className?: string;
}

/**
 * Material Symbols Outlined glyph -- the icon set the Stitch designs use
 * throughout (loaded from Google Fonts in index.html).
 *
 * Size is applied as an inline font-size rather than a Tailwind class
 * because the designs use arbitrary per-instance sizes (14/18/20/24px)
 * that would otherwise each need their own utility.
 */
export function Icon({ name, size = 20, filled = false, className = '' }: IconProps) {
  const style: CSSProperties = {
    fontSize: size,
    fontVariationSettings: filled ? "'FILL' 1" : undefined,
  };

  return (
    <span
      aria-hidden="true"
      className={`material-symbols-outlined leading-none select-none ${className}`}
      style={style}
    >
      {name}
    </span>
  );
}
