import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { TenantUserStatus, type UserSummaryDto } from '@flexi/shared-types';
import { Button, Card, Icon, Select } from '../ui';
import { describeUserError } from '../../lib/user-error-message';
import { deleteUser, listUsers } from '../../lib/users-api';

/** Enough candidates to choose from without paging inside a dialog. */
const TRANSFER_CANDIDATE_PAGE_SIZE = 100;

export interface DeleteUserDialogProps {
  user: UserSummaryDto;
  onClose: () => void;
  /** Called after the deletion succeeds so the caller can refresh. */
  onDeleted: () => void;
  /** Injectable for Storybook and focused UI tests. */
  removeUser?: typeof deleteUser;
  fetchCandidates?: typeof listUsers;
}

type CandidatesState =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; candidates: UserSummaryDto[] };

type SubmitState =
  | { status: 'idle' }
  | { status: 'submitting' }
  | { status: 'error'; message: string };

/**
 * Soft or hard deletion of one membership.
 *
 * A soft delete keeps the row as `deleted` and frees its seat. A hard
 * delete removes it, and the backend refuses one that would orphan
 * dynamic rows the user owns -- hence the transfer target, which the API
 * takes as `?transferToUserId=`.
 *
 * The candidate list is `GET /api/users?status=active`, the same listing
 * the Users screen reads: the backend's own rule is that a target must be
 * an active member of the same tenant other than the user being deleted,
 * so filtering that listing is exactly the set it will accept. An invalid
 * choice still comes back as `INVALID_TARGET_USER` and is rendered from
 * the code.
 */
export function DeleteUserDialog({
  user,
  onClose,
  onDeleted,
  removeUser = deleteUser,
  fetchCandidates = listUsers,
}: DeleteUserDialogProps) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<'soft' | 'hard'>('soft');
  const [transferToUserId, setTransferToUserId] = useState('');
  const [candidates, setCandidates] = useState<CandidatesState>({
    status: 'loading',
  });
  const [submit, setSubmit] = useState<SubmitState>({ status: 'idle' });

  // Only a hard delete can need a target, so the candidate listing is not
  // requested until the operator asks for one.
  useEffect(() => {
    if (mode !== 'hard') return;

    const controller = new AbortController();
    fetchCandidates(
      {
        status: TenantUserStatus.ACTIVE,
        pageSize: TRANSFER_CANDIDATE_PAGE_SIZE,
      },
      { signal: controller.signal },
    )
      .then((response) => {
        if (controller.signal.aborted) return;
        setCandidates({
          status: 'ready',
          candidates: response.items.filter((item) => item.id !== user.id),
        });
      })
      .catch(() => {
        if (!controller.signal.aborted) setCandidates({ status: 'error' });
      });

    return () => controller.abort();
  }, [fetchCandidates, mode, user.id]);

  async function handleDelete() {
    setSubmit({ status: 'submitting' });
    try {
      await removeUser(user.id, {
        mode,
        transferToUserId:
          mode === 'hard' && transferToUserId ? transferToUserId : undefined,
      });
      onDeleted();
    } catch (error) {
      setSubmit({ status: 'error', message: describeUserError(error, t) });
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-inverse-surface/40 p-lg backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label={t('users.delete.title')}
    >
      <Card className="w-full max-w-lg" padded={false}>
        <div className="flex flex-col gap-lg p-xl">
          <div>
            <h2 className="font-headline-md text-headline-md text-on-surface">
              {t('users.delete.title')}
            </h2>
            <p className="font-body-sm text-body-sm text-on-surface-variant">
              {t('users.delete.description', { email: user.email })}
            </p>
          </div>

          <fieldset className="flex flex-col gap-sm">
            <legend className="font-label-caps text-label-caps uppercase tracking-wider text-on-surface-variant">
              {t('users.delete.modeLabel')}
            </legend>

            <label className="flex items-start gap-sm font-body-sm text-body-sm text-on-surface">
              <input
                type="radio"
                name="delete-mode"
                value="soft"
                checked={mode === 'soft'}
                onChange={() => setMode('soft')}
              />
              <span>
                <span className="font-medium">
                  {t('users.delete.modes.soft')}
                </span>
                <span className="block text-on-surface-variant">
                  {t('users.delete.modes.softHint')}
                </span>
              </span>
            </label>

            <label className="flex items-start gap-sm font-body-sm text-body-sm text-on-surface">
              <input
                type="radio"
                name="delete-mode"
                value="hard"
                checked={mode === 'hard'}
                onChange={() => setMode('hard')}
              />
              <span>
                <span className="font-medium">
                  {t('users.delete.modes.hard')}
                </span>
                <span className="block text-on-surface-variant">
                  {t('users.delete.modes.hardHint')}
                </span>
              </span>
            </label>
          </fieldset>

          {mode === 'hard' && (
            <div className="flex flex-col gap-xs">
              {candidates.status === 'loading' && (
                <p
                  role="status"
                  className="font-body-sm text-body-sm text-on-surface-variant"
                >
                  {t('users.delete.transferLoading')}
                </p>
              )}

              {candidates.status === 'error' && (
                <p
                  role="alert"
                  className="font-body-sm text-body-sm text-error"
                >
                  {t('users.delete.transferLoadError')}
                </p>
              )}

              {candidates.status === 'ready' &&
                (candidates.candidates.length === 0 ? (
                  <p className="font-body-sm text-body-sm text-on-surface-variant">
                    {t('users.delete.transferEmpty')}
                  </p>
                ) : (
                  <Select
                    label={t('users.delete.transferLabel')}
                    value={transferToUserId}
                    onChange={(event) =>
                      setTransferToUserId(event.target.value)
                    }
                  >
                    <option value="">{t('users.delete.transferNone')}</option>
                    {candidates.candidates.map((candidate) => (
                      <option key={candidate.id} value={candidate.id}>
                        {candidate.fullName
                          ? `${candidate.fullName} (${candidate.email})`
                          : candidate.email}
                      </option>
                    ))}
                  </Select>
                ))}
            </div>
          )}

          {submit.status === 'error' && (
            <div
              role="alert"
              className="flex items-start gap-sm rounded bg-error-container p-sm font-body-sm text-body-sm text-on-error-container"
            >
              <Icon name="error" size={18} />
              <p>{submit.message}</p>
            </div>
          )}

          <div className="flex justify-end gap-sm">
            <Button variant="secondary" onClick={onClose}>
              {t('users.delete.actions.cancel')}
            </Button>
            <Button
              variant="danger"
              icon="delete"
              disabled={submit.status === 'submitting'}
              onClick={handleDelete}
            >
              {submit.status === 'submitting'
                ? t('users.delete.actions.submitting')
                : t('users.delete.actions.submit')}
            </Button>
          </div>
        </div>
      </Card>
    </div>
  );
}
