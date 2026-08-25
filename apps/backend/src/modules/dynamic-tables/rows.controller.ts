import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RequirePermissions } from '../auth/decorators/require-permissions.decorator';
import {
  DYNAMIC_TABLES_ROWS_CREATE_PERMISSION,
  DYNAMIC_TABLES_ROWS_DELETE_PERMISSION,
  DYNAMIC_TABLES_ROWS_READ_PERMISSION,
  DYNAMIC_TABLES_ROWS_UPDATE_PERMISSION,
} from '@flexi/shared-types';
import { DynamicTablesService } from './dynamic-tables.service';

/**
 * CAP-3's DML API surface: `/api/tables/:tableId/rows` (+ `/:rowId` for
 * single-row ops), per AD-6's generic metadata-resolved routing. Every
 * route here is a thin validate-and-delegate layer -- `DynamicTablesService`
 * owns identifier/table resolution (`findMetaTableOrThrow()`), the
 * generated validation schema (AD-5), and the actual DML execution via
 * `TenantKnexService.forCurrentTenant()` (AD-2: no other module/path
 * touches dynamic-table rows). Row bodies are NOT `class-validator` DTOs --
 * a dynamic table's shape is only known at runtime from its own
 * `_meta_fields` rows, so validation is driven entirely by the generated
 * per-table schema inside the service, not a static DTO class (AD-5).
 *
 * Same guard/permission pattern as `tables.controller.ts`:
 * `JwtAuthGuard` + `PermissionsGuard` + `RequirePermissions()` per route,
 * `<area>.<resource>.<action>` permission codes.
 */
@Controller('tables/:tableId/rows')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class RowsController {
  constructor(private readonly dynamicTablesService: DynamicTablesService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions(DYNAMIC_TABLES_ROWS_CREATE_PERMISSION)
  createRow(
    @Param('tableId') tableId: string,
    @Body() payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.dynamicTablesService.createRow(tableId, payload);
  }

  @Get()
  @RequirePermissions(DYNAMIC_TABLES_ROWS_READ_PERMISSION)
  listRows(
    @Param('tableId') tableId: string,
  ): Promise<Record<string, unknown>[]> {
    return this.dynamicTablesService.listRows(tableId);
  }

  @Get(':rowId')
  @RequirePermissions(DYNAMIC_TABLES_ROWS_READ_PERMISSION)
  getRow(
    @Param('tableId') tableId: string,
    @Param('rowId') rowId: string,
  ): Promise<Record<string, unknown>> {
    return this.dynamicTablesService.getRow(tableId, rowId);
  }

  @Patch(':rowId')
  @RequirePermissions(DYNAMIC_TABLES_ROWS_UPDATE_PERMISSION)
  updateRow(
    @Param('tableId') tableId: string,
    @Param('rowId') rowId: string,
    @Body() payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.dynamicTablesService.updateRow(tableId, rowId, payload);
  }

  @Delete(':rowId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions(DYNAMIC_TABLES_ROWS_DELETE_PERMISSION)
  deleteRow(
    @Param('tableId') tableId: string,
    @Param('rowId') rowId: string,
  ): Promise<void> {
    return this.dynamicTablesService.deleteRow(tableId, rowId);
  }
}
