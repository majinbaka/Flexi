import { Controller, Get } from '@nestjs/common';
import { NotImplementedStatus } from '@flexi/shared-types';
import { WorkflowsService } from './workflows.service';

/**
 * Stub controller for the "workflows" feature area.
 * Single placeholder route: GET /api/workflows -> { success:true, data:{ status:'not-implemented' } }
 * (envelope applied globally by ResponseInterceptor).
 */
@Controller('workflows')
export class WorkflowsController {
  constructor(private readonly workflowsService: WorkflowsService) {}

  @Get()
  getStatus(): NotImplementedStatus {
    return this.workflowsService.getStatus();
  }
}
