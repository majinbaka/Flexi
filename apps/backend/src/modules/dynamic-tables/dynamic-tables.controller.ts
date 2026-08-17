import { Controller, Get } from '@nestjs/common';
import { NotImplementedStatus } from '@flexi/shared-types';
import { DynamicTablesService } from './dynamic-tables.service';

/**
 * Stub controller for the "dynamic-tables" feature area.
 * Single placeholder route: GET /api/dynamic-tables -> { success:true, data:{ status:'not-implemented' } }
 * (envelope applied globally by ResponseInterceptor).
 */
@Controller('dynamic-tables')
export class DynamicTablesController {
  constructor(private readonly dynamicTablesService: DynamicTablesService) {}

  @Get()
  getStatus(): NotImplementedStatus {
    return this.dynamicTablesService.getStatus();
  }
}
