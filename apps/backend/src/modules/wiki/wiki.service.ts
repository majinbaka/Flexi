import { Injectable } from '@nestjs/common';
import { NotImplementedStatus } from '@flexi/shared-types';

/**
 * Stub service for the "wiki" feature area. Holds no business logic yet --
 * see deferred-work.md for the real scope of this module.
 */
@Injectable()
export class WikiService {
  getStatus(): NotImplementedStatus {
    return { status: 'not-implemented' };
  }
}
