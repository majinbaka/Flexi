import type { Meta, StoryObj } from '@storybook/react-vite';
import { TenantUserStatus } from '@flexi/shared-types';
import { AcceptInvitePage } from './AcceptInvitePage';
import { ApiError } from '../lib/api-client';
import { withAppContext } from '../stories/decorators';

const meta: Meta<typeof AcceptInvitePage> = {
  title: 'Pages/AcceptInvitePage',
  component: AcceptInvitePage,
  parameters: { layout: 'fullscreen' },
  args: {
    redeem: () =>
      Promise.resolve({
        tenantId: 'acme',
        userId: 'usr_ana',
        email: 'ana.nguyen@acme.example',
        status: TenantUserStatus.ACTIVE,
      }),
  },
  decorators: [
    withAppContext({
      route: '/accept-invite?token=storybook-token',
      user: null,
    }),
  ],
};

export default meta;

type Story = StoryObj<typeof AcceptInvitePage>;

/** The form a valid invitation link lands on. */
export const Form: Story = {};

/**
 * No token in the URL. The same screen an expired, revoked or already-used
 * invitation gets -- the backend never distinguishes them.
 */
export const NoToken: Story = {
  decorators: [withAppContext({ route: '/accept-invite', user: null })],
};

export const ExpiredToken: Story = {
  args: {
    redeem: () =>
      Promise.reject(new ApiError('INVITE_TOKEN_EXPIRED', 'not redeemable')),
  },
};

export const WeakPassword: Story = {
  args: {
    redeem: () =>
      Promise.reject(
        new ApiError(
          'PASSWORD_POLICY_VIOLATION',
          'TOO_SHORT,MISSING_UPPERCASE,MISSING_SPECIAL',
        ),
      ),
  },
};

export const Submitting: Story = {
  args: { redeem: () => new Promise(() => {}) },
};

export const MobileForm: Story = {
  ...Form,
  globals: { viewport: { value: 'mobile' } },
};
