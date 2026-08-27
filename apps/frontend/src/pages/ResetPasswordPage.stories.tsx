import type { Meta, StoryObj } from '@storybook/react-vite';
import { MemoryRouter } from 'react-router-dom';
import { AUTH_ERROR_CODES } from '@flexi/shared-types';
import { ApiError } from '../lib/api-client';
import { ResetPasswordPage } from './ResetPasswordPage';

const meta: Meta<typeof ResetPasswordPage> = {
  title: 'Pages/ResetPasswordPage',
  component: ResetPasswordPage,
  parameters: {
    layout: 'fullscreen',
    route: '/reset-password?email=user%40example.com',
  },
  decorators: [
    (Story, context) => (
      <MemoryRouter initialEntries={[context.parameters.route]}>
        <Story />
      </MemoryRouter>
    ),
  ],
};

export default meta;

type Story = StoryObj<typeof ResetPasswordPage>;

async function submitCode(
  canvas: Parameters<NonNullable<Story['play']>>[0]['canvas'],
  userEvent: Parameters<NonNullable<Story['play']>>[0]['userEvent'],
  password = 'Str0ng!Passphrase',
) {
  await userEvent.type(canvas.getByLabelText('Reset code'), '123456');
  await userEvent.type(canvas.getByLabelText('New password'), password);
  await userEvent.type(canvas.getByLabelText('Confirm password'), password);
  await userEvent.click(canvas.getByRole('button', { name: 'Reset password' }));
}

export const Default: Story = {
  args: { resetPassword: async () => ({}) },
};

export const Submitting: Story = {
  args: { resetPassword: () => new Promise(() => {}) },
  play: async ({ canvas, userEvent }) => {
    await submitCode(canvas, userEvent);
  },
};

export const Success: Story = {
  args: { resetPassword: async () => ({}) },
  play: async ({ canvas, userEvent }) => {
    await submitCode(canvas, userEvent);
  },
};

/**
 * One opaque message covers every cause the server collapses together --
 * wrong code, expired code, no code outstanding, unknown address, attempt
 * budget spent.
 */
export const InvalidCode: Story = {
  args: {
    resetPassword: async () => {
      throw new ApiError(AUTH_ERROR_CODES.INVALID_OTP, 'Invalid code');
    },
  },
  play: async ({ canvas, userEvent }) => {
    await submitCode(canvas, userEvent);
  },
};

/** Every unmet rule at once, rather than one per submit. */
export const WeakPassword: Story = {
  args: { resetPassword: async () => ({}) },
  play: async ({ canvas, userEvent }) => {
    await submitCode(canvas, userEvent, 'short');
  },
};
