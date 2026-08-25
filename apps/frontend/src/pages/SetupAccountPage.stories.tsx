import type { Meta, StoryObj } from '@storybook/react-vite';
import { MemoryRouter } from 'react-router-dom';
import { ApiError } from '../lib/api-client';
import { SetupAccountPage } from './SetupAccountPage';

const meta: Meta<typeof SetupAccountPage> = {
  title: 'Pages/SetupAccountPage',
  component: SetupAccountPage,
  parameters: {
    layout: 'fullscreen',
    setupRoute: '/setup-account?token=story-token',
  },
  decorators: [
    (Story, context) => (
      <MemoryRouter initialEntries={[context.parameters.setupRoute]}>
        <Story />
      </MemoryRouter>
    ),
  ],
};

export default meta;

type Story = StoryObj<typeof SetupAccountPage>;

async function submitPassword(
  canvas: Parameters<NonNullable<Story['play']>>[0]['canvas'],
  userEvent: Parameters<NonNullable<Story['play']>>[0]['userEvent'],
) {
  const passwordInputs = canvas.getAllByLabelText('Password');
  await userEvent.type(passwordInputs[0], 'story-password');
  await userEvent.type(
    canvas.getByLabelText('Confirm password'),
    'story-password',
  );
  await userEvent.click(canvas.getByRole('button', { name: 'Set password' }));
}

/** The normal public form; its token is intentionally never displayed. */
export const Default: Story = {
  args: { redeemSetupToken: async () => ({ status: 'completed' }) },
};

/** Submit the form to observe the pending button state. */
export const Loading: Story = {
  args: { redeemSetupToken: () => new Promise(() => {}) },
  play: async ({ canvas, userEvent }) => {
    await submitPassword(canvas, userEvent);
  },
};

/** Submit the form to observe the completion confirmation and login link. */
export const Success: Story = {
  args: { redeemSetupToken: async () => ({ status: 'completed' }) },
  play: async ({ canvas, userEvent }) => {
    await submitPassword(canvas, userEvent);
  },
};

/** Submit the form to observe the opaque expired/invalid-link state. */
export const Expired: Story = {
  args: {
    redeemSetupToken: async () => {
      throw new ApiError('INVALID_SETUP_TOKEN', 'Invalid setup token');
    },
  },
  play: async ({ canvas, userEvent }) => {
    await submitPassword(canvas, userEvent);
  },
};

/** Submit the form to observe a non-sensitive provider/network failure. */
export const GenericError: Story = {
  args: {
    redeemSetupToken: async () => {
      throw new ApiError('NETWORK_ERROR', 'Request failed');
    },
  },
  play: async ({ canvas, userEvent }) => {
    await submitPassword(canvas, userEvent);
  },
};

export const MissingToken: Story = {
  parameters: { setupRoute: '/setup-account' },
};
