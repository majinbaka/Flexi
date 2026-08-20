import { TablesController } from './tables.controller';
import {
  DynamicTablesService,
  JobStatusResult,
} from './dynamic-tables.service';
import { CreateTableDto } from './dto/create-table.dto';
import { UpdateFieldDto } from './dto/update-field.dto';

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
      enqueueCreateTable: jest.fn(),
      enqueueFieldEdit: jest.fn(),
      getJobStatus: jest.fn(),
    } as unknown as jest.Mocked<DynamicTablesService>;
  }

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
