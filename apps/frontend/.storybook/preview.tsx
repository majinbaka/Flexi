import type { Preview } from '@storybook/react-vite';
import '../src/styles/tokens.css';
import '../src/i18n';

/**
 * Global preview config. Loads the same two globals `src/main.tsx` loads for
 * the running app -- the design tokens and the i18next instance -- while the
 * webfonts they depend on come from `preview-head.html`.
 */
const preview: Preview = {
  // Opts every story into the generated Docs page (see `docs.autodocs` in
  // main.ts).
  tags: ['autodocs'],
  parameters: {
    controls: {
      matchers: {
        color: /(background|color)$/i,
        date: /Date$/i,
      },
    },
    // The design system draws components on the app background rather than
    // on white; Storybook's default white canvas misreads contrast on the
    // surface/outline colors.
    backgrounds: {
      options: {
        background: { name: 'App background', value: '#faf8ff' },
        surface: { name: 'Surface', value: '#ffffff' },
        inverse: { name: 'Inverse surface', value: '#2e3039' },
      },
    },
    layout: 'centered',
    // The shell's only breakpoint is Tailwind's `md` (768px): at and above
    // it the sidebar is a fixed rail, below it a drawer. These two presets
    // sit either side of that line so the responsive stories exercise the
    // actual switch rather than an arbitrary device size.
    viewport: {
      options: {
        mobile: {
          name: 'Mobile (below md)',
          styles: { width: '420px', height: '860px' },
          type: 'mobile',
        },
        desktop: {
          name: 'Desktop (md and up)',
          styles: { width: '1280px', height: '900px' },
          type: 'desktop',
        },
      },
    },
  },
  initialGlobals: {
    backgrounds: { value: 'background' },
  },
  decorators: [
    // Component classes reference the token font families by name; applying
    // the base body font here matches how `tokens.css` styles `body` in the
    // app, where stories mount into Storybook's own root element instead.
    (Story) => (
      <div className="font-body-base text-body-base text-on-background">
        <Story />
      </div>
    ),
  ],
};

export default preview;
