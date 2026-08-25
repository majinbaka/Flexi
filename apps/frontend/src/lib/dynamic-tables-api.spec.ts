import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FieldDataType } from '@flexi/shared-types';
import { ApiError, setAccessToken, setStoredRefreshToken } from './api-client';
import {
  createDynamicTable,
  createDynamicTableRow,
  deleteDynamicTableRow,
  getDynamicTable,
  getDynamicTableJob,
  getDynamicTableRow,
  listDynamicTableRows,
  listDynamicTables,
  updateDynamicTableFields,
  updateDynamicTableRow,
} from './dynamic-tables-api';

const API_BASE_URL = 'http://localhost:3000/api';

function createStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value),
  };
}

function success(data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ success: true, data, error: null }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function failure(status: number, code: string, message: string): Response {
  return new Response(
    JSON.stringify({ success: false, data: null, error: { code, message } }),
    { status, headers: { 'Content-Type': 'application/json' } },
  );
}

describe('dynamic-tables API adapter', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', createStorage());
    setAccessToken(null);
    setStoredRefreshToken(null);
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('unwraps the catalog envelope and serializes catalog pagination', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      success({
        items: [{ id: 'table-1', name: 'Orders', slug: 'orders' }],
        meta: { total: 1, page: 2, pageSize: 10 },
      }),
    );

    await expect(listDynamicTables({ page: 2, pageSize: 10 })).resolves.toEqual(
      expect.objectContaining({ meta: { total: 1, page: 2, pageSize: 10 } }),
    );

    expect(fetch).toHaveBeenCalledWith(
      `${API_BASE_URL}/tables?page=2&pageSize=10`,
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('uses the typed catalog, create, field-edit, and job endpoints', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(
        success({ id: 'table-1', name: 'Orders', fields: [] }),
      )
      .mockResolvedValueOnce(success({ jobId: 'create-job' }, 202))
      .mockResolvedValueOnce(success({ jobId: 'fields-job' }, 202))
      .mockResolvedValueOnce(
        success({ jobId: 'fields-job', status: 'completed', error: null }),
      );

    await getDynamicTable('table-1');
    await createDynamicTable({
      name: 'Orders',
      fields: [{ name: 'total', dataType: FieldDataType.NUMBER }],
    });
    await updateDynamicTableFields('table-1', {
      edits: [{ operation: 'remove', name: 'obsolete' }],
    });
    await getDynamicTableJob('fields-job');

    expect(
      fetchMock.mock.calls.map(([url, init]) => [
        String(url),
        init?.method,
        init?.body,
      ]),
    ).toEqual([
      [`${API_BASE_URL}/tables/table-1`, 'GET', undefined],
      [
        `${API_BASE_URL}/tables`,
        'POST',
        JSON.stringify({
          name: 'Orders',
          fields: [{ name: 'total', dataType: FieldDataType.NUMBER }],
        }),
      ],
      [
        `${API_BASE_URL}/tables/table-1/fields`,
        'PATCH',
        JSON.stringify({ edits: [{ operation: 'remove', name: 'obsolete' }] }),
      ],
      [`${API_BASE_URL}/tables/jobs/fields-job`, 'GET', undefined],
    ]);
  });

  it('serializes row query parameters and routes all row mutations', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(
        success({ items: [{ id: 'row-1', total: 42 }], meta: {} }),
      )
      .mockResolvedValueOnce(success({ id: 'row-1', total: 42 }))
      .mockResolvedValueOnce(success({ id: 'row-2', total: 55 }, 201))
      .mockResolvedValueOnce(success({ id: 'row-2', total: 60 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    await listDynamicTableRows('orders/main', {
      page: 1,
      pageSize: 25,
      sortBy: 'total',
      sortDirection: 'desc',
      filters: { paid: false, total: 42 },
    });
    await getDynamicTableRow('orders/main', 'row one');
    await createDynamicTableRow('orders/main', { total: 55 });
    await updateDynamicTableRow('orders/main', 'row-2', { total: 60 });
    await expect(
      deleteDynamicTableRow('orders/main', 'row-2'),
    ).resolves.toBeUndefined();

    expect(
      fetchMock.mock.calls.map(([url, init]) => [
        String(url),
        init?.method,
        init?.body,
      ]),
    ).toEqual([
      [
        `${API_BASE_URL}/tables/orders%2Fmain/rows?page=1&pageSize=25&sortBy=total&sortDirection=desc&filters=%7B%22paid%22%3Afalse%2C%22total%22%3A42%7D`,
        'GET',
        undefined,
      ],
      [`${API_BASE_URL}/tables/orders%2Fmain/rows/row%20one`, 'GET', undefined],
      [
        `${API_BASE_URL}/tables/orders%2Fmain/rows`,
        'POST',
        JSON.stringify({ total: 55 }),
      ],
      [
        `${API_BASE_URL}/tables/orders%2Fmain/rows/row-2`,
        'PATCH',
        JSON.stringify({ total: 60 }),
      ],
      [`${API_BASE_URL}/tables/orders%2Fmain/rows/row-2`, 'DELETE', undefined],
    ]);
  });

  it('surfaces backend envelope errors as ApiError', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      failure(403, 'FORBIDDEN', 'Missing Dynamic Tables permission'),
    );

    try {
      await getDynamicTable('table-1');
      expect.unreachable('The backend error envelope must reject.');
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect(error).toMatchObject({
        code: 'FORBIDDEN',
        message: 'Missing Dynamic Tables permission',
      });
    }
  });

  it('forwards an abort signal to the underlying request', async () => {
    const controller = new AbortController();
    vi.mocked(fetch).mockResolvedValueOnce(success({ items: [], meta: {} }));

    await listDynamicTables({}, { signal: controller.signal });

    expect(fetch).toHaveBeenCalledWith(
      `${API_BASE_URL}/tables`,
      expect.objectContaining({ signal: controller.signal }),
    );
  });
});
