import type { Meta, StoryObj } from '@storybook/react-vite';
import { Badge } from './Badge';

/**
 * `Badge` is the pill-shaped status chip. The theme defines no dedicated
 * success/warning colors, so those tones borrow the secondary and tertiary
 * ramps -- worth seeing side by side before picking one.
 */
const meta: Meta<typeof Badge> = {
  title: 'UI/Badge',
  component: Badge,
  args: {
    children: 'Not implemented',
    tone: 'neutral',
  },
  argTypes: {
    tone: {
      control: 'inline-radio',
      options: ['neutral', 'primary', 'success', 'warning', 'danger'],
    },
    icon: { control: 'text' },
  },
};

export default meta;

type Story = StoryObj<typeof Badge>;

export const Playground: Story = {
  args: { icon: 'pending' },
};

export const Tones: Story = {
  render: () => (
    <div className="flex flex-wrap items-center gap-sm">
      <Badge tone="neutral" icon="label">
        Neutral
      </Badge>
      <Badge tone="primary" icon="bolt">
        Primary
      </Badge>
      <Badge tone="success" icon="check_circle">
        Published
      </Badge>
      <Badge tone="warning" icon="pending">
        Not implemented
      </Badge>
      <Badge tone="danger" icon="error">
        Failed
      </Badge>
    </div>
  ),
};

/** Without an `icon` the chip is label-only, as used in dense table cells. */
export const WithoutIcon: Story = {
  render: () => (
    <div className="flex flex-wrap items-center gap-sm">
      <Badge tone="neutral">Draft</Badge>
      <Badge tone="success">Active</Badge>
      <Badge tone="danger">Archived</Badge>
    </div>
  ),
};
