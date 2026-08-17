import { Controller, Get } from '@nestjs/common';
import { NotImplementedStatus } from '@flexi/shared-types';
import { PagesService } from './pages.service';

/**
 * Stub controller for the "pages" feature area.
 * Single placeholder route: GET /api/pages -> { success:true, data:{ status:'not-implemented' } }
 * (envelope applied globally by ResponseInterceptor).
 */
@Controller('pages')
export class PagesController {
  constructor(private readonly pagesService: PagesService) {}

  @Get()
  getStatus(): NotImplementedStatus {
    return this.pagesService.getStatus();
  }
}
