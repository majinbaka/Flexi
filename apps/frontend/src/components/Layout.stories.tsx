import type { Meta, StoryObj } from '@storybook/react-vite';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { Layout } from './Layout';
import { AuthProvider } from '../auth/AuthContext';

/**
 * `Layout` renders the app shell (`Sidebar` + a routed `<Outlet />`), so it
 * needs a router context to mount in isolation -- the decorator below
 * supplies a `MemoryRouter` with a routed index page standing in for
 * whatever page would normally render inside the outlet. `Sidebar` also
 * needs an `AuthProvider` (see Sidebar.stories.tsx).
 */
const meta: Meta<typeof Layout> = {
  title: 'Components/Layout',
  component: Layout,
  decorators: [
    (Story) => (
      <MemoryRouter initialEntries={['/']}>
        <AuthProvider>
          <Routes>
            <Route element={<Story />}>
              <Route index element={<p>Routed page content</p>} />
            </Route>
          </Routes>
        </AuthProvider>
      </MemoryRouter>
    ),
  ],
};

export default meta;

type Story = StoryObj<typeof Layout>;

export const Default: Story = {};
