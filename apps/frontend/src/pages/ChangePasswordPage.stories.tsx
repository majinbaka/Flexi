import type { Meta, StoryObj } from '@storybook/react-vite';
import { MemoryRouter } from 'react-router-dom';
import { ApiError } from '../lib/api-client';
import { MockAuthProvider, MOCK_USER } from '../stories/decorators';
import { ChangePasswordPage } from './ChangePasswordPage';

const meta: Meta<typeof ChangePasswordPage> = {
  title: 'Pages/ChangePasswordPage',
  component: ChangePasswordPage,
  parameters: {
    layout: 'fullscreen',
    mustChangePassword: false,
  },
  decorators: [
    (Story, context) => (
      <MemoryRouter initialEntries={['/change-password']}>
        <MockAuthProvider
          user={{
            ...MOCK_USER,
            mustChangePassword: Boolean(context.parameters.mustChangePassword),
          }}
        >
          <Story />
        </MockAuthProvider>
      </MemoryRouter>
    ),
  ],
};

export default meta;

type Story = StoryObj<typeof ChangePasswordPage>;

async function submitChange(
  canvas: Parameters<NonNullable<Story['play']>>[0]['canvas'],
  userEvent: Parameters<NonNullable<Story['play']>>[0]['userEvent'],
  password = 'Str0ng!Passphrase',
) {
  await userEvent.type(canvas.getByLabelText('Current password'), 'old-secret');
  await userEvent.type(canvas.getByLabelText('New password'), password);
  await userEvent.type(canvas.getByLabelText('Confirm password'), password);
  await userEvent.click(
    canvas.getByRole('button', { name: 'Change password' }),
  );
}

/** Somebody changing their password of their own accord. */
export const Default: Story = {
  args: { changePassword: async () => ({}) },
};

/**
 * The destination ProtectedRoute forces a holder under an admin
 * force-reset to, which is why the copy explains itself rather than
 * reading like a settings page they wandered into.
 */
export const ForcedByAdminReset: Story = {
  parameters: { mustChangePassword: true },
  args: { changePassword: async () => ({}) },
};

export const Submitting: Story = {
  args: { changePassword: () => new Promise(() => {}) },
  play: async ({ canvas, userEvent }) => {
    await submitChange(canvas, userEvent);
  },
};

export const WrongCurrentPassword: Story = {
  args: {
    changePassword: async () => {
      throw new ApiError('INVALID_CREDENTIALS', 'Invalid email or password');
    },
  },
  play: async ({ canvas, userEvent }) => {
    await submitChange(canvas, userEvent);
  },
};

export const WeakPassword: Story = {
  args: { changePassword: async () => ({}) },
  play: async ({ canvas, userEvent }) => {
    await submitChange(canvas, userEvent, 'short');
  },
};
