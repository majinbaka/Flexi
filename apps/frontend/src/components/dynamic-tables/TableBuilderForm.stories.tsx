import type { Meta, StoryObj } from '@storybook/react-vite';
import { TableBuilderForm } from './TableBuilderForm';
import { withAppContext } from '../../stories/decorators';

const meta: Meta<typeof TableBuilderForm> = {
  title: 'Components/DynamicTables/TableBuilderForm',
  component: TableBuilderForm,
  decorators: [
    withAppContext({ route: '/dynamic-tables' }),
    (Story) => (
      <div className="max-w-4xl bg-background p-lg md:p-xl">
        <Story />
      </div>
    ),
  ],
};

export default meta;

type Story = StoryObj<typeof TableBuilderForm>;

export const Default: Story = {
  args: {
    createTable: () => Promise.resolve({ jobId: 'ddl-story-1' }),
    getJob: () =>
      Promise.resolve({
        jobId: 'ddl-story-1',
        status: 'completed',
        error: null,
      }),
  },
};

export const Submitting: Story = {
  args: {
    createTable: () => new Promise(() => {}),
    getJob: () =>
      Promise.resolve({
        jobId: 'ddl-story-1',
        status: 'pending',
        error: null,
      }),
  },
};

export const JobFailure: Story = {
  args: {
    createTable: () => Promise.resolve({ jobId: 'ddl-story-failed' }),
    getJob: () =>
      Promise.resolve({
        jobId: 'ddl-story-failed',
        status: 'failed',
        error: 'Internal DDL details are deliberately not displayed.',
      }),
  },
};
