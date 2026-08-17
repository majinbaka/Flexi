import { Controller, Get } from '@nestjs/common';
import { NotImplementedStatus } from '@flexi/shared-types';
import { TenantsService } from './tenants.service';

/**
 * Stub controller for the "tenants" feature area.
 * Single placeholder route: GET /api/tenants -> { success:true, data:{ status:'not-implemented' } }
 * (envelope applied globally by ResponseInterceptor).
 */
@Controller('tenants')
export class TenantsController {
  constructor(private readonly tenantsService: TenantsService) {}

  @Get()
  getStatus(): NotImplementedStatus {
    return this.tenantsService.getStatus();
  }
}
