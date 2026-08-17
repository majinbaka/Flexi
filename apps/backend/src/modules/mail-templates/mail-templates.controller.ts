import { Controller, Get } from '@nestjs/common';
import { NotImplementedStatus } from '@flexi/shared-types';
import { MailTemplatesService } from './mail-templates.service';

/**
 * Stub controller for the "mail-templates" feature area.
 * Single placeholder route: GET /api/mail-templates -> { success:true, data:{ status:'not-implemented' } }
 * (envelope applied globally by ResponseInterceptor).
 */
@Controller('mail-templates')
export class MailTemplatesController {
  constructor(private readonly mailTemplatesService: MailTemplatesService) {}

  @Get()
  getStatus(): NotImplementedStatus {
    return this.mailTemplatesService.getStatus();
  }
}
