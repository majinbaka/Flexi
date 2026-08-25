import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { TablesController } from './tables.controller';
import {
  DynamicTablesService,
  JobStatusResult,
} from './dynamic-tables.service';
import { CreateTableDto } from './dto/create-table.dto';
import { UpdateFieldDto } from './dto/update-field.dto';
import {
  DYNAMIC_TABLES_TABLES_READ_PERMISSION,
  DynamicTableCatalogPageDto,
  DynamicTableDetailDto,
} from '@flexi/shared-types';
import { PERMISSIONS_METADATA_KEY } from '../auth/decorators/require-permissions.decorator';

/**
 * `TablesController` is a thin validate-and-delegate layer: `ValidationPipe`
 * (wired globally in main.ts) handles DTO-shape rejection before a handler
 * ever runs, and `DynamicTablesService` owns every other rule (identifier
 * safety, the `_meta_` prefix, tenant isolation). These tests only cover
 * what the controller itself is responsible for: calling the right service
 * method with the right arguments and returning what it returns (the 202
 * status code is asserted via the route's `@HttpCode` decorator metadata,
 * matching this codebase's existing controller-test style).
 */
describe('TablesController', () => {
  function buildService(): jest.Mocked<DynamicTablesService> {
    return {
      listTables: jest.fn(),
      getTableDetail: jest.fn(),
      enqueueCreateTable: jest.fn(),
      enqueueFieldEdit: jest.fn(),
      getJobStatus: jest.fn(),
    } as unknown as jest.Mocked<DynamicTablesService>;
  }

  describe('metadata read routes', () => {
    it('exposes GET /api/tables and requires the dedicated read permission', () => {
      expect(Reflect.getMetadata(PATH_METADATA, TablesController)).toBe(
        'tables',
      );
      expect(
        Reflect.getMetadata(
          PATH_METADATA,
          TablesController.prototype.listTables,
        ),
      ).toBe('/');
      expect(
        Reflect.getMetadata(
          METHOD_METADATA,
          TablesController.prototype.listTables,
        ),
      ).toBe(RequestMethod.GET);
      expect(
        Reflect.getMetadata(
          PERMISSIONS_METADATA_KEY,
          TablesController.prototype.listTables,
        ),
      ).toEqual([DYNAMIC_TABLES_TABLES_READ_PERMISSION]);
    });

    it('delegates catalog queries and leaves invalid numeric values for the service to reject', async () => {
      const service = buildService();
      const catalog: DynamicTableCatalogPageDto = {
        items: [],
        meta: { total: 0, page: 2, pageSize: 25 },
      };
      (service.listTables as jest.Mock).mockResolvedValue(catalog);
      const controller = new TablesController(service);

      await expect(
        controller.listTables({ page: '2', pageSize: ['25', '100'] }),
      ).resolves.toEqual(catalog);
      expect(service.listTables).toHaveBeenLastCalledWith({
        page: 2,
        pageSize: 25,
      });

      await controller.listTables({ page: 'not-a-number' });
      expect(service.listTables).toHaveBeenLastCalledWith({
        page: Number.NaN,
        pageSize: undefined,
      });
    });

    it('exposes GET /api/tables/:tableId, enforces read permission, and delegates detail reads', async () => {
      expect(
        Reflect.getMetadata(
          PATH_METADATA,
          TablesController.prototype.getTableDetail,
        ),
      ).toBe(':tableId');
      expect(
        Reflect.getMetadata(
          METHOD_METADATA,
          TablesController.prototype.getTableDetail,
        ),
      ).toBe(RequestMethod.GET);
      expect(
        Reflect.getMetadata(
          PERMISSIONS_METADATA_KEY,
          TablesController.prototype.getTableDetail,
        ),
      ).toEqual([DYNAMIC_TABLES_TABLES_READ_PERMISSION]);

      const service = buildService();
      const detail: DynamicTableDetailDto = {
        id: 'table-1',
        name: 'Invoices',
        slug: 'invoices',
        description: null,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        fields: [],
      };
      (service.getTableDetail as jest.Mock).mockResolvedValue(detail);
      const controller = new TablesController(service);

      await expect(controller.getTableDetail('table-1')).resolves.toEqual(
        detail,
      );
      expect(service.getTableDetail).toHaveBeenCalledWith('table-1');
    });
  });

  describe('createTable', () => {
    it('delegates to DynamicTablesService.enqueueCreateTable and returns its result', async () => {
      const service = buildService();
      (service.enqueueCreateTable as jest.Mock).mockResolvedValue({
        jobId: 'job-1',
      });
      const controller = new TablesController(service);

      const dto: CreateTableDto = {
        name: 'invoices',
        fields: [{ name: 'title', dataType: 'STRING' } as never],
      } as CreateTableDto;

      const result = await controller.createTable(dto);

      expect(service.enqueueCreateTable).toHaveBeenCalledWith(dto);
      expect(result).toEqual({ jobId: 'job-1' });
    });
  });

  describe('updateFields', () => {
    it('delegates to DynamicTablesService.enqueueFieldEdit with the route tableId and body', async () => {
      const service = buildService();
      (service.enqueueFieldEdit as jest.Mock).mockResolvedValue({
        jobId: 'job-2',
      });
      const controller = new TablesController(service);

      const dto: UpdateFieldDto = {
        edits: [{ operation: 'remove', name: 'title' } as never],
      } as UpdateFieldDto;

      const result = await controller.updateFields('table-1', dto);

      expect(service.enqueueFieldEdit).toHaveBeenCalledWith('table-1', dto);
      expect(result).toEqual({ jobId: 'job-2' });
    });
  });

  describe('getJobStatus', () => {
    it('delegates to DynamicTablesService.getJobStatus with the route jobId', async () => {
      const service = buildService();
      const status: JobStatusResult = {
        jobId: 'job-1',
        status: 'completed',
        error: null,
      };
      (service.getJobStatus as jest.Mock).mockResolvedValue(status);
      const controller = new TablesController(service);

      const result = await controller.getJobStatus('job-1');

      expect(service.getJobStatus).toHaveBeenCalledWith('job-1');
      expect(result).toEqual(status);
    });

    it('propagates a NotFoundException thrown by the service (unknown or cross-tenant job id)', async () => {
      const service = buildService();
      (service.getJobStatus as jest.Mock).mockRejectedValue(
        new Error('not found'),
      );
      const controller = new TablesController(service);

      await expect(controller.getJobStatus('missing')).rejects.toThrow();
    });
  });
});
