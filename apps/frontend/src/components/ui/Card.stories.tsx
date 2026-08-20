import type { Meta, StoryObj } from '@storybook/react-vite';
import { Card } from './Card';
import { Badge } from './Badge';
import { Button } from './Button';
import { Icon } from './Icon';

/**
 * `Card` is the standard content surface: a hairline outline on the app
 * background, with only a very soft shadow. The `glass` variant is the
 * translucent panel used for toolbars floating over content -- it needs
 * something behind it to read as glass, which the story below supplies.
 */
const meta: Meta<typeof Card> = {
  title: 'UI/Card',
  component: Card,
  args: {
    variant: 'solid',
    padded: true,
  },
  argTypes: {
    variant: { control: 'inline-radio', options: ['solid', 'glass'] },
    padded: { control: 'boolean' },
  },
  parameters: { layout: 'padded' },
};

export default meta;

type Story = StoryObj<typeof Card>;

export const Playground: Story = {
  args: {
    children: (
      <p className="font-body-base text-body-base text-on-surface">
        Card content sits on the surface color with a 1px outline.
      </p>
    ),
  },
  decorators: [
    (Story) => (
      <div className="w-96">
        <Story />
      </div>
    ),
  ],
};

/** The shape used by the module directory on the home page. */
export const ModuleTile: Story = {
  render: () => (
    <div className="w-80">
      <Card className="transition-colors hover:border-primary hover:bg-surface-container-low">
        <div className="flex items-start gap-sm">
          <div className="w-10 h-10 shrink-0 rounded-lg bg-primary-fixed flex items-center justify-center text-on-primary-fixed">
            <Icon name="database" />
          </div>
          <div className="min-w-0">
            <p className="font-body-base text-body-base font-semibold text-on-surface">
              Dynamic Tables
            </p>
            <p className="font-code-sm text-code-sm text-on-surface-variant truncate">
              /dynamic-tables
            </p>
          </div>
        </div>
      </Card>
    </div>
  ),
};

export const WithHeaderAndActions: Story = {
  render: () => (
    <div className="w-[32rem]">
      <Card>
        <div className="flex items-start justify-between gap-md mb-md">
          <div>
            <p className="font-body-base text-body-base font-semibold text-on-surface">
              Customer records
            </p>
            <p className="font-body-sm text-body-sm text-on-surface-variant">
              Last synced 4 minutes ago
            </p>
          </div>
          <Badge tone="success" icon="check_circle">
            Active
          </Badge>
        </div>
        <div className="flex gap-sm">
          <Button size="sm" icon="edit">
            Edit schema
          </Button>
          <Button size="sm" variant="secondary" icon="download">
            Export
          </Button>
        </div>
      </Card>
    </div>
  ),
};

/**
 * `padded={false}` hands padding control to the child, as the login card
 * does so its inner column can use a larger inset.
 */
export const Unpadded: Story = {
  render: () => (
    <div className="w-96">
      <Card padded={false}>
        <div className="p-xl font-body-base text-body-base text-on-surface">
          The card contributes no padding -- this block owns it.
        </div>
      </Card>
    </div>
  ),
};

export const Glass: Story = {
  render: () => (
    <div className="relative w-[32rem] h-56 rounded-lg overflow-hidden bg-primary-container p-lg">
      <div
        aria-hidden="true"
        className="absolute -bottom-10 -left-10 w-64 h-64 rounded-full bg-tertiary-container opacity-60 blur-2xl"
      />
      <Card variant="glass" className="relative">
        <div className="flex items-center gap-sm">
          <Icon name="filter_list" />
          <span className="font-body-sm text-body-sm text-on-surface">
            Translucent toolbar floating over the page background
          </span>
        </div>
      </Card>
    </div>
  ),
};
