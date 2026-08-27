import { useMemo, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import {
  MAX_INVITES_PER_BATCH,
  USER_INVITE_TTL_HOURS,
  type InviteUsersResponseDto,
} from '@flexi/shared-types';
import { Button, Card, Icon } from '../ui';
import { parseEmailList } from '../../lib/list-input';
import { describeUserError } from '../../lib/user-error-message';
import { createInvites } from '../../lib/users-api';
import { SeatUsage } from './SeatUsage';

/**
 * Same shape as the backend's address check, written so no two adjacent
 * quantifiers can match the same character (see `EMAIL_PATTERN` in
 * shared-types). This only spares the user a round trip -- the server
 * validates every address again regardless.
 */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/;

export interface InviteUsersDialogProps {
  onClose: () => void;
  /** Called after a successful batch so the caller can refresh its lists. */
  onInvited: (response: InviteUsersResponseDto) => void;
  /** Injectable for Storybook and focused UI tests. */
  submitInvites?: typeof createInvites;
}

type DialogState =
  | { status: 'editing' }
  | { status: 'submitting' }
  | { status: 'error'; message: string }
  | { status: 'invited'; response: InviteUsersResponseDto };

/**
 * Batch invitation.
 *
 * No role picker: `POST /api/users/invites` accepts an optional `roleId`
 * that applies to the whole batch, but nothing serves a list of roles to
 * choose from -- there is no roles endpoint anywhere in the backend -- so
 * the control is left out rather than built against an API that does not
 * exist. Invitees arrive with no role, which is what omitting `roleId`
 * already means today.
 */
export function InviteUsersDialog({
  onClose,
  onInvited,
  submitInvites = createInvites,
}: InviteUsersDialogProps) {
  const { t } = useTranslation();
  const [raw, setRaw] = useState('');
  const [state, setState] = useState<DialogState>({ status: 'editing' });

  const emails = useMemo(() => parseEmailList(raw), [raw]);
  const invalidEmails = emails.filter((email) => !EMAIL_PATTERN.test(email));
  const tooMany = emails.length > MAX_INVITES_PER_BATCH;
  const canSubmit =
    emails.length > 0 &&
    invalidEmails.length === 0 &&
    !tooMany &&
    state.status !== 'submitting';

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit) return;

    setState({ status: 'submitting' });
    try {
      const response = await submitInvites({ emails });
      setState({ status: 'invited', response });
      onInvited(response);
    } catch (error) {
      setState({ status: 'error', message: describeUserError(error, t) });
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-inverse-surface/40 p-lg backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label={t('users.invite.title')}
    >
      <Card className="w-full max-w-lg" padded={false}>
        <div className="flex flex-col gap-lg p-xl">
          <div className="flex items-start justify-between gap-md">
            <div>
              <h2 className="font-headline-md text-headline-md text-on-surface">
                {t('users.invite.title')}
              </h2>
              <p className="font-body-sm text-body-sm text-on-surface-variant">
                {t('users.invite.description', {
                  hours: USER_INVITE_TTL_HOURS,
                })}
              </p>
            </div>
            <Button
              variant="ghost"
              size="sm"
              icon="close"
              aria-label={t('users.invite.actions.close')}
              onClick={onClose}
            />
          </div>

          {state.status === 'invited' ? (
            <div className="flex flex-col gap-md">
              <div
                role="status"
                className="flex items-start gap-sm rounded bg-secondary-fixed-dim p-sm font-body-sm text-body-sm text-on-secondary-fixed"
              >
                <Icon name="check_circle" size={18} />
                <p>
                  {t('users.invite.success', {
                    total: state.response.invites.length,
                  })}
                </p>
              </div>

              {/*
                The one place seat usage is readable: it arrives on the
                invite response itself. No endpoint reports it on its own,
                so the Users list cannot show it -- see the note in
                `SeatUsage`.
              */}
              <SeatUsage usage={state.response.seatUsage} />

              {state.response.invites.some(
                (invite) => !invite.emailDelivered,
              ) && (
                <p
                  role="alert"
                  className="font-body-sm text-body-sm text-on-surface-variant"
                >
                  {t('users.invite.deliveryWarning')}
                </p>
              )}

              <div className="flex justify-end">
                <Button onClick={onClose}>
                  {t('users.invite.actions.done')}
                </Button>
              </div>
            </div>
          ) : (
            <form
              className="flex flex-col gap-md"
              noValidate
              onSubmit={handleSubmit}
            >
              <div className="flex flex-col gap-xs">
                <label
                  className="font-label-caps text-label-caps uppercase tracking-wider text-on-surface-variant"
                  htmlFor="invite-emails"
                >
                  {t('users.invite.emailsLabel')}
                </label>
                <textarea
                  id="invite-emails"
                  rows={5}
                  value={raw}
                  onChange={(event) => {
                    setRaw(event.target.value);
                    if (state.status === 'error') {
                      setState({ status: 'editing' });
                    }
                  }}
                  placeholder={t('users.invite.emailsPlaceholder')}
                  aria-describedby="invite-emails-hint"
                  className="w-full rounded border border-outline-variant bg-surface-container-lowest p-sm font-body-sm text-body-sm text-on-surface transition-all focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary"
                />
                <p
                  id="invite-emails-hint"
                  className="font-body-sm text-body-sm text-on-surface-variant"
                >
                  {t('users.invite.emailsHint', { max: MAX_INVITES_PER_BATCH })}
                </p>
              </div>

              {emails.length > 0 && (
                <p className="font-body-sm text-body-sm text-on-surface-variant">
                  {t('users.invite.parsedCount', { total: emails.length })}
                </p>
              )}

              {invalidEmails.length > 0 && (
                <p
                  role="alert"
                  className="font-body-sm text-body-sm text-error"
                >
                  {t('users.invite.invalidEmails', {
                    emails: invalidEmails.join(', '),
                  })}
                </p>
              )}

              {tooMany && (
                <p
                  role="alert"
                  className="font-body-sm text-body-sm text-error"
                >
                  {t('users.invite.tooMany', { max: MAX_INVITES_PER_BATCH })}
                </p>
              )}

              {state.status === 'error' && (
                <div
                  role="alert"
                  className="flex items-start gap-sm rounded bg-error-container p-sm font-body-sm text-body-sm text-on-error-container"
                >
                  <Icon name="error" size={18} />
                  <p>{state.message}</p>
                </div>
              )}

              <div className="flex justify-end gap-sm">
                <Button variant="secondary" type="button" onClick={onClose}>
                  {t('users.invite.actions.cancel')}
                </Button>
                <Button type="submit" icon="send" disabled={!canSubmit}>
                  {state.status === 'submitting'
                    ? t('users.invite.actions.submitting')
                    : t('users.invite.actions.submit')}
                </Button>
              </div>
            </form>
          )}
        </div>
      </Card>
    </div>
  );
}
