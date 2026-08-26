import { Injectable } from '@nestjs/common';
import { NotImplementedStatus } from '@flexi/shared-types';

/**
 * Stub service for the "pages" feature area. Holds no business logic yet --
 * see the specs under apps/frontend/src/docs/specifications/ for the
 * real scope of this module.
 */
@Injectable()
export class PagesService {
  getStatus(): NotImplementedStatus {
    return { status: 'not-implemented' };
  }
}
