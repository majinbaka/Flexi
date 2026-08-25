import { RowsController } from './rows.controller';
import { DynamicTablesService } from './dynamic-tables.service';

/**
 * `RowsController` is a thin validate-and-delegate layer -- `DynamicTablesService`
 * owns table resolution, schema-cache lookup, and validation. These tests
 * only cover what the controller itself is responsible for: calling the
 * right service method with the right (tableId, rowId, payload) arguments
 * and returning what the service returns, matching `tables.controller.spec.ts`'s
 * style.
 */
describe('RowsController', () => {
  function buildService(): jest.Mocked<DynamicTablesService> {
    return {
      createRow: jest.fn(),
      listRows: jest.fn(),
      getRow: jest.fn(),
      updateRow: jest.fn(),
      deleteRow: jest.fn(),
    } as unknown as jest.Mocked<DynamicTablesService>;
  }

  describe('createRow', () => {
    it('delegates to DynamicTablesService.createRow with tableId + body and returns the created row', async () => {
      const service = buildService();
      const createdRow = { id: '1', title: 'hello' };
      (service.createRow as jest.Mock).mockResolvedValue(createdRow);
      const controller = new RowsController(service);

      const result = await controller.createRow('table-1', {
        title: 'hello',
      });

      expect(service.createRow).toHaveBeenCalledWith('table-1', {
        title: 'hello',
      });
      expect(result).toEqual(createdRow);
    });
  });

  describe('listRows', () => {
    it('delegates to DynamicTablesService.listRows with tableId and returns the page', async () => {
      const service = buildService();
      const page = {
        items: [{ id: '1' }, { id: '2' }],
        meta: { total: 2, page: 1, pageSize: 50 },
      };
      (service.listRows as jest.Mock).mockResolvedValue(page);
      const controller = new RowsController(service);

      const result = await controller.listRows('table-1');

      expect(service.listRows).toHaveBeenCalledWith('table-1');
      expect(result).toEqual(page);
    });

    it('passes through a relation-bearing table response shape unchanged (Story 4/CAP-4 -- resolution happens in the service, not the controller)', async () => {
      const service = buildService();
      const page = {
        items: [
          { id: '1', customer: { id: 5, name: 'Acme Corp' } },
          { id: '2', customer: null },
        ],
        meta: { total: 2, page: 1, pageSize: 50 },
      };
      (service.listRows as jest.Mock).mockResolvedValue(page);
      const controller = new RowsController(service);

      const result = await controller.listRows('table-1');

      expect(result).toEqual(page);
    });
  });

  describe('getRow', () => {
    it('delegates to DynamicTablesService.getRow with tableId + rowId', async () => {
      const service = buildService();
      const row = { id: '1' };
      (service.getRow as jest.Mock).mockResolvedValue(row);
      const controller = new RowsController(service);

      const result = await controller.getRow('table-1', 'row-1');

      expect(service.getRow).toHaveBeenCalledWith('table-1', 'row-1');
      expect(result).toEqual(row);
    });

    it('passes through a resolved relation field ({ id, ...targetRowFields } or null) unchanged (Story 4/CAP-4)', async () => {
      const service = buildService();
      const row = { id: '1', customer: { id: 5, name: 'Acme Corp' } };
      (service.getRow as jest.Mock).mockResolvedValue(row);
      const controller = new RowsController(service);

      const result = await controller.getRow('table-1', '1');

      expect(result).toEqual(row);
    });

    it('propagates a NotFoundException thrown by the service (unknown row id)', async () => {
      const service = buildService();
      (service.getRow as jest.Mock).mockRejectedValue(new Error('not found'));
      const controller = new RowsController(service);

      await expect(controller.getRow('table-1', 'missing')).rejects.toThrow();
    });
  });

  describe('updateRow', () => {
    it('delegates to DynamicTablesService.updateRow with tableId + rowId + partial body', async () => {
      const service = buildService();
      const updated = { id: '1', title: 'updated' };
      (service.updateRow as jest.Mock).mockResolvedValue(updated);
      const controller = new RowsController(service);

      const result = await controller.updateRow('table-1', 'row-1', {
        title: 'updated',
      });

      expect(service.updateRow).toHaveBeenCalledWith('table-1', 'row-1', {
        title: 'updated',
      });
      expect(result).toEqual(updated);
    });
  });

  describe('deleteRow', () => {
    it('delegates to DynamicTablesService.deleteRow with tableId + rowId', async () => {
      const service = buildService();
      (service.deleteRow as jest.Mock).mockResolvedValue(undefined);
      const controller = new RowsController(service);

      await controller.deleteRow('table-1', 'row-1');

      expect(service.deleteRow).toHaveBeenCalledWith('table-1', 'row-1');
    });
  });
});
