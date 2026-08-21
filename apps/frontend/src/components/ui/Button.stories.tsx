import type { Meta, StoryObj } from '@storybook/react-vite';
import { Button } from './Button';

/**
 * `Button` is the action control across the whole app -- four variants and
 * two sizes, with an optional leading Material Symbols icon. Dropping
 * `children` collapses it into a square icon-only button for toolbar rows.
 */
const meta: Meta<typeof Button> = {
  title: 'UI/Button',
  component: Button,
  args: {
    children: 'Create table',
    variant: 'primary',
    size: 'md',
  },
  argTypes: {
    variant: {
      control: 'inline-radio',
      options: ['primary', 'secondary', 'ghost', 'danger'],
    },
    size: { control: 'inline-radio', options: ['sm', 'md'] },
    icon: { control: 'text' },
    fullWidth: { control: 'boolean' },
    disabled: { control: 'boolean' },
  },
};

export default meta;

type Story = StoryObj<typeof Button>;

export const Playground: Story = {
  args: { icon: 'add' },
};

export const Variants: Story = {
  render: (args) => (
    <div className="flex flex-wrap items-center gap-sm">
      <Button {...args} variant="primary" icon="add">
        Primary
      </Button>
      <Button {...args} variant="secondary" icon="download">
        Secondary
      </Button>
      <Button {...args} variant="ghost" icon="filter_list">
        Ghost
      </Button>
      <Button {...args} variant="danger" icon="delete">
        Danger
      </Button>
    </div>
  ),
};

export const Sizes: Story = {
  render: (args) => (
    <div className="flex items-center gap-sm">
      <Button {...args} size="sm">
        Small
      </Button>
      <Button {...args} size="md">
        Medium
      </Button>
    </div>
  ),
};

/** No `children` -- the button becomes a square, matching input height. */
export const IconOnly: Story = {
  render: () => (
    <div className="flex items-center gap-sm">
      <Button icon="add" aria-label="Add" />
      <Button variant="secondary" icon="more_vert" aria-label="More actions" />
      <Button variant="ghost" icon="refresh" aria-label="Refresh" />
      <Button variant="danger" icon="delete" aria-label="Delete" />
    </div>
  ),
};

export const Disabled: Story = {
  args: { disabled: true, icon: 'lock' },
};

/** Used by the login form and any sidebar-level call to action. */
export const FullWidth: Story = {
  args: { fullWidth: true, icon: 'login', children: 'Log in' },
  parameters: { layout: 'padded' },
  decorators: [
    (Story) => (
      <div className="w-80">
        <Story />
      </div>
    ),
  ],
};
