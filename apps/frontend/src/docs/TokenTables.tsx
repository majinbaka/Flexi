import { theme } from './theme';

/**
 * Swatch/scale renderers for the Design Tokens docs page.
 *
 * Values are read straight out of `tailwind.config.js` rather than restated
 * here, so regenerating the theme from Stitch updates this page too instead
 * of leaving a second copy of the palette to drift.
 */

const { colors, spacing, fontSize, fontFamily } = theme;
const radii = theme.borderRadius;

/** Rough relative luminance, only to pick black or white label text. */
function readableTextOn(hex: string): string {
  const value = hex.replace('#', '');
  const [r, g, b] = [0, 2, 4].map(
    (i) => parseInt(value.slice(i, i + 2), 16) / 255,
  );
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return luminance > 0.6 ? '#191b23' : '#ffffff';
}

export function ColorRow({ names }: { names: string[] }) {
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-sm my-md">
      {names.map((name) => {
        const hex = colors[name];
        return (
          <div
            key={name}
            className="rounded border border-outline-variant overflow-hidden"
          >
            <div
              className="h-16 flex items-end p-xs"
              style={{ background: hex, color: readableTextOn(hex) }}
            >
              <span className="font-code-sm text-code-sm">{hex}</span>
            </div>
            <div className="p-xs bg-surface">
              <code className="font-code-sm text-code-sm text-on-surface">
                {name}
              </code>
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function TypeScale() {
  return (
    <div className="flex flex-col gap-md my-md">
      {Object.entries(fontSize).map(([name, [size, meta]]) => (
        <div
          key={name}
          className="flex flex-col gap-xs pb-md border-b border-outline-variant last:border-b-0"
        >
          <code className="font-code-sm text-code-sm text-on-surface-variant">
            font-{name} text-{name} &middot; {size}/{meta.lineHeight} &middot;
            weight {meta.fontWeight}
            {meta.letterSpacing ? ` · tracking ${meta.letterSpacing}` : ''}
          </code>
          <span
            className="text-on-surface"
            style={{
              fontFamily: fontFamily[name].join(', '),
              fontSize: size,
              lineHeight: meta.lineHeight,
              fontWeight: Number(meta.fontWeight),
              letterSpacing: meta.letterSpacing,
            }}
          >
            The quick brown fox jumps over the lazy dog
          </span>
        </div>
      ))}
    </div>
  );
}

export function SpacingScale() {
  // `base` and the two `margin-*` aliases duplicate values already listed,
  // so the visual scale shows the xs..2xl ramp only.
  const steps = ['xs', 'sm', 'md', 'lg', 'xl', '2xl'];

  return (
    <div className="flex flex-col gap-sm my-md">
      {steps.map((name) => (
        <div key={name} className="flex items-center gap-md">
          <code className="font-code-sm text-code-sm text-on-surface-variant w-24 shrink-0">
            {name}
          </code>
          <div
            className="h-4 rounded-sm bg-primary-fixed-dim"
            style={{ width: spacing[name] }}
          />
          <span className="font-code-sm text-code-sm text-on-surface-variant">
            {spacing[name]}
          </span>
        </div>
      ))}
    </div>
  );
}

export function RadiusScale() {
  return (
    <div className="flex flex-wrap gap-md my-md">
      {Object.entries(radii).map(([name, value]) => (
        <div key={name} className="flex flex-col items-center gap-xs">
          <div
            className="w-20 h-20 bg-surface border border-outline-variant"
            style={{ borderRadius: value }}
          />
          <code className="font-code-sm text-code-sm text-on-surface-variant">
            {name === 'DEFAULT' ? 'rounded' : `rounded-${name}`}
          </code>
          <span className="font-code-sm text-code-sm text-outline">
            {value}
          </span>
        </div>
      ))}
    </div>
  );
}
