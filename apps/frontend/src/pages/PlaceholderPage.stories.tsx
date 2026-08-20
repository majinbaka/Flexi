import type { Meta, StoryObj } from '@storybook/react-vite';
import { FEATURE_MODULES } from '@flexi/shared-types';
import { PlaceholderPage } from './PlaceholderPage';
import { withAppContext } from '../stories/decorators';

/**
 * Rendered once per feature-area route (see `router.tsx`). It mirrors the
 * backend stubs' `{ status: 'not-implemented' }` response and has no data
 * fetching -- the only thing that varies between the 11 instances is
 * `moduleId`, which drives the title, icon and body copy.
 */
const meta: Meta<typeof PlaceholderPage> = {
  title: 'Pages/PlaceholderPage',
  component: PlaceholderPage,
  parameters: { layout: 'fullscreen' },
  args: {
    moduleId: 'dynamic-tables',
  },
  argTypes: {
    moduleId: {
      control: 'select',
      options: FEATURE_MODULES,
    },
  },
  decorators: [
    withAppContext(),
    (Story) => (
      <div className="min-h-screen bg-background p-lg md:p-xl">
        <div className="flex flex-col gap-lg">
          <Story />
        </div>
      </div>
    ),
  ],
};

export default meta;

type Story = StoryObj<typeof PlaceholderPage>;

/** Switch `moduleId` in the controls panel to see any of the 11 modules. */
export const Playground: Story = {};

export const Workflows: Story = {
  args: { moduleId: 'workflows' },
};

export const Mobile: Story = {
  globals: { viewport: { value: 'mobile' } },
};
