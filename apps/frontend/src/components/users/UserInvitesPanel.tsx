import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { UserInviteStatus, type UserInviteDto } from '@flexi/shared-types';
import { Button, Card, Table, type TableColumn } from '../ui';
import { describeUserError } from '../../lib/user-error-message';
import { listInvites, resendInvite, revokeInvite } from '../../lib/users-api';
import { InviteStatusBadge } from './StatusBadges';

export interface UserInvitesPanelProps {
  /** Bumped by the caller after a batch is sent, to re-read the listing. */
  reloadKey?: number;
  /** Whether the viewer holds `tenant.user.invite`. */
  canInvite: boolean;
  /** Injectable for Storybook and focused UI tests. */
  fetchInvites?: typeof listInvites;
  resend?: typeof resendInvite;
  revoke?: typeof revokeInvite;
}

type PanelState =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; invites: UserInviteDto[] };

/**
 * Outstanding invitations, with resend and revoke.
 *
 * Only a `pending` invite can be resent or revoked -- `used` and `revoked`
 * are terminal, and an `expired` one is still `pending` underneath, which
 * is exactly the case resend exists for. The row actions follow that rule
 * so the buttons a caller can press are the ones the API will accept;
 * pressing one anyway still surfaces `INVITE_NOT_PENDING` by code.
 */
export function UserInvitesPanel({
  reloadKey = 0,
  canInvite,
  fetchInvites = listInvites,
  resend = resendInvite,
  revoke = revokeInvite,
}: UserInvitesPanelProps) {
  const { t } = useTranslation();
  const [state, setState] = useState<PanelState>({ status: 'loading' });
  const [localReloadKey, setLocalReloadKey] = useState(0);
  const [busyInviteId, setBusyInviteId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();

    fetchInvites({ signal: controller.signal })
      .then((invites) => {
        if (!controller.signal.aborted) {
          setState({ status: 'ready', invites });
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) setState({ status: 'error' });
      });

    return () => controller.abort();
  }, [fetchInvites, localReloadKey, reloadKey]);

  const runAction = useCallback(
    async (inviteId: string, action: () => Promise<unknown>) => {
      setBusyInviteId(inviteId);
      setActionError(null);
      try {
        await action();
        setLocalReloadKey((key) => key + 1);
      } catch (error) {
        setActionError(describeUserError(error, t));
      } finally {
        setBusyInviteId(null);
      }
    },
    [t],
  );

  const columns: TableColumn<UserInviteDto>[] = [
    {
      id: 'email',
      header: t('users.invites.table.email'),
      cell: (invite) => invite.email,
    },
    {
      id: 'status',
      header: t('users.invites.table.status'),
      cell: (invite) => <InviteStatusBadge status={invite.status} />,
    },
    {
      id: 'expiresAt',
      header: t('users.invites.table.expiresAt'),
      cell: (invite) => new Date(invite.expiresAt).toLocaleString(),
    },
    {
      id: 'actions',
      header: t('users.invites.table.actions'),
      align: 'right',
      cell: (invite) => {
        if (!canInvite || invite.status !== UserInviteStatus.PENDING) {
          return null;
        }

        const busy = busyInviteId === invite.id;

        return (
          <div className="flex justify-end gap-xs">
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => runAction(invite.id, () => resend(invite.id))}
            >
              {t('users.invites.actions.resend')}
            </Button>
            <Button
              variant="danger"
              size="sm"
              disabled={busy}
              onClick={() => runAction(invite.id, () => revoke(invite.id))}
            >
              {t('users.invites.actions.revoke')}
            </Button>
          </div>
        );
      },
    },
  ];

  if (state.status === 'error') {
    return (
      <Card role="alert" className="flex flex-col items-start gap-md">
        <p className="font-body-base text-body-base text-on-surface">
          {t('users.invites.loadError')}
        </p>
        <Button
          variant="secondary"
          icon="refresh"
          onClick={() => setLocalReloadKey((key) => key + 1)}
        >
          {t('users.actions.retry')}
        </Button>
      </Card>
    );
  }

  return (
    <section
      className="flex flex-col gap-sm"
      aria-label={t('users.invites.title')}
    >
      <h2 className="font-headline-md text-headline-md text-on-surface">
        {t('users.invites.title')}
      </h2>

      {actionError && (
        <p role="alert" className="font-body-sm text-body-sm text-error">
          {actionError}
        </p>
      )}

      <Table
        columns={columns}
        rows={state.status === 'ready' ? state.invites : []}
        rowKey={(invite) => invite.id}
        emptyMessage={t('users.invites.empty')}
        isLoading={state.status === 'loading'}
        skeletonRowCount={3}
      />
    </section>
  );
}
