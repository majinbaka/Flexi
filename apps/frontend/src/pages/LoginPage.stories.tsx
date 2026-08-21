import type { Meta, StoryObj } from '@storybook/react-vite';
import { MemoryRouter } from 'react-router-dom';
import { LoginPage } from './LoginPage';
import { MockAuthProvider } from '../stories/decorators';

/**
 * Tenant login (`/login`) -- the only unauthenticated screen, so it renders
 * outside `Layout` on its own full-bleed background with a soft primary
 * wash behind the card.
 *
 * These stories force the signed-out session: with a token present the page
 * immediately redirects to `/`, so a "logged in" story would render nothing.
 * Submitting the form calls the backend, which is not running behind
 * Storybook -- the mock provider's `login` resolves without a request, so
 * the button just settles back from its loading state.
 */
const meta: Meta<typeof LoginPage> = {
  title: 'Pages/LoginPage',
  component: LoginPage,
  parameters: { layout: 'fullscreen' },
  decorators: [
    (Story) => (
      <MemoryRouter initialEntries={['/login']}>
        <MockAuthProvider user={null}>
          <Story />
        </MockAuthProvider>
      </MemoryRouter>
    ),
  ],
};

export default meta;

type Story = StoryObj<typeof LoginPage>;

export const Default: Story = {};

export const Mobile: Story = {
  globals: { viewport: { value: 'mobile' } },
};
