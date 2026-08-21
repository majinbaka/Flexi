import type { Meta, StoryObj } from '@storybook/react-vite';
import { PageHeader } from './PageHeader';
import { Button } from './Button';
import { Badge } from './Badge';

/**
 * `PageHeader` opens every content page: display heading, supporting line,
 * and an optional right-aligned action cluster that wraps below the text on
 * narrow viewports.
 */
const meta: Meta<typeof PageHeader> = {
  title: 'UI/PageHeader',
  component: PageHeader,
  args: {
    title: 'Dynamic Tables',
    description: 'Define tables and fields without writing migrations.',
  },
  argTypes: {
    title: { control: 'text' },
    description: { control: 'text' },
  },
  parameters: { layout: 'padded' },
  decorators: [
    (Story) => (
      <div className="w-[48rem] max-w-full">
        <Story />
      </div>
    ),
  ],
};

export default meta;

type Story = StoryObj<typeof PageHeader>;

export const Playground: Story = {};

export const TitleOnly: Story = {
  args: { description: undefined },
};

export const WithActions: Story = {
  args: {
    actions: (
      <>
        <Button variant="secondary" icon="download">
          Export
        </Button>
        <Button icon="add">New table</Button>
      </>
    ),
  },
};

/** How the placeholder pages use it -- a status chip as the sole action. */
export const WithStatusBadge: Story = {
  args: {
    title: 'Workflows',
    description: 'The "Workflows" feature area is scaffolded but has no functionality yet.',
    actions: (
      <Badge tone="warning" icon="pending">
        Not implemented
      </Badge>
    ),
  },
};
