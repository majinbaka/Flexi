import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type {
  DynamicTableCatalogItemDto,
  DynamicTableCatalogPageDto,
  DynamicTableCatalogQueryDto,
} from '@flexi/shared-types';
import { DYNAMIC_TABLES_TABLES_CREATE_PERMISSION } from '@flexi/shared-types';
import { useAuth } from '../auth/AuthContext';
import {
  Button,
  Card,
  PageHeader,
  Table,
  type TableColumn,
} from '../components/ui';
import { listDynamicTables } from '../lib/dynamic-tables-api';

const DEFAULT_PAGE_SIZE = 20;

type CatalogState =
  | { status: 'loading' }
  | { status: 'error' }
  | {
      status: 'ready';
      items: DynamicTableCatalogItemDto[];
      total: number;
      page: number;
      pageSize: number;
    };

export interface DynamicTablesPageProps {
  fetchTables?: (
    query: DynamicTableCatalogQueryDto,
    signal?: AbortSignal,
  ) => Promise<DynamicTableCatalogPageDto>;
}

function defaultFetchTables(
  query: DynamicTableCatalogQueryDto,
  signal?: AbortSignal,
): Promise<DynamicTableCatalogPageDto> {
  return listDynamicTables(query, { signal });
}

function tableColumns(
  t: (key: string) => string,
  onOpenDetail: (table: DynamicTableCatalogItemDto) => void,
  onOpenRows: (table: DynamicTableCatalogItemDto) => void,
): TableColumn<DynamicTableCatalogItemDto>[] {
  return [
    {
      id: 'name',
      header: t('dynamicTables.table.name'),
      cell: (table) => table.name,
    },
    {
      id: 'slug',
      header: t('dynamicTables.table.slug'),
      cell: (table) => (
        <span className="font-code-sm text-code-sm">{table.slug}</span>
      ),
    },
    {
      id: 'description',
      header: t('dynamicTables.table.description'),
      cell: (table) =>
        table.description ?? t('dynamicTables.table.placeholder'),
    },
    {
      id: 'updatedAt',
      header: t('dynamicTables.table.updatedAt'),
      cell: (table) => new Date(table.updatedAt).toLocaleDateString(),
    },
    {
      id: 'actions',
      header: t('dynamicTables.table.actions'),
      align: 'right',
      cell: (table) => (
        <div className="flex justify-end gap-xs">
          <Button
            variant="ghost"
            size="sm"
            onClick={(event) => {
              event.stopPropagation();
              onOpenDetail(table);
            }}
          >
            {t('dynamicTables.actions.open')}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={(event) => {
              event.stopPropagation();
              onOpenRows(table);
            }}
          >
            {t('dynamicTables.actions.rows')}
          </Button>
        </div>
      ),
    },
  ];
}

/**
 * Tenant-scoped catalog for the metadata read API. Detail, builder, and row
 * routes are intentionally separate screens so their forms can own mutation
 * and polling state without making this inventory request long-lived.
 */
export function DynamicTablesPage({
  fetchTables = defaultFetchTables,
}: DynamicTablesPageProps = {}) {
  const { t } = useTranslation();
  const { currentUser } = useAuth();
  const navigate = useNavigate();
  const [page, setPage] = useState(1);
  const [reloadKey, setReloadKey] = useState(0);
  const [catalogState, setCatalogState] = useState<CatalogState>({
    status: 'loading',
  });
  const requestIdRef = useRef(0);

  const canCreate = Boolean(
    currentUser?.permissions.includes(DYNAMIC_TABLES_TABLES_CREATE_PERMISSION),
  );

  useEffect(() => {
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    const abortController = new AbortController();

    // Defer the state change so React does not treat the effect as a
    // synchronous cascading update; the request id also protects a retry
    // that happens before this microtask runs.
    Promise.resolve().then(() => {
      if (requestIdRef.current === requestId) {
        setCatalogState({ status: 'loading' });
      }
    });
    fetchTables({ page, pageSize: DEFAULT_PAGE_SIZE }, abortController.signal)
      .then((response) => {
        if (requestIdRef.current !== requestId) return;
        setCatalogState({
          status: 'ready',
          items: response.items,
          total: response.meta.total,
          page: response.meta.page,
          pageSize: response.meta.pageSize,
        });
      })
      .catch(() => {
        if (
          requestIdRef.current !== requestId ||
          abortController.signal.aborted
        ) {
          return;
        }
        setCatalogState({ status: 'error' });
      });

    return () => {
      abortController.abort();
    };
  }, [fetchTables, page, reloadKey]);

  const openDetail = useCallback(
    (table: DynamicTableCatalogItemDto) => {
      navigate(`/dynamic-tables/${encodeURIComponent(table.id)}`);
    },
    [navigate],
  );
  const openRows = useCallback(
    (table: DynamicTableCatalogItemDto) => {
      navigate(`/dynamic-tables/${encodeURIComponent(table.id)}/rows`);
    },
    [navigate],
  );
  const columns = useMemo(
    () => tableColumns(t, openDetail, openRows),
    [openDetail, openRows, t],
  );

  const isReady = catalogState.status === 'ready';
  const rows = isReady ? catalogState.items : [];
  const total = isReady ? catalogState.total : 0;
  const currentPage = isReady ? catalogState.page : page;
  const pageSize = isReady ? catalogState.pageSize : DEFAULT_PAGE_SIZE;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <>
      <PageHeader
        title={t('dynamicTables.title')}
        description={t('dynamicTables.description')}
        actions={
          canCreate ? (
            <Button icon="add" onClick={() => navigate('/dynamic-tables/new')}>
              {t('dynamicTables.actions.create')}
            </Button>
          ) : undefined
        }
      />

      {catalogState.status === 'error' ? (
        <Card role="alert" className="flex flex-col items-start gap-md">
          <p className="font-body-base text-body-base text-on-surface">
            {t('dynamicTables.loadError')}
          </p>
          <Button
            variant="secondary"
            icon="refresh"
            onClick={() => setReloadKey((current) => current + 1)}
          >
            {t('dynamicTables.actions.retry')}
          </Button>
        </Card>
      ) : (
        <Table
          columns={columns}
          rows={rows}
          rowKey={(table) => table.id}
          onRowClick={openDetail}
          emptyMessage={t('dynamicTables.empty')}
          isLoading={catalogState.status === 'loading'}
          skeletonRowCount={5}
        />
      )}

      {isReady && total > 0 && (
        <nav
          className="flex items-center justify-between gap-sm"
          aria-label={t('dynamicTables.pagination.label')}
        >
          <p className="font-body-sm text-body-sm text-on-surface-variant">
            {t('dynamicTables.pagination.pageOfTotal', {
              page: currentPage,
              totalPages,
            })}
          </p>
          <div className="flex items-center gap-sm">
            <Button
              variant="secondary"
              icon="chevron_left"
              disabled={currentPage <= 1}
              onClick={() => setPage((current) => Math.max(1, current - 1))}
            >
              {t('dynamicTables.pagination.previous')}
            </Button>
            <Button
              variant="secondary"
              icon="chevron_right"
              disabled={currentPage >= totalPages}
              onClick={() =>
                setPage((current) => Math.min(totalPages, current + 1))
              }
            >
              {t('dynamicTables.pagination.next')}
            </Button>
          </div>
        </nav>
      )}
    </>
  );
}
