import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import {
  DYNAMIC_TABLES_ROWS_READ_PERMISSION,
  DynamicTableRowQueryDto,
} from '@flexi/shared-types';
import { PERMISSIONS_METADATA_KEY } from '../auth/decorators/require-permissions.decorator';
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
    it('exposes the rows route and requires its dedicated read permission', () => {
      expect(Reflect.getMetadata(PATH_METADATA, RowsController)).toBe(
        'tables/:tableId/rows',
      );
      expect(
        Reflect.getMetadata(PATH_METADATA, RowsController.prototype.listRows),
      ).toBe('/');
      expect(
        Reflect.getMetadata(METHOD_METADATA, RowsController.prototype.listRows),
      ).toBe(RequestMethod.GET);
      expect(
        Reflect.getMetadata(
          PERMISSIONS_METADATA_KEY,
          RowsController.prototype.listRows,
        ),
      ).toEqual([DYNAMIC_TABLES_ROWS_READ_PERMISSION]);
    });

    it('passes default pagination options through as an empty typed query', async () => {
      const service = buildService();
      const page = {
        items: [{ id: '1' }, { id: '2' }],
        meta: { total: 2, page: 1, pageSize: 50 },
      };
      (service.listRows as jest.Mock).mockResolvedValue(page);
      const controller = new RowsController(service);

      const result = await controller.listRows('table-1', {});

      expect(service.listRows).toHaveBeenCalledWith('table-1', {});
      expect(result).toEqual(page);
    });

    it('parses pagination, sort, and JSON filters into the shared row query contract', async () => {
      const service = buildService();
      const page = {
        items: [{ id: '2', amount: 42 }],
        meta: { total: 1, page: 2, pageSize: 10 },
      };
      (service.listRows as jest.Mock).mockResolvedValue(page);
      const controller = new RowsController(service);

      await expect(
        controller.listRows('table-1', {
          page: '2',
          pageSize: '10',
          sortBy: 'amount',
          sortDirection: 'desc',
          filters: '{"amount":42,"paid":true}',
        }),
      ).resolves.toEqual(page);

      const query: DynamicTableRowQueryDto = {
        page: 2,
        pageSize: 10,
        sortBy: 'amount',
        sortDirection: 'desc',
        filters: { amount: 42, paid: true },
      };
      expect(service.listRows).toHaveBeenCalledWith('table-1', query);
    });

    it.each<[Record<string, unknown>, DynamicTableRowQueryDto]>([
      [{ page: '0' }, { page: 0 }],
      [{ page: '-1' }, { page: -1 }],
      [{ page: 'not-a-number' }, { page: Number.NaN }],
      [{ page: '' }, { page: Number.NaN }],
      [{ pageSize: '   ' }, { pageSize: Number.NaN }],
      [{ pageSize: '101' }, { pageSize: 101 }],
    ])(
      'leaves invalid pagination for the service to reject: %o',
      async (rawQuery, expectedQuery) => {
        const service = buildService();
        const controller = new RowsController(service);

        await controller.listRows('table-1', rawQuery);

        expect(service.listRows).toHaveBeenCalledWith(
          'table-1',
          expect.objectContaining(expectedQuery),
        );
      },
    );

    it('rejects malformed filters before they reach the service', async () => {
      const service = buildService();
      const controller = new RowsController(service);

      expect(() =>
        controller.listRows('table-1', { filters: '{invalid-json' }),
      ).toThrow('filters must be valid JSON');
      expect(service.listRows).not.toHaveBeenCalled();
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

      const result = await controller.listRows('table-1', {});

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
