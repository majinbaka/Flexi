import { useState, type FormEvent, type ReactNode } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type {
  RedeemSetupTokenRequestDto,
  RedeemSetupTokenResponseDto,
} from '@flexi/shared-types';
import { Button, Card, Icon, Input } from '../components/ui';
import { ApiError, apiPost } from '../lib/api-client';

type RedemptionState =
  | { status: 'idle' }
  | { status: 'submitting' }
  | { status: 'completed' }
  | { status: 'expired' }
  | { status: 'error' };

export interface SetupAccountPageProps {
  /** Injectable for Storybook and focused UI tests; production uses the public API. */
  redeemSetupToken?: (
    request: RedeemSetupTokenRequestDto,
  ) => Promise<RedeemSetupTokenResponseDto>;
}

function defaultRedeemSetupToken(
  request: RedeemSetupTokenRequestDto,
): Promise<RedeemSetupTokenResponseDto> {
  return apiPost<RedeemSetupTokenResponseDto>('/v1/setup/redeem', request, {
    // Account claiming is intentionally public and must not reuse a session
    // that happens to exist in this browser.
    skipAuth: true,
  });
}

/**
 * Public, one-time First Admin account claim. The setup secret is read from
 * the URL only when submitting and is never copied to state, storage, output,
 * or visible UI.
 */
export function SetupAccountPage({
  redeemSetupToken = defaultRedeemSetupToken,
}: SetupAccountPageProps) {
  const { t } = useTranslation();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [confirmPasswordError, setConfirmPasswordError] = useState<
    string | null
  >(null);
  const [state, setState] = useState<RedemptionState>({ status: 'idle' });

  // Do not retain this value in React state: it remains solely in the URL
  // until it is sent as the request body, then is removed from browser history.
  const token = searchParams.get('token');

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPasswordError(null);
    setConfirmPasswordError(null);

    let hasFieldError = false;
    if (!password.trim()) {
      setPasswordError(t('setupAccount.passwordRequired'));
      hasFieldError = true;
    }
    if (password !== confirmPassword) {
      setConfirmPasswordError(t('setupAccount.passwordMismatch'));
      hasFieldError = true;
    }
    if (hasFieldError || !token) {
      return;
    }

    setState({ status: 'submitting' });
    try {
      await redeemSetupToken({ token, password });
      setState({ status: 'completed' });
      // The secret has been consumed, so remove it from the current history
      // entry without adding a new entry that could expose it on Back.
      navigate('/setup-account', { replace: true });
    } catch (error) {
      setState({
        status:
          error instanceof ApiError && error.code === 'INVALID_SETUP_TOKEN'
            ? 'expired'
            : 'error',
      });
    }
  }

  if (state.status === 'completed') {
    return (
      <SetupAccountCard
        icon="check_circle"
        title={t('setupAccount.successTitle')}
        body={t('setupAccount.successBody')}
      >
        <Button fullWidth icon="login" onClick={() => navigate('/login')}>
          {t('setupAccount.goToLogin')}
        </Button>
      </SetupAccountCard>
    );
  }

  if (!token || state.status === 'expired') {
    return (
      <SetupAccountCard
        icon="error"
        title={t('setupAccount.expiredTitle')}
        body={t('setupAccount.expiredBody')}
        tone="error"
      >
        <Button
          variant="secondary"
          fullWidth
          onClick={() => navigate('/login')}
        >
          {t('setupAccount.goToLogin')}
        </Button>
      </SetupAccountCard>
    );
  }

  return (
    <div className="relative min-h-screen flex items-center justify-center p-lg bg-background overflow-hidden">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -top-32 -right-32 w-96 h-96 rounded-full bg-primary-container opacity-20 blur-3xl"
      />

      <Card className="relative w-full max-w-md" padded={false}>
        <div className="p-xl flex flex-col gap-lg">
          <div className="flex flex-col items-center gap-sm text-center">
            <div className="w-12 h-12 rounded-lg bg-primary-container flex items-center justify-center text-on-primary-container shadow-sm">
              <Icon name="lock" size={24} />
            </div>
            <div>
              <h1 className="font-headline-md text-headline-md text-on-surface">
                {t('setupAccount.title')}
              </h1>
              <p className="font-body-sm text-body-sm text-on-surface-variant">
                {t('setupAccount.subtitle')}
              </p>
            </div>
          </div>

          <form
            className="flex flex-col gap-md"
            noValidate
            onSubmit={handleSubmit}
          >
            <Input
              label={t('setupAccount.password')}
              icon="lock"
              type="password"
              value={password}
              onChange={(event) => {
                setPassword(event.target.value);
                setPasswordError(null);
              }}
              error={passwordError ?? undefined}
              required
              autoComplete="new-password"
            />
            <Input
              label={t('setupAccount.confirmPassword')}
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

            {state.status === 'error' && (
              <div
                aria-live="polite"
                className="flex items-start gap-sm p-sm rounded bg-error-container text-on-error-container font-body-sm text-body-sm"
              >
                <Icon name="error" size={18} />
                <p>{t('setupAccount.genericError')}</p>
              </div>
            )}

            <Button
              type="submit"
              fullWidth
              disabled={state.status === 'submitting'}
              icon="check"
            >
              {state.status === 'submitting'
                ? t('setupAccount.submitting')
                : t('setupAccount.submit')}
            </Button>
          </form>
        </div>
      </Card>
    </div>
  );
}

function SetupAccountCard({
  icon,
  title,
  body,
  tone = 'success',
  children,
}: {
  icon: string;
  title: string;
  body: string;
  tone?: 'success' | 'error';
  children: ReactNode;
}) {
  const isError = tone === 'error';

  return (
    <div className="min-h-screen flex items-center justify-center p-lg bg-background">
      <Card className="w-full max-w-md" padded={false}>
        <div className="p-xl flex flex-col items-center gap-lg text-center">
          <div
            className={`w-12 h-12 rounded-lg flex items-center justify-center shadow-sm ${
              isError
                ? 'bg-error-container text-on-error-container'
                : 'bg-primary-container text-on-primary-container'
            }`}
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
          <div className="w-full">{children}</div>
        </div>
      </Card>
    </div>
  );
}
