import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RequirePermissions } from '../auth/decorators/require-permissions.decorator';
import {
  DynamicTableCatalogPageDto,
  DynamicTableCatalogQueryDto,
  DynamicTableDdlJobAcceptedDto,
  DynamicTableDdlJobDto,
  DynamicTableDetailDto,
  DYNAMIC_TABLES_FIELDS_UPDATE_PERMISSION,
  DYNAMIC_TABLES_JOBS_READ_PERMISSION,
  DYNAMIC_TABLES_TABLES_CREATE_PERMISSION,
  DYNAMIC_TABLES_TABLES_READ_PERMISSION,
} from '@flexi/shared-types';
import { parseQueryNumber } from '../../common/query-number';
import { CreateTableDto } from './dto/create-table.dto';
import { UpdateFieldDto } from './dto/update-field.dto';
import { DynamicTablesService } from './dynamic-tables.service';

/**
 * CAP-1 (create table) + CAP-2 (add/remove/modify fields) API surface, plus
 * the job-status poll endpoint AD-4 requires. Every mutating route here only
 * validates and enqueues a BullMQ DDL job -- it never executes DDL itself
 * (that's `ddl-worker.ts`'s job, off the request/response path). Identifier
 * safety (`sanitizeIdentifier()`) and the `_meta_` prefix rejection both
 * happen synchronously inside `DynamicTablesService`, before any job is
 * enqueued -- a validation failure here never reaches the queue.
 *
 * First real consumer of `JwtAuthGuard` + `PermissionsGuard` +
 * `RequirePermissions` together (both guards already existed, unused in
 * combination until this story). Permission codes follow the existing
 * `<area>.<resource>.<action>` convention seeded in prisma/seed.ts
 * (`auth.me.read`, `system.me.read`).
 */
@Controller('tables')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class TablesController {
  constructor(private readonly dynamicTablesService: DynamicTablesService) {}

  @Get()
  @RequirePermissions(DYNAMIC_TABLES_TABLES_READ_PERMISSION)
  listTables(
    @Query() query: Record<string, unknown>,
  ): Promise<DynamicTableCatalogPageDto> {
    return this.dynamicTablesService.listTables(this.toCatalogQuery(query));
  }

  @Get(':tableId')
  @RequirePermissions(DYNAMIC_TABLES_TABLES_READ_PERMISSION)
  getTableDetail(
    @Param('tableId') tableId: string,
  ): Promise<DynamicTableDetailDto> {
    return this.dynamicTablesService.getTableDetail(tableId);
  }

  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  @RequirePermissions(DYNAMIC_TABLES_TABLES_CREATE_PERMISSION)
  createTable(
    @Body() dto: CreateTableDto,
  ): Promise<DynamicTableDdlJobAcceptedDto> {
    return this.dynamicTablesService.enqueueCreateTable(dto);
  }

  @Patch(':tableId/fields')
  @HttpCode(HttpStatus.ACCEPTED)
  @RequirePermissions(DYNAMIC_TABLES_FIELDS_UPDATE_PERMISSION)
  updateFields(
    @Param('tableId') tableId: string,
    @Body() dto: UpdateFieldDto,
  ): Promise<DynamicTableDdlJobAcceptedDto> {
    return this.dynamicTablesService.enqueueFieldEdit(tableId, dto);
  }

  @Get('jobs/:jobId')
  @RequirePermissions(DYNAMIC_TABLES_JOBS_READ_PERMISSION)
  getJobStatus(@Param('jobId') jobId: string): Promise<DynamicTableDdlJobDto> {
    return this.dynamicTablesService.getJobStatus(jobId);
  }

  /** Express query values are strings (or arrays); `parseQueryNumber()`
   * leaves invalid numbers as `NaN` so the service reports a validation
   * error rather than silently substituting pagination defaults -- the same
   * parser `rows.controller.ts` uses, so both paginated endpoints agree on
   * what a blank `?page=` means. */
  private toCatalogQuery(
    query: Record<string, unknown>,
  ): DynamicTableCatalogQueryDto {
    return {
      page: parseQueryNumber(query.page),
      pageSize: parseQueryNumber(query.pageSize),
    };
  }
}
