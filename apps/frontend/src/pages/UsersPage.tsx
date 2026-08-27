import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
} from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  TenantUserStatus,
  USER_LIST_DEFAULT_PAGE_SIZE,
  type UserSummaryDto,
} from '@flexi/shared-types';
import { useAuth } from '../auth/AuthContext';
import {
  canInviteUsers,
  canManageTenantSettings,
  canManageUsers,
} from '../auth/permissions';
import {
  Button,
  Card,
  Input,
  PageHeader,
  Select,
  Table,
  type TableColumn,
} from '../components/ui';
import { DeleteUserDialog } from '../components/users/DeleteUserDialog';
import { InviteUsersDialog } from '../components/users/InviteUsersDialog';
import { UserInvitesPanel } from '../components/users/UserInvitesPanel';
import { UserStatusBadge } from '../components/users/StatusBadges';
import { describeUserError } from '../lib/user-error-message';
import {
  approveUser,
  listUsers,
  lockUser,
  unlockUser,
  type UsersRequestOptions,
} from '../lib/users-api';

/**
 * Statuses offered as a filter.
 *
 * `pending_setup` is included because the First Admin flow still produces
 * it, and `deleted` because the backend only returns soft-deleted rows when
 * they are asked for by name -- leaving it out would make them unreachable
 * from the UI entirely.
 */
const FILTERABLE_STATUSES: readonly TenantUserStatus[] = [
  TenantUserStatus.ACTIVE,
  TenantUserStatus.PENDING_APPROVAL,
  TenantUserStatus.PENDING_INVITE,
  TenantUserStatus.PENDING_SETUP,
  TenantUserStatus.LOCKED,
  TenantUserStatus.DELETED,
];

type ListState =
  | { status: 'loading' }
  | { status: 'error' }
  | {
      status: 'ready';
      items: UserSummaryDto[];
      total: number;
      page: number;
      pageSize: number;
    };

export interface UsersPageProps {
  /** Injectable for Storybook and focused UI tests; production uses the API. */
  fetchUsers?: typeof listUsers;
  approve?: typeof approveUser;
  lock?: typeof lockUser;
  unlock?: typeof unlockUser;
  /** Forwarded to the child panels/dialogs so a story can drive them too. */
  invitesPanelProps?: Partial<
    Omit<ComponentProps<typeof UserInvitesPanel>, 'canInvite' | 'reloadKey'>
  >;
  inviteDialogProps?: Partial<
    Omit<ComponentProps<typeof InviteUsersDialog>, 'onClose' | 'onInvited'>
  >;
  deleteDialogProps?: Partial<
    Omit<
      ComponentProps<typeof DeleteUserDialog>,
      'user' | 'onClose' | 'onDeleted'
    >
  >;
}

/**
 * Tenant user directory: who is in the tenant, what state each membership
 * is in, and the lifecycle actions on it.
 *
 * Two things the Users specification asks for are absent because no
 * endpoint serves them, not because they were forgotten:
 *
 * - **A role filter.** `GET /api/users` accepts `?roleId=`, but nothing in
 *   the backend serves a list of roles to populate the control with.
 *   Deriving the options from the roles visible on the current page would
 *   silently hide every role that happens to have no member on it.
 * - **A seat counter in the header.** `TenantSeatUsageDto` is only ever
 *   returned by the invite and direct-create calls, never readable on its
 *   own, so it is shown where it actually arrives -- in the invite
 *   dialog's result. See `SeatUsage`.
 *
 * Both are filed as follow-ups; nothing here fakes them.
 */
export function UsersPage({
  fetchUsers = listUsers,
  approve = approveUser,
  lock = lockUser,
  unlock = unlockUser,
  invitesPanelProps,
  inviteDialogProps,
  deleteDialogProps,
}: UsersPageProps = {}) {
  const { t } = useTranslation();
  const { currentUser } = useAuth();
  const navigate = useNavigate();

  const [page, setPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState<TenantUserStatus | ''>('');
  // The applied keyword, separate from the box, so typing does not fire a
  // request per keystroke -- the filter bar submits.
  const [keywordDraft, setKeywordDraft] = useState('');
  const [keyword, setKeyword] = useState('');
  const [reloadKey, setReloadKey] = useState(0);
  const [invitesReloadKey, setInvitesReloadKey] = useState(0);
  const [listState, setListState] = useState<ListState>({ status: 'loading' });
  const [isInviteOpen, setInviteOpen] = useState(false);
  const [userToDelete, setUserToDelete] = useState<UserSummaryDto | null>(null);
  const [busyUserId, setBusyUserId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const requestIdRef = useRef(0);

  const canManage = canManageUsers(currentUser);
  const canInvite = canInviteUsers(currentUser);
  const canManageSettings = canManageTenantSettings(currentUser);

  useEffect(() => {
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    const controller = new AbortController();

    // Deferred so React does not treat the effect as a synchronous
    // cascading update; the request id also protects a retry that lands
    // before this microtask runs. Same shape as DynamicTablesPage.
    Promise.resolve().then(() => {
      if (requestIdRef.current === requestId) {
        setListState({ status: 'loading' });
      }
    });

    fetchUsers(
      {
        status: statusFilter || undefined,
        keyword: keyword || undefined,
        page,
        pageSize: USER_LIST_DEFAULT_PAGE_SIZE,
      },
      { signal: controller.signal },
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
      .catch(() => {
        if (requestIdRef.current !== requestId || controller.signal.aborted) {
          return;
        }
        setListState({ status: 'error' });
      });

    return () => controller.abort();
  }, [fetchUsers, keyword, page, reloadKey, statusFilter]);

  const refreshList = useCallback(() => setReloadKey((key) => key + 1), []);

  const runAction = useCallback(
    async (
      user: UserSummaryDto,
      action: (
        userId: string,
        options?: UsersRequestOptions,
      ) => Promise<unknown>,
    ) => {
      setBusyUserId(user.id);
      setActionError(null);
      try {
        await action(user.id);
        refreshList();
      } catch (error) {
        setActionError(describeUserError(error, t));
      } finally {
        setBusyUserId(null);
      }
    },
    [refreshList, t],
  );

  const columns = useMemo<TableColumn<UserSummaryDto>[]>(
    () => [
      {
        id: 'name',
        header: t('users.table.name'),
        cell: (user) => user.fullName ?? t('users.table.noName'),
      },
      {
        id: 'email',
        header: t('users.table.email'),
        cell: (user) => user.email,
      },
      {
        id: 'roles',
        header: t('users.table.roles'),
        cell: (user) =>
          user.roles.length > 0
            ? user.roles.map((role) => role.name).join(', ')
            : t('users.table.noRoles'),
      },
      {
        id: 'status',
        header: t('users.table.status'),
        cell: (user) => <UserStatusBadge status={user.status} />,
      },
      {
        id: 'actions',
        header: t('users.table.actions'),
        align: 'right',
        cell: (user) => {
          if (!canManage) return null;

          const busy = busyUserId === user.id;

          return (
            <div className="flex justify-end gap-xs">
              {user.status === TenantUserStatus.PENDING_APPROVAL && (
                <Button
                  size="sm"
                  disabled={busy}
                  onClick={() => runAction(user, approve)}
                >
                  {t('users.actions.approve')}
                </Button>
              )}
              {user.status === TenantUserStatus.ACTIVE && (
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={busy}
                  onClick={() => runAction(user, lock)}
                >
                  {t('users.actions.lock')}
                </Button>
              )}
              {user.status === TenantUserStatus.LOCKED && (
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={busy}
                  onClick={() => runAction(user, unlock)}
                >
                  {t('users.actions.unlock')}
                </Button>
              )}
              {user.status !== TenantUserStatus.DELETED && (
                <Button
                  variant="danger"
                  size="sm"
                  disabled={busy}
                  onClick={() => setUserToDelete(user)}
                >
                  {t('users.actions.delete')}
                </Button>
              )}
            </div>
          );
        },
      },
    ],
    [approve, busyUserId, canManage, lock, runAction, t, unlock],
  );

  const isReady = listState.status === 'ready';
  const total = isReady ? listState.total : 0;
  const currentPage = isReady ? listState.page : page;
  const pageSize = isReady ? listState.pageSize : USER_LIST_DEFAULT_PAGE_SIZE;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <>
      <PageHeader
        title={t('users.title')}
        description={t('users.description')}
        actions={
          <div className="flex items-center gap-sm">
            {canManageSettings && (
              <Button
                variant="secondary"
                icon="settings"
                onClick={() => navigate('/users/settings')}
              >
                {t('users.actions.settings')}
              </Button>
            )}
            {canInvite && (
              <Button icon="person_add" onClick={() => setInviteOpen(true)}>
                {t('users.actions.invite')}
              </Button>
            )}
          </div>
        }
      />

      <Card>
        <form
          className="flex flex-wrap items-end gap-md"
          aria-label={t('users.filters.label')}
          onSubmit={(event) => {
            event.preventDefault();
            setPage(1);
            setKeyword(keywordDraft.trim());
          }}
        >
          <div className="w-48">
            <Select
              label={t('users.filters.status')}
              value={statusFilter}
              onChange={(event) => {
                setPage(1);
                setStatusFilter(event.target.value as TenantUserStatus | '');
              }}
            >
              <option value="">{t('users.filters.statusAll')}</option>
              {FILTERABLE_STATUSES.map((status) => (
                <option key={status} value={status}>
                  {t(`users.status.${status}`)}
                </option>
              ))}
            </Select>
          </div>

          <div className="min-w-[16rem] flex-1">
            <Input
              label={t('users.filters.keyword')}
              placeholder={t('users.filters.keywordPlaceholder')}
              value={keywordDraft}
              onChange={(event) => setKeywordDraft(event.target.value)}
            />
          </div>

          <Button type="submit" variant="secondary" icon="search">
            {t('users.filters.apply')}
          </Button>
        </form>
      </Card>

      {actionError && (
        <p role="alert" className="font-body-sm text-body-sm text-error">
          {actionError}
        </p>
      )}

      {listState.status === 'error' ? (
        <Card role="alert" className="flex flex-col items-start gap-md">
          <p className="font-body-base text-body-base text-on-surface">
            {t('users.loadError')}
          </p>
          <Button variant="secondary" icon="refresh" onClick={refreshList}>
            {t('users.actions.retry')}
          </Button>
        </Card>
      ) : (
        <Table
          columns={columns}
          rows={isReady ? listState.items : []}
          rowKey={(user) => user.id}
          emptyMessage={t('users.empty')}
          isLoading={listState.status === 'loading'}
          skeletonRowCount={5}
        />
      )}

      {isReady && total > 0 && (
        <nav
          className="flex items-center justify-between gap-sm"
          aria-label={t('users.pagination.label')}
        >
          <p className="font-body-sm text-body-sm text-on-surface-variant">
            {t('users.pagination.pageOfTotal', {
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
              {t('users.pagination.previous')}
            </Button>
            <Button
              variant="secondary"
              icon="chevron_right"
              disabled={currentPage >= totalPages}
              onClick={() =>
                setPage((current) => Math.min(totalPages, current + 1))
              }
            >
              {t('users.pagination.next')}
            </Button>
          </div>
        </nav>
      )}

      {canInvite && (
        <UserInvitesPanel
          canInvite={canInvite}
          reloadKey={invitesReloadKey}
          {...invitesPanelProps}
        />
      )}

      {isInviteOpen && (
        <InviteUsersDialog
          onClose={() => setInviteOpen(false)}
          onInvited={() => {
            refreshList();
            setInvitesReloadKey((key) => key + 1);
          }}
          {...inviteDialogProps}
        />
      )}

      {userToDelete && (
        <DeleteUserDialog
          user={userToDelete}
          onClose={() => setUserToDelete(null)}
          onDeleted={() => {
            setUserToDelete(null);
            refreshList();
          }}
          {...deleteDialogProps}
        />
      )}
    </>
  );
}
