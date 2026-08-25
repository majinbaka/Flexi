import type { Meta, StoryObj } from '@storybook/react-vite';
import { MemoryRouter } from 'react-router-dom';
import { TopNav } from './TopNav';
import { MOCK_USER, MockAuthProvider } from '../stories/decorators';

/**
 * `TopNav` is the fixed header over the content column, holding the
 * breadcrumb on the left and the session controls (language toggle, current
 * user, sign out) on the right -- these moved here from the sidebar.
 *
 * It reads the current user from the auth context. Storybook has no backend
 * to authenticate against, so these stories inject a fixed session through
 * `MockAuthProvider` (see `src/stories/decorators.tsx`) instead of running
 * the real `AuthProvider`, which would always resolve to signed out.
 *
 * Each story sets its own `MemoryRouter`/`MockAuthProvider` via `render`
 * rather than a shared meta decorator, so the route and user can vary per
 * story without nesting two routers (React Router throws on that).
 *
 * The header is inset by `md:left-64` to clear the sidebar, so on a wide
 * canvas the left gap is expected -- `Shell/Layout` shows it in context.
 */
const meta: Meta<typeof TopNav> = {
  title: 'Shell/TopNav',
  component: TopNav,
  parameters: { layout: 'fullscreen' },
  argTypes: {
    onToggleSidebar: { action: 'toggleSidebar' },
  },
};

export default meta;

type Story = StoryObj<typeof TopNav>;

/** Index route: the breadcrumb tail falls back to "Home". */
export const Default: Story = {
  render: (args) => (
    <MemoryRouter initialEntries={['/']}>
      <MockAuthProvider>
        <TopNav {...args} />
      </MockAuthProvider>
    </MemoryRouter>
  ),
};

/** On a module route the breadcrumb tail is that module's translated name. */
export const ModuleBreadcrumb: Story = {
  render: (args) => (
    <MemoryRouter initialEntries={['/mail-templates']}>
      <MockAuthProvider>
        <TopNav {...args} />
      </MockAuthProvider>
    </MemoryRouter>
  ),
};

/** No `name` on the account -- the email is shown instead. */
export const UserWithoutName: Story = {
  render: (args) => (
    <MemoryRouter initialEntries={['/']}>
      <MockAuthProvider
        user={{ ...MOCK_USER, name: null, email: 'ops@acme.example' }}
      >
        <TopNav {...args} />
      </MockAuthProvider>
    </MemoryRouter>
  ),
};

/**
 * Signed out -- the user label is dropped and only the sign-out button
 * remains. `Layout` never renders this state (the route is protected), but
 * the component handles it.
 */
export const SignedOut: Story = {
  render: (args) => (
    <MemoryRouter initialEntries={['/']}>
      <MockAuthProvider user={null}>
        <TopNav {...args} />
      </MockAuthProvider>
    </MemoryRouter>
  ),
};

/**
 * Below `md` the hamburger appears and the user label is hidden, leaving an
 * icon-only sign-out button.
 */
export const Mobile: Story = {
  ...Default,
  globals: { viewport: { value: 'mobile' } },
};
