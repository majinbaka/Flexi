import type { Meta, StoryObj } from '@storybook/react-vite';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { Layout } from './Layout';
import { HomePage } from '../pages/HomePage';
import { PlaceholderPage } from '../pages/PlaceholderPage';
import { MockAuthProvider } from '../stories/decorators';

/**
 * `Layout` is the app shell every authenticated route renders inside:
 * `Sidebar` + `TopNav` around a routed `<Outlet />`.
 *
 * Because the page comes from the outlet rather than from props, these
 * stories mount the whole thing under a `MemoryRouter` with a real page
 * routed underneath -- a bare `<Layout />` would render an empty canvas.
 * The session comes from `MockAuthProvider` so `TopNav` shows the user
 * block (see `src/stories/decorators.tsx` for why the real provider is not
 * used here).
 */
const meta: Meta<typeof Layout> = {
  title: 'Shell/Layout',
  component: Layout,
  parameters: { layout: 'fullscreen' },
};

export default meta;

type Story = StoryObj<typeof Layout>;

/** The full shell as a signed-in user sees it on the index route. */
export const Default: Story = {
  render: () => (
    <MemoryRouter initialEntries={['/']}>
      <MockAuthProvider>
        <Routes>
          <Route element={<Layout />}>
            <Route index element={<HomePage />} />
          </Route>
        </Routes>
      </MockAuthProvider>
    </MemoryRouter>
  ),
};

/** A module route: active sidebar link and matching breadcrumb. */
export const OnModuleRoute: Story = {
  render: () => (
    <MemoryRouter initialEntries={['/dynamic-tables']}>
      <MockAuthProvider>
        <Routes>
          <Route element={<Layout />}>
            <Route
              path="/dynamic-tables"
              element={<PlaceholderPage moduleId="dynamic-tables" />}
            />
          </Route>
        </Routes>
      </MockAuthProvider>
    </MemoryRouter>
  ),
};

/**
 * Below `md` the sidebar collapses to a drawer behind the hamburger in
 * `TopNav`. Open it here to see the drawer and its dismiss scrim; `Layout`
 * owns that state, so it cannot be forced open from a prop.
 */
export const Mobile: Story = {
  ...Default,
  globals: { viewport: { value: 'mobile' } },
};
