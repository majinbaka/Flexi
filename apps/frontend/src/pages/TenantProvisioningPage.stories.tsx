import type { Meta, StoryObj } from '@storybook/react-vite';
import {
  ActorType,
  SYSTEM_TENANTS_READ_PERMISSION,
  type TenantOnboardingAttemptStatusDto,
} from '@flexi/shared-types';
import { TenantProvisioningPage } from './TenantProvisioningPage';
import { withAppContext } from '../stories/decorators';

const attemptBase = {
  id: 'attempt-story-progress',
  stepOutcomes: [
    {
      step: 'attempt_reservation' as const,
      status: 'succeeded' as const,
      occurredAt: '2026-08-25T08:00:00.000Z',
    },
    {
      step: 'schema_created' as const,
      status: 'succeeded' as const,
      occurredAt: '2026-08-25T08:00:02.000Z',
    },
    {
      step: 'bootstrap_migrated' as const,
      status: 'running' as const,
      occurredAt: '2026-08-25T08:00:04.000Z',
    },
  ],
  audit: null,
  createdAt: '2026-08-25T08:00:00.000Z',
  updatedAt: '2026-08-25T08:00:04.000Z',
} satisfies Omit<TenantOnboardingAttemptStatusDto, 'status'>;

const systemReader = {
  authAccountId: 'auth-story-reader',
  actorType: ActorType.SYSTEM,
  systemUserId: 'system-story-reader',
  email: 'reader@flexi.local',
  name: 'Platform Reader',
  roles: ['PlatformViewer'],
  permissions: [SYSTEM_TENANTS_READ_PERMISSION],
};

const meta: Meta<typeof TenantProvisioningPage> = {
  title: 'Pages/TenantProvisioningPage',
  component: TenantProvisioningPage,
  parameters: { layout: 'fullscreen' },
  decorators: [
    (Story) => (
      <div className="min-h-screen bg-background p-lg md:p-xl">
        <Story />
      </div>
    ),
    withAppContext({
      route: '/tenants/onboarding-attempts/attempt-story-progress',
      user: systemReader,
    }),
  ],
};

export default meta;

type Story = StoryObj<typeof TenantProvisioningPage>;

export const Provisioning: Story = {
  args: {
    initialPollDelayMs: 60_000,
    loadAttempt: async () => ({ ...attemptBase, status: 'provisioning' }),
  },
};

export const Succeeded: Story = {
  args: {
    loadAttempt: async () => ({
      ...attemptBase,
      status: 'succeeded',
      stepOutcomes: [
        ...attemptBase.stepOutcomes.slice(0, 2),
        {
          step: 'activation',
          status: 'succeeded',
          occurredAt: '2026-08-25T08:00:05.000Z',
        },
      ],
    }),
  },
};

export const Failed: Story = {
  args: {
    loadAttempt: async () => ({
      ...attemptBase,
      status: 'failed',
      stepOutcomes: [
        ...attemptBase.stepOutcomes.slice(0, 2),
        {
          step: 'bootstrap_migrated',
          status: 'failed',
          occurredAt: '2026-08-25T08:00:04.000Z',
        },
      ],
    }),
  },
};

export const NeedsManualCleanup: Story = {
  args: {
    loadAttempt: async () => ({
      ...attemptBase,
      status: 'failed-needs-manual-cleanup',
      audit: {
        finalStatus: 'failed-needs-manual-cleanup',
        recordedAt: '2026-08-25T08:00:05.000Z',
      },
    }),
  },
};
