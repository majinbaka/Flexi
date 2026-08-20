import type { Meta, StoryObj } from '@storybook/react-vite';
import { MemoryRouter } from 'react-router-dom';
import { Sidebar } from './Sidebar';
import { MockAuthProvider } from '../stories/decorators';

/**
 * `Sidebar` is the fixed 256px navigation rail: brand block plus one link
 * per feature module. It needs a router context for `NavLink` and i18next,
 * which `.storybook/preview.tsx` initializes globally the same way
 * `src/main.tsx` does for the app.
 *
 * Session controls no longer live here -- they moved to `TopNav` -- so this
 * component reads nothing from the auth context; `MockAuthProvider` is only
 * present because `withAppContext`-style stories elsewhere in this app
 * assume it, and future sidebar content may end up depending on it too.
 *
 * Note the rail is `position: fixed`, so it pins to the preview viewport
 * rather than flowing inside the story canvas. Each story below sets its
 * own `MemoryRouter` (via `render`) rather than a shared meta decorator, so
 * the active route can vary per story without nesting two routers.
 */
const meta: Meta<typeof Sidebar> = {
  title: 'Shell/Sidebar',
  component: Sidebar,
  parameters: { layout: 'fullscreen' },
  args: {
    open: true,
  },
  argTypes: {
    open: { control: 'boolean' },
    onNavigate: { action: 'navigate' },
  },
};

export default meta;

type Story = StoryObj<typeof Sidebar>;

/** At `md` and up the rail is always visible, whatever `open` says. */
export const Default: Story = {
  render: (args) => (
    <MemoryRouter initialEntries={['/']}>
      <MockAuthProvider>
        <Sidebar {...args} />
      </MockAuthProvider>
    </MemoryRouter>
  ),
};

/**
 * `dynamic-tables` is the current route, so its link takes the active
 * treatment (filled secondary container, semibold).
 */
export const ActiveModuleLink: Story = {
  render: (args) => (
    <MemoryRouter initialEntries={['/dynamic-tables']}>
      <MockAuthProvider>
        <Sidebar {...args} />
      </MockAuthProvider>
    </MemoryRouter>
  ),
};

/**
 * Below `md` the rail is an off-canvas drawer. In a narrow viewport this
 * story is slid out of frame; `Layout`'s "Mobile" story shows the opened
 * state together with its scrim.
 */
export const MobileClosed: Story = {
  ...Default,
  args: { open: false },
  globals: { viewport: { value: 'mobile' } },
};

export const MobileOpen: Story = {
  ...Default,
  args: { open: true },
  globals: { viewport: { value: 'mobile' } },
};
