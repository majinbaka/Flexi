import type {
  DynamicTableCatalogPageDto,
  DynamicTableCatalogQueryDto,
  DynamicTableDdlJobAcceptedDto,
  DynamicTableDdlJobDto,
  DynamicTableDetailDto,
  DynamicTableRowDto,
  DynamicTableRowPageDto,
  DynamicTableRowQueryDto,
  FieldDataType,
} from '@flexi/shared-types';
import { apiDelete, apiGet, apiPatch, apiPost } from './api-client';

/** Options shared by Dynamic Tables requests, including cancellation. */
export interface DynamicTablesRequestOptions {
  signal?: AbortSignal;
}

/** Body accepted by POST /tables. Response DTOs remain in shared-types. */
export interface CreateDynamicTableRequest {
  name: string;
  description?: string;
  fields: CreateDynamicTableFieldRequest[];
}

export interface CreateDynamicTableFieldRequest {
  name: string;
  dataType: FieldDataType;
  required?: boolean;
  config?: Record<string, unknown>;
}

export type DynamicTableFieldEditRequest =
  | {
      operation: 'add';
      name: string;
      dataType: FieldDataType;
      required?: boolean;
      config?: Record<string, unknown>;
      relatedTableId?: string;
    }
  | {
      operation: 'remove';
      name: string;
    }
  | {
      operation: 'modify';
      name: string;
      dataType?: FieldDataType;
      required?: boolean;
      config?: Record<string, unknown>;
      relatedTableId?: string;
    };

export interface UpdateDynamicTableFieldsRequest {
  edits: DynamicTableFieldEditRequest[];
}

function appendQuery(
  path: string,
  query: Record<string, string | number | undefined>,
): string {
  const params = new URLSearchParams();

  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) {
      params.set(key, String(value));
    }
  }

  const queryString = params.toString();
  return queryString ? `${path}?${queryString}` : path;
}

function tablePath(tableId: string): string {
  return `/tables/${encodeURIComponent(tableId)}`;
}

function rowPath(tableId: string, rowId?: string): string {
  const path = `${tablePath(tableId)}/rows`;
  return rowId === undefined ? path : `${path}/${encodeURIComponent(rowId)}`;
}

export function listDynamicTables(
  query: DynamicTableCatalogQueryDto = {},
  options: DynamicTablesRequestOptions = {},
): Promise<DynamicTableCatalogPageDto> {
  return apiGet<DynamicTableCatalogPageDto>(
    appendQuery('/tables', {
      page: query.page,
      pageSize: query.pageSize,
    }),
    options,
  );
}

export function getDynamicTable(
  tableId: string,
  options: DynamicTablesRequestOptions = {},
): Promise<DynamicTableDetailDto> {
  return apiGet<DynamicTableDetailDto>(tablePath(tableId), options);
}

export function createDynamicTable(
  request: CreateDynamicTableRequest,
  options: DynamicTablesRequestOptions = {},
): Promise<DynamicTableDdlJobAcceptedDto> {
  return apiPost<DynamicTableDdlJobAcceptedDto>('/tables', request, options);
}

export function updateDynamicTableFields(
  tableId: string,
  request: UpdateDynamicTableFieldsRequest,
  options: DynamicTablesRequestOptions = {},
): Promise<DynamicTableDdlJobAcceptedDto> {
  return apiPatch<DynamicTableDdlJobAcceptedDto>(
    `${tablePath(tableId)}/fields`,
    request,
    options,
  );
}

export function getDynamicTableJob(
  jobId: string,
  options: DynamicTablesRequestOptions = {},
): Promise<DynamicTableDdlJobDto> {
  return apiGet<DynamicTableDdlJobDto>(
    `/tables/jobs/${encodeURIComponent(jobId)}`,
    options,
  );
}

export function listDynamicTableRows(
  tableId: string,
  query: DynamicTableRowQueryDto = {},
  options: DynamicTablesRequestOptions = {},
): Promise<DynamicTableRowPageDto> {
  return apiGet<DynamicTableRowPageDto>(
    appendQuery(rowPath(tableId), {
      page: query.page,
      pageSize: query.pageSize,
      sortBy: query.sortBy,
      sortDirection: query.sortDirection,
      filters:
        query.filters === undefined ? undefined : JSON.stringify(query.filters),
    }),
    options,
  );
}

export function getDynamicTableRow(
  tableId: string,
  rowId: string,
  options: DynamicTablesRequestOptions = {},
): Promise<DynamicTableRowDto> {
  return apiGet<DynamicTableRowDto>(rowPath(tableId, rowId), options);
}

export function createDynamicTableRow(
  tableId: string,
  payload: DynamicTableRowDto,
  options: DynamicTablesRequestOptions = {},
): Promise<DynamicTableRowDto> {
  return apiPost<DynamicTableRowDto>(rowPath(tableId), payload, options);
}

export function updateDynamicTableRow(
  tableId: string,
  rowId: string,
  payload: DynamicTableRowDto,
  options: DynamicTablesRequestOptions = {},
): Promise<DynamicTableRowDto> {
  return apiPatch<DynamicTableRowDto>(
    rowPath(tableId, rowId),
    payload,
    options,
  );
}

export function deleteDynamicTableRow(
  tableId: string,
  rowId: string,
  options: DynamicTablesRequestOptions = {},
): Promise<void> {
  return apiDelete(rowPath(tableId, rowId), options);
}
