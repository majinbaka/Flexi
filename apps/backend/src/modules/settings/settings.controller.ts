import { Controller, Get } from '@nestjs/common';
import { NotImplementedStatus } from '@flexi/shared-types';
import { SettingsService } from './settings.service';

/**
 * Stub controller for the "settings" feature area.
 * Single placeholder route: GET /api/settings -> { success:true, data:{ status:'not-implemented' } }
 * (envelope applied globally by ResponseInterceptor).
 */
@Controller('settings')
export class SettingsController {
  constructor(private readonly settingsService: SettingsService) {}

  @Get()
  getStatus(): NotImplementedStatus {
    return this.settingsService.getStatus();
  }
}
