import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
} from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type {
  TenantListItemDto,
  TenantListQueryDto,
  TenantListResponseDto,
  TenantLifecycleStatus,
} from '@flexi/shared-types';
import { TENANT_LIFECYCLE_STATUSES } from '@flexi/shared-types';
import { useAuth } from '../auth/AuthContext';
import { canOnboardTenants } from '../auth/permissions';
import {
  Badge,
  Button,
  Input,
  PageHeader,
  Select,
  Table,
  type TableColumn,
} from '../components/ui';
import { apiGet } from '../lib/api-client';

const DEFAULT_PAGE_SIZE = 20;

interface FilterState {
  status: '' | TenantLifecycleStatus;
  keyword: string;
  createdFrom: string;
  createdTo: string;
}

const INITIAL_FILTERS: FilterState = {
  status: '',
  keyword: '',
  createdFrom: '',
  createdTo: '',
};

type ListState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | {
      status: 'ready';
      items: TenantListItemDto[];
      total: number;
      page: number;
      pageSize: number;
    };

const STATUS_BADGE_TONE: Record<TenantLifecycleStatus, 'success' | 'warning' | 'danger' | 'neutral'> = {
  ACTIVE: 'success',
  PROVISIONING: 'neutral',
  SUSPENDED: 'warning',
  FAILED: 'danger',
};

function buildQueryString(filters: FilterState, page: number): string {
  const params = new URLSearchParams();
  if (filters.status) params.set('status', filters.status);
  if (filters.keyword.trim()) params.set('keyword', filters.keyword.trim());
  if (filters.createdFrom) params.set('createdFrom', filters.createdFrom);
  if (filters.createdTo) params.set('createdTo', filters.createdTo);
  params.set('page', String(page));
  params.set('pageSize', String(DEFAULT_PAGE_SIZE));
  return params.toString();
}

function hasActiveFilters(filters: FilterState): boolean {
  return Boolean(
    filters.status ||
      filters.keyword.trim() ||
      filters.createdFrom ||
      filters.createdTo,
  );
}

function defaultFetchTenants(
  query: TenantListQueryDto & { page: number; pageSize: number },
  signal?: AbortSignal,
): Promise<TenantListResponseDto> {
  const filters: FilterState = {
    status: (query.status as TenantLifecycleStatus) ?? '',
    keyword: query.keyword ?? '',
    createdFrom: query.createdFrom ?? '',
    createdTo: query.createdTo ?? '',
  };
  const queryString = buildQueryString(filters, query.page);
  return apiGet<TenantListResponseDto>(
    `/v1/super-admin/tenants?${queryString}`,
    { signal },
  );
}

export interface TenantsPageProps {
  fetchTenants?: (
    query: TenantListQueryDto & { page: number; pageSize: number },
    signal?: AbortSignal,
  ) => Promise<TenantListResponseDto>;
}

function tenantColumns(
  t: (key: string) => string,
): TableColumn<TenantListItemDto>[] {
  return [
    {
      id: 'name',
      header: t('tenants.table.name'),
      cell: (row) => row.name,
    },
    {
      id: 'slug',
      header: t('tenants.table.slug'),
      cell: (row) => (
        <span className="font-code-sm text-code-sm">{row.slug}</span>
      ),
    },
    {
      id: 'status',
      header: t('tenants.table.status'),
      cell: (row) => (
        <Badge tone={STATUS_BADGE_TONE[row.status] ?? 'neutral'}>
          {row.status}
        </Badge>
      ),
    },
    {
      id: 'plan',
      header: t('tenants.table.plan'),
      cell: (row) => row.plan ?? t('tenants.table.placeholder'),
    },
    {
      id: 'createdAt',
      header: t('tenants.table.createdAt'),
      cell: (row) => new Date(row.createdAt).toLocaleDateString(),
    },
    {
      id: 'latestAttemptStatus',
      header: t('tenants.table.latestAttemptStatus'),
      cell: (row) =>
        row.latestAttemptStatus ? (
          <Badge tone="neutral">{row.latestAttemptStatus}</Badge>
        ) : (
          t('tenants.table.placeholder')
        ),
    },
    {
      id: 'actorName',
      header: t('tenants.table.actorName'),
      cell: (row) => row.actorName ?? t('tenants.table.placeholder'),
    },
  ];
}

export function TenantsPage({
  fetchTenants = defaultFetchTenants,
}: TenantsPageProps = {}) {
  const { t } = useTranslation();
  const { currentUser } = useAuth();
  const navigate = useNavigate();
  const canCreateTenant = canOnboardTenants(currentUser);

  const [filters, setFilters] = useState<FilterState>(INITIAL_FILTERS);
  const [appliedFilters, setAppliedFilters] =
    useState<FilterState>(INITIAL_FILTERS);
  const [page, setPage] = useState(1);
  const [listState, setListState] = useState<ListState>({ status: 'loading' });
  const requestIdRef = useRef(0);

  useEffect(() => {
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    const abortController = new AbortController();

    // Deferred via microtask (rather than called synchronously in the
    // effect body) so React doesn't see this as a same-tick, cascading
    // setState -- the loading flag still flips before fetchTenants'
    // promise can settle.
    Promise.resolve().then(() => {
      if (requestIdRef.current === requestId) {
        setListState({ status: 'loading' });
      }
    });

    fetchTenants(
      {
        status: appliedFilters.status || undefined,
        keyword: appliedFilters.keyword.trim() || undefined,
        createdFrom: appliedFilters.createdFrom || undefined,
        createdTo: appliedFilters.createdTo || undefined,
        page,
        pageSize: DEFAULT_PAGE_SIZE,
      },
      abortController.signal,
    )
      .then((response) => {
        if (requestIdRef.current !== requestId) return;
        setListState({
          status: 'ready',
          items: response.items,
          total: response.meta.total,
          page: response.meta.page,
          pageSize: response.meta.pageSize,
        });
      })
      .catch((error: unknown) => {
        if (requestIdRef.current !== requestId) return;
        if (error instanceof DOMException && error.name === 'AbortError') {
          return;
        }
        setListState({
          status: 'error',
          message: t('tenants.loadError'),
        });
      });

    return () => {
      abortController.abort();
    };
  }, [appliedFilters, page, fetchTenants, t]);

  const handleApplyFilters = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setPage(1);
    setAppliedFilters(filters);
  };

  const handleResetFilters = () => {
    setFilters(INITIAL_FILTERS);
    setPage(1);
    setAppliedFilters(INITIAL_FILTERS);
  };

  const setFilterValue =
    (field: keyof FilterState) =>
    (event: ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
      setFilters((current) => ({ ...current, [field]: event.target.value }));
    };

  const columns = useMemo(() => tenantColumns(t), [t]);

  const isLoading = listState.status === 'loading';
  const rows = listState.status === 'ready' ? listState.items : [];
  const total = listState.status === 'ready' ? listState.total : 0;
  const pageSize =
    listState.status === 'ready' ? listState.pageSize : DEFAULT_PAGE_SIZE;
  const currentPage = listState.status === 'ready' ? listState.page : page;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const filtersActive = hasActiveFilters(appliedFilters);
  const isNoMatch =
    listState.status === 'ready' && total === 0 && filtersActive;

  const emptyMessage =
    listState.status === 'error'
      ? listState.message
      : isNoMatch
        ? t('tenants.noMatch')
        : t('tenants.empty');

  const showOnboardAction = canCreateTenant && !isNoMatch;

  const primaryAction = showOnboardAction ? (
    <Button
      variant="primary"
      icon="add"
      onClick={() => navigate('/tenants/onboard')}
    >
      {t('tenants.actions.onboard')}
    </Button>
  ) : undefined;

  return (
    <>
      <PageHeader
        title={t('tenants.title')}
        description={t('tenants.description')}
        actions={primaryAction}
      />

      <form
        className="grid gap-md md:grid-cols-4"
        aria-label={t('tenants.filters.label')}
        onSubmit={handleApplyFilters}
      >
        <Select
          label={t('tenants.filters.status')}
          value={filters.status}
          onChange={setFilterValue('status')}
        >
          <option value="">{t('tenants.filters.statusAll')}</option>
          {TENANT_LIFECYCLE_STATUSES.map((status) => (
            <option key={status} value={status}>
              {status}
            </option>
          ))}
        </Select>
        <Input
          label={t('tenants.filters.keyword')}
          icon="search"
          value={filters.keyword}
          onChange={setFilterValue('keyword')}
          placeholder={t('tenants.filters.keywordPlaceholder')}
        />
        <Input
          label={t('tenants.filters.createdFrom')}
          type="date"
          value={filters.createdFrom}
          onChange={setFilterValue('createdFrom')}
        />
        <Input
          label={t('tenants.filters.createdTo')}
          type="date"
          value={filters.createdTo}
          onChange={setFilterValue('createdTo')}
        />
        <div className="flex items-end gap-sm md:col-span-4">
          <Button type="submit" variant="primary">
            {t('tenants.filters.apply')}
          </Button>
          <Button type="button" variant="ghost" onClick={handleResetFilters}>
            {t('tenants.filters.reset')}
          </Button>
        </div>
      </form>

      <Table
        columns={columns}
        rows={rows}
        rowKey={(row) => row.id}
        emptyMessage={emptyMessage}
        isLoading={isLoading}
        skeletonRowCount={5}
      />

      {listState.status === 'ready' && total > 0 && (
        <nav
          className="flex items-center justify-between gap-sm"
          aria-label={t('tenants.pagination.label')}
        >
          <p className="font-body-sm text-body-sm text-on-surface-variant">
            {t('tenants.pagination.pageOfTotal', { page: currentPage, totalPages })}
          </p>
          <div className="flex items-center gap-sm">
            <Button
              variant="secondary"
              icon="chevron_left"
              disabled={currentPage <= 1}
              onClick={() => setPage((current) => Math.max(1, current - 1))}
            >
              {t('tenants.pagination.previous')}
            </Button>
            <Button
              variant="secondary"
              icon="chevron_right"
              disabled={currentPage >= totalPages}
              onClick={() =>
                setPage((current) => Math.min(totalPages, current + 1))
              }
            >
              {t('tenants.pagination.next')}
            </Button>
          </div>
        </nav>
      )}
    </>
  );
}
