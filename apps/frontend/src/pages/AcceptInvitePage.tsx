import { useState, type FormEvent, type ReactNode } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  AUTH_ERROR_CODES,
  USER_ERROR_CODES,
  USER_INVITE_TTL_HOURS,
} from '@flexi/shared-types';
import { Button, Card, Icon, Input } from '../components/ui';
import {
  describePasswordViolations,
  parsePasswordViolations,
} from '../auth/password-policy-message';
import { ApiError } from '../lib/api-client';
import { describeUserError } from '../lib/user-error-message';
import { redeemInvite } from '../lib/users-api';
import { PasswordPolicyNotice } from './ResetPasswordPage';

export interface AcceptInvitePageProps {
  /** Injectable for Storybook and focused UI tests; production uses the public API. */
  redeem?: typeof redeemInvite;
}

type RedemptionState =
  | { status: 'idle' }
  | { status: 'submitting' }
  | { status: 'completed' }
  /** The token is unknown, expired, revoked or already used -- one answer. */
  | { status: 'expired' }
  | { status: 'error'; message: string };

/**
 * Public claim of an invited account, a sibling of `/login`,
 * `/admin/login` and `/setup-account`.
 *
 * The token is read from the URL only when submitting and never copied
 * into state, storage or visible output -- the same handling
 * `SetupAccountPage` gives a First Admin setup secret. On success it is
 * stripped from the history entry rather than a new one being pushed.
 *
 * The backend answers every failed redemption with `INVITE_TOKEN_EXPIRED`,
 * whatever the real reason, so the invitee cannot use this endpoint to
 * discover which invites exist. This screen deliberately says the same one
 * thing back.
 */
export function AcceptInvitePage({
  redeem = redeemInvite,
}: AcceptInvitePageProps = {}) {
  const { t } = useTranslation();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const [fullName, setFullName] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [fullNameError, setFullNameError] = useState<string | null>(null);
  const [confirmPasswordError, setConfirmPasswordError] = useState<
    string | null
  >(null);
  const [policyViolations, setPolicyViolations] = useState<string[]>([]);
  const [state, setState] = useState<RedemptionState>({ status: 'idle' });

  const token = searchParams.get('token');

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFullNameError(null);
    setConfirmPasswordError(null);
    setPolicyViolations([]);

    let hasFieldError = false;
    if (!fullName.trim()) {
      setFullNameError(t('acceptInvite.fullNameRequired'));
      hasFieldError = true;
    }
    if (password !== confirmPassword) {
      setConfirmPasswordError(t('acceptInvite.passwordMismatch'));
      hasFieldError = true;
    }
    if (hasFieldError || !token) {
      return;
    }

    setState({ status: 'submitting' });
    try {
      await redeem({
        token,
        fullName: fullName.trim(),
        password,
        confirmPassword,
      });
      setState({ status: 'completed' });
      // The token has been consumed -- drop it from this history entry
      // without pushing a new one that could expose it on Back.
      navigate('/accept-invite', { replace: true });
    } catch (error) {
      handleFailure(error);
    }
  }

  function handleFailure(error: unknown) {
    const code = error instanceof ApiError ? error.code : null;

    if (code === USER_ERROR_CODES.INVITE_TOKEN_EXPIRED) {
      setState({ status: 'expired' });
      return;
    }

    if (code === AUTH_ERROR_CODES.PASSWORD_POLICY_VIOLATION) {
      // The server sends the same violation codes the local check
      // produces, so they render through the same translator.
      setPolicyViolations(
        describePasswordViolations(
          parsePasswordViolations((error as ApiError).message),
          t,
        ),
      );
      setState({ status: 'idle' });
      return;
    }

    setState({ status: 'error', message: describeUserError(error, t) });
  }

  if (state.status === 'completed') {
    return (
      <AcceptInviteCard
        icon="check_circle"
        title={t('acceptInvite.successTitle')}
        body={t('acceptInvite.successBody')}
      >
        <Button fullWidth icon="login" onClick={() => navigate('/login')}>
          {t('acceptInvite.goToLogin')}
        </Button>
      </AcceptInviteCard>
    );
  }

  if (!token || state.status === 'expired') {
    return (
      <AcceptInviteCard
        icon="error"
        tone="error"
        title={t('acceptInvite.expiredTitle')}
        body={t('acceptInvite.expiredBody')}
      >
        <Button
          variant="secondary"
          fullWidth
          onClick={() => navigate('/login')}
        >
          {t('acceptInvite.goToLogin')}
        </Button>
      </AcceptInviteCard>
    );
  }

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-background p-lg">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -top-32 -right-32 h-96 w-96 rounded-full bg-primary-container opacity-20 blur-3xl"
      />

      <Card className="relative w-full max-w-md" padded={false}>
        <div className="flex flex-col gap-lg p-xl">
          <div className="flex flex-col items-center gap-sm text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-primary-container text-on-primary-container shadow-sm">
              <Icon name="person_add" size={24} />
            </div>
            <div>
              <h1 className="font-headline-md text-headline-md text-on-surface">
                {t('acceptInvite.title')}
              </h1>
              <p className="font-body-sm text-body-sm text-on-surface-variant">
                {t('acceptInvite.subtitle', { hours: USER_INVITE_TTL_HOURS })}
              </p>
            </div>
          </div>

          <form
            className="flex flex-col gap-md"
            noValidate
            onSubmit={handleSubmit}
          >
            <Input
              label={t('acceptInvite.fullName')}
              icon="person"
              value={fullName}
              onChange={(event) => {
                setFullName(event.target.value);
                setFullNameError(null);
              }}
              error={fullNameError ?? undefined}
              required
              autoComplete="name"
            />
            <Input
              label={t('acceptInvite.password')}
              icon="lock"
              type="password"
              value={password}
              onChange={(event) => {
                setPassword(event.target.value);
                setPolicyViolations([]);
              }}
              required
              autoComplete="new-password"
            />
            <Input
              label={t('acceptInvite.confirmPassword')}
              icon="lock"
              type="password"
              value={confirmPassword}
              onChange={(event) => {
                setConfirmPassword(event.target.value);
                setConfirmPasswordError(null);
              }}
              error={confirmPasswordError ?? undefined}
              required
              autoComplete="new-password"
            />

            <PasswordPolicyNotice violations={policyViolations} />

            {state.status === 'error' && (
              <div
                role="alert"
                className="flex items-start gap-sm rounded bg-error-container p-sm font-body-sm text-body-sm text-on-error-container"
              >
                <Icon name="error" size={18} />
                <p>{state.message}</p>
              </div>
            )}

            <Button
              type="submit"
              fullWidth
              icon="check"
              disabled={state.status === 'submitting'}
            >
              {state.status === 'submitting'
                ? t('acceptInvite.submitting')
                : t('acceptInvite.submit')}
            </Button>
          </form>
        </div>
      </Card>
    </div>
  );
}

function AcceptInviteCard({
  icon,
  title,
  body,
  tone = 'primary',
  children,
}: {
  icon: string;
  title: string;
  body: string;
  tone?: 'primary' | 'error';
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-lg">
      <Card className="w-full max-w-md" padded={false}>
        <div className="flex flex-col items-center gap-lg p-xl text-center">
          <div
            className={[
              'flex h-12 w-12 items-center justify-center rounded-lg shadow-sm',
              tone === 'error'
                ? 'bg-error-container text-on-error-container'
                : 'bg-primary-container text-on-primary-container',
            ].join(' ')}
          >
            <Icon name={icon} size={24} />
          </div>
          <div className="flex flex-col gap-sm">
            <h1 className="font-headline-md text-headline-md text-on-surface">
              {title}
            </h1>
            <p className="font-body-sm text-body-sm text-on-surface-variant">
              {body}
            </p>
          </div>
          {children}
        </div>
      </Card>
    </div>
  );
}
