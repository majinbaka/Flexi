/**
 * Tailwind theme generated from the Stitch "Flexi Low-code Design System"
 * project (projects/15220431426303664639) via the `stitch` MCP server.
 *
 * Values here are the source of truth for design decisions and mirror the
 * Stitch DESIGN.md exactly -- regenerate rather than hand-edit when the
 * Stitch design system changes, and see src/styles/tokens.css for the same
 * palette exposed as CSS custom properties.
 */
import defaultTheme from 'tailwindcss/defaultTheme';

const sansFallback = defaultTheme.fontFamily.sans;
const monoFallback = defaultTheme.fontFamily.mono;

/** JetBrains Mono is the design system's code face, so it falls back to a
 * monospace stack rather than the UI sans stack. */
const fallbackFor = (family) =>
  family === 'JetBrains Mono' ? monoFallback : sansFallback;

/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        "surface": "#faf8ff",
        "surface-dim": "#d9d9e5",
        "surface-bright": "#faf8ff",
        "surface-container-lowest": "#ffffff",
        "surface-container-low": "#f3f3fe",
        "surface-container": "#ededf9",
        "surface-container-high": "#e7e7f3",
        "surface-container-highest": "#e1e2ed",
        "on-surface": "#191b23",
        "on-surface-variant": "#434655",
        "inverse-surface": "#2e3039",
        "inverse-on-surface": "#f0f0fb",
        "outline": "#737686",
        "outline-variant": "#c3c6d7",
        "surface-tint": "#0053db",
        "primary": "#004ac6",
        "on-primary": "#ffffff",
        "primary-container": "#2563eb",
        "on-primary-container": "#eeefff",
        "inverse-primary": "#b4c5ff",
        "secondary": "#505f76",
        "on-secondary": "#ffffff",
        "secondary-container": "#d0e1fb",
        "on-secondary-container": "#54647a",
        "tertiary": "#943700",
        "on-tertiary": "#ffffff",
        "tertiary-container": "#bc4800",
        "on-tertiary-container": "#ffede6",
        "error": "#ba1a1a",
        "on-error": "#ffffff",
        "error-container": "#ffdad6",
        "on-error-container": "#93000a",
        "primary-fixed": "#dbe1ff",
        "primary-fixed-dim": "#b4c5ff",
        "on-primary-fixed": "#00174b",
        "on-primary-fixed-variant": "#003ea8",
        "secondary-fixed": "#d3e4fe",
        "secondary-fixed-dim": "#b7c8e1",
        "on-secondary-fixed": "#0b1c30",
        "on-secondary-fixed-variant": "#38485d",
        "tertiary-fixed": "#ffdbcd",
        "tertiary-fixed-dim": "#ffb596",
        "on-tertiary-fixed": "#360f00",
        "on-tertiary-fixed-variant": "#7d2d00",
        "background": "#faf8ff",
        "on-background": "#191b23",
        "surface-variant": "#e1e2ed",
      },
      spacing: {
        "base": "4px",
        "xs": "4px",
        "sm": "8px",
        "md": "16px",
        "lg": "24px",
        "xl": "32px",
        "2xl": "48px",
        "gutter": "16px",
        "margin-mobile": "16px",
        "margin-desktop": "24px",
      },
      borderRadius: {
        "sm": "0.25rem",
        "DEFAULT": "0.5rem",
        "md": "0.75rem",
        "lg": "1rem",
        "xl": "1.5rem",
        "full": "9999px",
      },
      fontFamily: {
        "display-lg": ["Inter", ...fallbackFor("Inter")],
        "display-lg-mobile": ["Inter", ...fallbackFor("Inter")],
        "headline-md": ["Inter", ...fallbackFor("Inter")],
        "body-base": ["Inter", ...fallbackFor("Inter")],
        "body-sm": ["Inter", ...fallbackFor("Inter")],
        "code-sm": ["JetBrains Mono", ...fallbackFor("JetBrains Mono")],
        "label-caps": ["Inter", ...fallbackFor("Inter")],
      },
      fontSize: {
        "display-lg": ["36px", {"lineHeight": "44px", "letterSpacing": "-0.02em", "fontWeight": "700"}],
        "display-lg-mobile": ["28px", {"lineHeight": "34px", "letterSpacing": "-0.01em", "fontWeight": "700"}],
        "headline-md": ["24px", {"lineHeight": "32px", "fontWeight": "600"}],
        "body-base": ["16px", {"lineHeight": "24px", "fontWeight": "400"}],
        "body-sm": ["14px", {"lineHeight": "20px", "fontWeight": "400"}],
        "code-sm": ["13px", {"lineHeight": "20px", "fontWeight": "400"}],
        "label-caps": ["12px", {"lineHeight": "16px", "letterSpacing": "0.05em", "fontWeight": "600"}],
      },
      maxWidth: {
        xs: '20rem',
        sm: '24rem',
        md: '28rem',
        lg: '32rem',
        xl: '36rem',
        '2xl': '42rem',
        '3xl': '48rem',
        '4xl': '56rem',
        '5xl': '64rem',
        '6xl': '72rem',
        '7xl': '80rem',
      },
    },
  },
  plugins: [],
};
