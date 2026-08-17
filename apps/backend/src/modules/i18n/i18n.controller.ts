import { Controller, Get } from '@nestjs/common';
import { NotImplementedStatus } from '@flexi/shared-types';
import { I18nService } from './i18n.service';

/**
 * Stub controller for the "i18n" feature area.
 * Single placeholder route: GET /api/i18n -> { success:true, data:{ status:'not-implemented' } }
 * (envelope applied globally by ResponseInterceptor).
 */
@Controller('i18n')
export class I18nController {
  constructor(private readonly i18nService: I18nService) {}

  @Get()
  getStatus(): NotImplementedStatus {
    return this.i18nService.getStatus();
  }
}
