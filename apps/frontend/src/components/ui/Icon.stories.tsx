import type { Meta, StoryObj } from '@storybook/react-vite';
import { Icon } from './Icon';
import { MODULE_NAV_ITEMS } from '../../modules';

/**
 * `Icon` renders a Material Symbols Outlined ligature. The font is loaded in
 * `.storybook/preview-head.html` the same way `index.html` loads it for the
 * app -- if a glyph shows up as its own name in plain text, that font failed
 * to load rather than the name being wrong.
 */
const meta: Meta<typeof Icon> = {
  title: 'UI/Icon',
  component: Icon,
  args: {
    name: 'database',
    size: 24,
    filled: false,
  },
  argTypes: {
    name: { control: 'text' },
    size: { control: { type: 'range', min: 12, max: 48, step: 2 } },
    filled: { control: 'boolean' },
  },
};

export default meta;

type Story = StoryObj<typeof Icon>;

export const Playground: Story = {};

/** The four optical sizes the design system uses across components. */
export const Sizes: Story = {
  render: () => (
    <div className="flex items-end gap-md text-on-surface">
      {[14, 18, 20, 24].map((size) => (
        <div key={size} className="flex flex-col items-center gap-xs">
          <Icon name="database" size={size} />
          <span className="font-code-sm text-code-sm text-on-surface-variant">
            {size}px
          </span>
        </div>
      ))}
    </div>
  ),
};

export const OutlinedVsFilled: Story = {
  render: () => (
    <div className="flex items-center gap-lg text-on-surface">
      <div className="flex flex-col items-center gap-xs">
        <Icon name="star" size={32} />
        <span className="font-body-sm text-body-sm text-on-surface-variant">
          outlined
        </span>
      </div>
      <div className="flex flex-col items-center gap-xs">
        <Icon name="star" size={32} filled />
        <span className="font-body-sm text-body-sm text-on-surface-variant">
          filled
        </span>
      </div>
    </div>
  ),
};

/**
 * Every glyph currently in the nav vocabulary, pulled from `modules.ts` so
 * this stays in sync when a feature module is added.
 */
export const ModuleIcons: Story = {
  parameters: { layout: 'padded' },
  render: () => (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(140px,1fr))] gap-md">
      {[{ id: 'home', icon: 'home' }, ...MODULE_NAV_ITEMS].map((item) => (
        <div
          key={item.id}
          className="flex flex-col items-center gap-xs p-sm rounded bg-surface border border-outline-variant text-on-surface"
        >
          <Icon name={item.icon} size={24} />
          <span className="font-code-sm text-code-sm text-on-surface-variant">
            {item.icon}
          </span>
        </div>
      ))}
    </div>
  ),
};
