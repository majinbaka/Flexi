import type { Meta, StoryObj } from '@storybook/react-vite';
import { MemoryRouter } from 'react-router-dom';
import { Sidebar } from './Sidebar';

/**
 * `Sidebar` uses `NavLink` (needs a router context) and `useTranslation`
 * (needs i18next initialized). The router context is supplied here via
 * `MemoryRouter`; i18n is initialized globally in `.storybook/preview.ts`,
 * the same way `src/main.tsx` initializes it for the running app.
 */
const meta: Meta<typeof Sidebar> = {
  title: 'Components/Sidebar',
  component: Sidebar,
  decorators: [
    (Story) => (
      <MemoryRouter initialEntries={['/']}>
        <Story />
      </MemoryRouter>
    ),
  ],
};

export default meta;

type Story = StoryObj<typeof Sidebar>;

export const Default: Story = {};
