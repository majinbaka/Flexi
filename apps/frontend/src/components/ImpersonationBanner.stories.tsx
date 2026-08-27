import type { Meta, StoryObj } from '@storybook/react-vite';
import { ImpersonationBanner } from './ImpersonationBanner';
import { ApiError } from '../lib/api-client';
import { MOCK_USER, withAppContext } from '../stories/decorators';

const IMPERSONATED_USER = {
  ...MOCK_USER,
  impersonatedBy: 'sys_support',
  impersonationSessionId: 'imp_01HZX0STORYBOOK',
};

const meta: Meta<typeof ImpersonationBanner> = {
  title: 'Shell/ImpersonationBanner',
  component: ImpersonationBanner,
  parameters: { layout: 'fullscreen' },
  args: { endSession: () => Promise.resolve() },
  decorators: [
    (Story) => (
      <div className="min-h-screen bg-background p-lg">
        <p className="font-body-sm text-body-sm text-on-surface-variant">
          Page content sits above the banner, which is pinned to the bottom of
          the viewport.
        </p>
        <Story />
      </div>
    ),
  ],
};

export default meta;

type Story = StoryObj<typeof ImpersonationBanner>;

/** The flag is set on the token: the banner is present and undismissable. */
export const Impersonating: Story = {
  decorators: [withAppContext({ route: '/users', user: IMPERSONATED_USER })],
};

/** An ordinary session renders nothing at all. */
export const OrdinarySession: Story = {
  decorators: [withAppContext({ route: '/users', user: MOCK_USER })],
};

/** Exiting while the revoke call is failing still clears the local session. */
export const ExitFails: Story = {
  args: {
    endSession: () =>
      Promise.reject(new ApiError('NETWORK_ERROR', 'connection reset')),
  },
  decorators: [withAppContext({ route: '/users', user: IMPERSONATED_USER })],
};

export const MobileImpersonating: Story = {
  ...Impersonating,
  globals: { viewport: { value: 'mobile' } },
};
