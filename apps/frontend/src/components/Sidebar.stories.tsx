import type { Meta, StoryObj } from '@storybook/react-vite';
import { MemoryRouter } from 'react-router-dom';
import { Sidebar } from './Sidebar';
import { AuthProvider } from '../auth/AuthContext';

/**
 * `Sidebar` uses `NavLink` (needs a router context), `useTranslation`
 * (needs i18next initialized), and `useAuth` (needs an `AuthProvider`
 * for the current-user display + Logout button). The router context is
 * supplied here via `MemoryRouter`; i18n is initialized globally in
 * `.storybook/preview.ts`, the same way `src/main.tsx` initializes it
 * for the running app. `AuthProvider`'s boot-time silent refresh is a
 * no-op here since Storybook's localStorage has no stored refresh token.
 */
const meta: Meta<typeof Sidebar> = {
  title: 'Components/Sidebar',
  component: Sidebar,
  decorators: [
    (Story) => (
      <MemoryRouter initialEntries={['/']}>
        <AuthProvider>
          <Story />
        </AuthProvider>
      </MemoryRouter>
    ),
  ],
};

export default meta;

type Story = StoryObj<typeof Sidebar>;

export const Default: Story = {};
