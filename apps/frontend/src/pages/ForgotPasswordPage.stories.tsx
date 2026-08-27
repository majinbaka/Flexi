import type { Meta, StoryObj } from '@storybook/react-vite';
import { MemoryRouter } from 'react-router-dom';
import { ApiError, RATE_LIMITED_ERROR_CODE } from '../lib/api-client';
import { ForgotPasswordPage } from './ForgotPasswordPage';

const meta: Meta<typeof ForgotPasswordPage> = {
  title: 'Pages/ForgotPasswordPage',
  component: ForgotPasswordPage,
  parameters: {
    layout: 'fullscreen',
    route: '/forgot-password',
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

type Story = StoryObj<typeof ForgotPasswordPage>;

async function submitEmail(
  canvas: Parameters<NonNullable<Story['play']>>[0]['canvas'],
  userEvent: Parameters<NonNullable<Story['play']>>[0]['userEvent'],
) {
  await userEvent.type(canvas.getByLabelText('Email'), 'user@example.com');
  await userEvent.click(canvas.getByRole('button', { name: 'Send code' }));
}

export const Default: Story = {
  args: { requestPasswordReset: async () => ({}) },
};

/** Submit to observe the pending button state. */
export const Sending: Story = {
  args: { requestPasswordReset: () => new Promise(() => {}) },
  play: async ({ canvas, userEvent }) => {
    await submitEmail(canvas, userEvent);
  },
};

/**
 * The confirmation is identical whether or not the address has an account:
 * the endpoint answers 200 either way precisely so this screen cannot be
 * used to find out which addresses are registered.
 */
export const Sent: Story = {
  args: { requestPasswordReset: async () => ({}) },
  play: async ({ canvas, userEvent }) => {
    await submitEmail(canvas, userEvent);
  },
};

/** The route's own budget is 3 requests per fifteen minutes. */
export const RateLimited: Story = {
  args: {
    requestPasswordReset: async () => {
      throw new ApiError(RATE_LIMITED_ERROR_CODE, 'ThrottlerException');
    },
  },
  play: async ({ canvas, userEvent }) => {
    await submitEmail(canvas, userEvent);
  },
};

/** Arriving from a tenant login, with the tenant already known. */
export const PrefilledFromTenantLogin: Story = {
  parameters: {
    route: '/forgot-password?email=user%40example.com&tenantId=tenant_1',
  },
  args: { requestPasswordReset: async () => ({}) },
};
