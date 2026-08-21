import type { Meta, StoryObj } from '@storybook/react-vite';
import { Route, Routes } from 'react-router-dom';
import { NotFoundPage } from './NotFoundPage';
import { Layout } from '../components/Layout';
import { withAppContext } from '../stories/decorators';

/**
 * The catch-all (`path="*"`) route. It renders inside the shared `Layout`
 * rather than standalone, so the navigation stays usable when a user lands
 * on an unmatched path -- see the "InAppShell" story.
 */
const meta: Meta<typeof NotFoundPage> = {
  title: 'Pages/NotFoundPage',
  component: NotFoundPage,
  parameters: { layout: 'fullscreen' },
  decorators: [withAppContext({ route: '/no-such-path' })],
};

export default meta;

type Story = StoryObj<typeof NotFoundPage>;

export const Default: Story = {
  decorators: [
    (Story) => (
      <div className="min-h-screen bg-background p-lg md:p-xl">
        <Story />
      </div>
    ),
  ],
};

/**
 * How the app actually renders it. The router comes from the meta
 * decorator -- adding another `MemoryRouter` here would nest two routers,
 * which React Router throws on.
 */
export const InAppShell: Story = {
  render: () => (
    <Routes>
      <Route element={<Layout />}>
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  ),
};
