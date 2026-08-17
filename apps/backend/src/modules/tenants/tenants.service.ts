import { Injectable } from '@nestjs/common';
import { NotImplementedStatus } from '@flexi/shared-types';

/**
 * Stub service for the "tenants" feature area. Holds no business logic yet --
 * see deferred-work.md for the real scope of this module.
 */
@Injectable()
export class TenantsService {
  getStatus(): NotImplementedStatus {
    return { status: 'not-implemented' };
  }
}
