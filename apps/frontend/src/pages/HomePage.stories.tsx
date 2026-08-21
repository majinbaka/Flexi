import type { Meta, StoryObj } from '@storybook/react-vite';
import { Route, Routes } from 'react-router-dom';
import { HomePage } from './HomePage';
import { Layout } from '../components/Layout';
import { withAppContext } from '../stories/decorators';

/**
 * The index route: a directory of module cards, one per entry in
 * `modules.ts`, so the landing page doubles as navigation while the feature
 * areas are still stubs. Each card is a `Link`, hence the router context.
 */
const meta: Meta<typeof HomePage> = {
  title: 'Pages/HomePage',
  component: HomePage,
  parameters: { layout: 'fullscreen' },
  // Router + mock session for the whole file. Individual stories add their
  // own layout wrapper rather than the meta doing it, because the InAppShell
  // story gets its spacing from Layout itself.
  decorators: [withAppContext()],
};

export default meta;

type Story = StoryObj<typeof HomePage>;

/**
 * The page on its own, without the surrounding shell. Pages are written to
 * sit inside Layout's padded content column, so this reproduces that spacing
 * rather than letting the page sit flush against the viewport edge.
 */
export const Default: Story = {
  decorators: [
    (Story) => (
      <div className="min-h-screen bg-background p-lg md:p-xl">
        <div className="flex flex-col gap-lg">
          <Story />
        </div>
      </div>
    ),
  ],
};

export const Mobile: Story = {
  ...Default,
  globals: { viewport: { value: 'mobile' } },
};

/**
 * The same page as the app actually renders it -- routed through `Layout`,
 * which supplies the sidebar, top bar and content padding.
 *
 * The router comes from the meta decorator; adding another `MemoryRouter`
 * here would nest two routers and React Router throws on that.
 */
export const InAppShell: Story = {
  render: () => (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<HomePage />} />
      </Route>
    </Routes>
  ),
};
