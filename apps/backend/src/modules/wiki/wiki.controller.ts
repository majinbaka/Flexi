import { Controller, Get } from '@nestjs/common';
import { NotImplementedStatus } from '@flexi/shared-types';
import { WikiService } from './wiki.service';

/**
 * Stub controller for the "wiki" feature area.
 * Single placeholder route: GET /api/wiki -> { success:true, data:{ status:'not-implemented' } }
 * (envelope applied globally by ResponseInterceptor).
 */
@Controller('wiki')
export class WikiController {
  constructor(private readonly wikiService: WikiService) {}

  @Get()
  getStatus(): NotImplementedStatus {
    return this.wikiService.getStatus();
  }
}
