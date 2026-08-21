import type { Meta, StoryObj } from '@storybook/react-vite';
import { Select } from './Select';
import { Input } from './Input';
import { Button } from './Button';

/**
 * `Select` matches `Input`'s height and border treatment. The native chevron
 * is suppressed and redrawn as a Material Symbols glyph so the control looks
 * the same in every browser.
 */
const meta: Meta<typeof Select> = {
  title: 'UI/Select',
  component: Select,
  args: {
    label: 'Field type',
  },
  argTypes: {
    label: { control: 'text' },
    disabled: { control: 'boolean' },
  },
  parameters: { layout: 'padded' },
  decorators: [
    (Story) => (
      <div className="w-80">
        <Story />
      </div>
    ),
  ],
};

export default meta;

type Story = StoryObj<typeof Select>;

export const Playground: Story = {
  args: {
    children: (
      <>
        <option value="text">Text</option>
        <option value="number">Number</option>
        <option value="date">Date</option>
        <option value="boolean">Boolean</option>
        <option value="relation">Relation</option>
      </>
    ),
  },
};

export const WithoutLabel: Story = {
  args: {
    label: undefined,
    children: (
      <>
        <option>All modules</option>
        <option>Dynamic Tables</option>
        <option>Workflows</option>
      </>
    ),
  },
};

export const Disabled: Story = {
  args: {
    disabled: true,
    children: <option>Text</option>,
  },
};

/** Select, input and button share one baseline in a toolbar row. */
export const InToolbarRow: Story = {
  decorators: [
    (Story) => (
      <div className="w-[36rem]">
        <Story />
      </div>
    ),
  ],
  render: () => (
    <div className="flex items-end gap-sm">
      <Input icon="search" placeholder="Search..." />
      <Select>
        <option>All statuses</option>
        <option>Active</option>
        <option>Archived</option>
      </Select>
      <Button icon="filter_list" aria-label="Filter" />
    </div>
  ),
};
