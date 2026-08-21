import { BadRequestException } from '@nestjs/common';
import { validateTenantOnboardingInput } from '@flexi/shared-types';
import { TenantsService } from './tenants.service';

describe('TenantsService', () => {
  function buildPrisma(existingTenant: { id: string } | null = null) {
    return {
      tenant: {
        findUnique: jest.fn().mockResolvedValue(existingTenant),
        create: jest.fn(),
        update: jest.fn(),
      },
    };
  }

  it('returns available for a valid unused slug without creating tenant state', async () => {
    const prisma = buildPrisma();
    const service = new TenantsService(prisma as never);

    await expect(service.checkSlugAvailability('acme-co')).resolves.toEqual({
      slug: 'acme-co',
      available: true,
      reason: 'available',
    });

    expect(prisma.tenant.findUnique).toHaveBeenCalledWith({
      where: { slug: 'acme-co' },
      select: { id: true },
    });
    expect(prisma.tenant.create).not.toHaveBeenCalled();
    expect(prisma.tenant.update).not.toHaveBeenCalled();
  });

  it('returns a safe conflict state for an existing slug', async () => {
    const prisma = buildPrisma({ id: 'tenant-1' });
    const service = new TenantsService(prisma as never);

    await expect(service.checkSlugAvailability('demo')).resolves.toEqual({
      slug: 'demo',
      available: false,
      reason: 'already_in_use',
    });

    expect(prisma.tenant.findUnique).toHaveBeenCalledWith({
      where: { slug: 'demo' },
      select: { id: true },
    });
    expect(prisma.tenant.create).not.toHaveBeenCalled();
    expect(prisma.tenant.update).not.toHaveBeenCalled();
  });

  it.each(['Acme', 'acme co', 'acme_co', '-acme', 'acme-', 'acme--co', 'ab'])(
    'rejects invalid slug format %s before querying Prisma',
    async (slug) => {
      const prisma = buildPrisma();
      const service = new TenantsService(prisma as never);

      await expect(service.checkSlugAvailability(slug)).rejects.toThrow(
        BadRequestException,
      );
      expect(prisma.tenant.findUnique).not.toHaveBeenCalled();
      expect(prisma.tenant.create).not.toHaveBeenCalled();
    },
  );

  it('validates required onboarding fields before submit is available', () => {
    expect(
      validateTenantOnboardingInput({
        tenantName: '',
        tenantSlug: '',
        firstAdminEmail: '',
        plan: '',
      }),
    ).toEqual({
      tenantName: 'TENANT_NAME_REQUIRED',
      tenantSlug: 'SLUG_REQUIRED',
      firstAdminEmail: 'EMAIL_REQUIRED',
      plan: 'PLAN_REQUIRED',
    });
  });

  it('validates onboarding email, slug, and plan formats before preflight', () => {
    expect(
      validateTenantOnboardingInput({
        tenantName: 'Acme Co',
        tenantSlug: 'Acme Co',
        firstAdminEmail: 'not-an-email',
        plan: 'unknown',
      }),
    ).toEqual({
      tenantSlug: 'SLUG_FORMAT',
      firstAdminEmail: 'EMAIL_FORMAT',
      plan: 'PLAN_REQUIRED',
    });
  });

  it('accepts valid onboarding field values', () => {
    expect(
      validateTenantOnboardingInput({
        tenantName: 'Acme Co',
        tenantSlug: 'acme-co',
        firstAdminEmail: 'admin@acme.example',
        plan: 'growth',
      }),
    ).toEqual({});
  });
});
