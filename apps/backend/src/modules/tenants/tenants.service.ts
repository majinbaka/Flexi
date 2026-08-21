import { BadRequestException, Injectable } from '@nestjs/common';
import {
  isTenantSlugFormatValid,
  NotImplementedStatus,
  TenantSlugAvailabilityDto,
} from '@flexi/shared-types';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Stub service for the "tenants" feature area. Holds no business logic yet --
 * see deferred-work.md for the real scope of this module.
 */
@Injectable()
export class TenantsService {
  constructor(private readonly prisma: PrismaService) {}

  getStatus(): NotImplementedStatus {
    return { status: 'not-implemented' };
  }

  async checkSlugAvailability(
    slug: string,
  ): Promise<TenantSlugAvailabilityDto> {
    const normalizedSlug = slug.trim();

    if (!isTenantSlugFormatValid(normalizedSlug)) {
      throw new BadRequestException({
        error: 'VALIDATION_ERROR',
        message:
          'Slug must be 3-63 characters using lowercase letters, numbers, and single hyphens, and must start and end with a letter or number.',
      });
    }

    const existingTenant = await this.prisma.tenant.findUnique({
      where: { slug: normalizedSlug },
      select: { id: true },
    });

    if (existingTenant) {
      return {
        slug: normalizedSlug,
        available: false,
        reason: 'already_in_use',
      };
    }

    return {
      slug: normalizedSlug,
      available: true,
      reason: 'available',
    };
  }
}
