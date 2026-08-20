import type { Meta, StoryObj } from '@storybook/react-vite';
import { MemoryRouter } from 'react-router-dom';
import { AdminLoginPage } from './AdminLoginPage';
import { MockAuthProvider } from '../stories/decorators';

/**
 * System Admin login (`/admin/login`) -- same unauthenticated full-bleed
 * layout as the tenant LoginPage, minus the Tenant ID field.
 *
 * These stories force the signed-out session: with a token present the page
 * immediately redirects to `/`, so a "logged in" story would render nothing.
 * Submitting the form calls the backend, which is not running behind
 * Storybook -- the mock provider's `login` resolves without a request, so
 * the button just settles back from its loading state.
 */
const meta: Meta<typeof AdminLoginPage> = {
  title: 'Pages/AdminLoginPage',
  component: AdminLoginPage,
  parameters: { layout: 'fullscreen' },
  decorators: [
    (Story) => (
      <MemoryRouter initialEntries={['/admin/login']}>
        <MockAuthProvider user={null}>
          <Story />
        </MockAuthProvider>
      </MemoryRouter>
    ),
  ],
};

export default meta;

type Story = StoryObj<typeof AdminLoginPage>;

export const Default: Story = {};

export const Mobile: Story = {
  globals: { viewport: { value: 'mobile' } },
};
