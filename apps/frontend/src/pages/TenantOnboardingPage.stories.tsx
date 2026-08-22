import type { Meta, StoryObj } from '@storybook/react-vite';
import { ActorType } from '@flexi/shared-types';
import { ApiError } from '../lib/api-client';
import { TenantOnboardingPage } from './TenantOnboardingPage';
import {
  MOCK_SYSTEM_USER_WITHOUT_TENANT_ONBOARD,
  MOCK_SYSTEM_USER_WITH_TENANT_ONBOARD,
  MOCK_USER,
  withAppContext,
} from '../stories/decorators';

const meta: Meta<typeof TenantOnboardingPage> = {
  title: 'Pages/TenantOnboardingPage',
  component: TenantOnboardingPage,
  parameters: { layout: 'fullscreen' },
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

export default meta;

type Story = StoryObj<typeof TenantOnboardingPage>;

const attemptBase = {
  id: 'attempt-story-created',
  status: 'accepted' as const,
  safePayload: {
    tenantName: 'Acme Co',
    tenantSlug: 'acme-co',
    firstAdminEmail: 'admin@acme.example',
    plan: 'growth' as const,
  },
  actorIdentity: {
    actorType: ActorType.SYSTEM as ActorType.SYSTEM,
    authAccountId: 'auth-story',
    systemUserId: 'system-story',
    email: 'ops@flexi.local',
    name: 'Ops',
    roles: ['PlatformAdmin'],
    permissions: ['system.tenants.onboard'],
  },
  requestIdentity: {
    requestId: 'request-story',
    ipAddress: '127.0.0.1',
    userAgent: 'storybook',
  },
  idempotencyIdentity: {
    key: 'tenant-onboard:storybook',
    source: 'header' as const,
  },
  stepOutcomes: [
    {
      step: 'permission_check' as const,
      status: 'succeeded' as const,
      occurredAt: '2026-08-21T08:00:00.000Z',
    },
    {
      step: 'payload_validation' as const,
      status: 'succeeded' as const,
      occurredAt: '2026-08-21T08:00:00.000Z',
    },
    {
      step: 'slug_availability' as const,
      status: 'succeeded' as const,
      occurredAt: '2026-08-21T08:00:00.000Z',
    },
    {
      step: 'attempt_reservation' as const,
      status: 'succeeded' as const,
      occurredAt: '2026-08-21T08:00:00.000Z',
    },
  ],
  createdAt: '2026-08-21T08:00:00.000Z',
  updatedAt: '2026-08-21T08:00:00.000Z',
};

const permittedDecorator = withAppContext({
  route: '/tenants/onboard',
  user: MOCK_SYSTEM_USER_WITH_TENANT_ONBOARD,
});

export const PermittedSystemUser: Story = {
  decorators: [permittedDecorator],
};

export const InteractivePreflight: Story = {
  args: {
    preflightDelayMs: 0,
    checkSlugAvailability: async (slug) => ({
      slug,
      available: slug !== 'taken-slug',
      reason: slug === 'taken-slug' ? 'already_in_use' : 'available',
    }),
  },
  decorators: [permittedDecorator],
};

export const CreateSuccess: Story = {
  args: {
    preflightDelayMs: 0,
    checkSlugAvailability: async (slug) => ({
      slug,
      available: true,
      reason: 'available',
    }),
    createOnboardingAttempt: async (request) => ({
      ...attemptBase,
      safePayload: request,
      idempotencyOutcome: {
        replayed: false,
      },
    }),
  },
  decorators: [permittedDecorator],
};

export const IdempotentReplay: Story = {
  args: {
    preflightDelayMs: 0,
    checkSlugAvailability: async (slug) => ({
      slug,
      available: true,
      reason: 'available',
    }),
    createOnboardingAttempt: async (request) => ({
      ...attemptBase,
      id: 'attempt-story-replayed',
      safePayload: request,
      idempotencyOutcome: {
        replayed: true,
        existingAttemptId: 'attempt-story-replayed',
      },
    }),
  },
  decorators: [permittedDecorator],
};

export const IdempotencyConflict: Story = {
  args: {
    preflightDelayMs: 0,
    checkSlugAvailability: async (slug) => ({
      slug,
      available: true,
      reason: 'available',
    }),
    createOnboardingAttempt: async () => {
      throw new ApiError(
        'IDEMPOTENCY_CONFLICT',
        'Idempotency key has already been used for a different onboarding payload.',
        'attempt-story-existing',
      );
    },
  },
  decorators: [permittedDecorator],
};

export const UnpermittedSystemUser: Story = {
  decorators: [
    withAppContext({
      route: '/tenants/onboard',
      user: MOCK_SYSTEM_USER_WITHOUT_TENANT_ONBOARD,
    }),
  ],
};

export const TenantUser: Story = {
  decorators: [
    withAppContext({
      route: '/tenants/onboard',
      user: MOCK_USER,
    }),
  ],
};

export const MobileDenied: Story = {
  ...TenantUser,
  globals: { viewport: { value: 'mobile' } },
};
