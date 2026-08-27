import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  PASSWORD_RESET_OTP_COOLDOWN_SECONDS,
  type ForgotPasswordRequestDto,
  type ForgotPasswordResponseDto,
} from '@flexi/shared-types';
import { Button, Card, Icon, Input } from '../components/ui';
import { ApiError, apiPost, RATE_LIMITED_ERROR_CODE } from '../lib/api-client';

export interface ForgotPasswordPageProps {
  /** Injectable for Storybook and focused UI tests; production uses the public API. */
  requestPasswordReset?: (
    request: ForgotPasswordRequestDto,
    tenantId?: string,
  ) => Promise<ForgotPasswordResponseDto>;
}

function defaultRequestPasswordReset(
  request: ForgotPasswordRequestDto,
  tenantId?: string,
): Promise<ForgotPasswordResponseDto> {
  return apiPost<ForgotPasswordResponseDto>('/auth/forgot-password', request, {
    headers: tenantId ? { 'x-tenant-id': tenantId } : {},
    // Deliberately public: recovery must work for somebody who cannot sign
    // in, and must not ride whatever session happens to exist in this
    // browser.
    skipAuth: true,
  });
}

/**
 * Requests an emailed password-reset code (`/forgot-password`).
 *
 * The confirmation is deliberately identical whatever happened -- whether
 * the address has an account, whether that account is active, whether a
 * code was actually sent. The endpoint answers `200` in every one of those
 * cases precisely so this screen cannot be used to find out which addresses
 * are registered, and the copy has to hold that line too.
 *
 * `tenantId` mirrors login: present routes to a tenant account, absent to a
 * system one. It is optional here because a user arriving from `/login`
 * knows their tenant, while one arriving from `/admin/login` does not have
 * one at all.
 */
export function ForgotPasswordPage({
  requestPasswordReset = defaultRequestPasswordReset,
}: ForgotPasswordPageProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const [email, setEmail] = useState(searchParams.get('email') ?? '');
  const [tenantId, setTenantId] = useState(searchParams.get('tenantId') ?? '');
  const [emailError, setEmailError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [sent, setSent] = useState(false);
  const [cooldownRemaining, setCooldownRemaining] = useState(0);

  // Mirrors the server's per-account cooldown so the button cannot be
  // hammered into a 429 that the user has no way to interpret. It is a
  // courtesy, not the enforcement -- that lives on the server.
  useEffect(() => {
    if (cooldownRemaining <= 0) {
      return;
    }

    const timer = window.setTimeout(
      () => setCooldownRemaining((remaining) => remaining - 1),
      1000,
    );
    return () => window.clearTimeout(timer);
  }, [cooldownRemaining]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setEmailError(null);
    setError(null);

    const trimmedEmail = email.trim();
    if (!trimmedEmail) {
      setEmailError(t('auth.emailRequired'));
      return;
    }

    const trimmedTenantId = tenantId.trim();

    setSubmitting(true);
    try {
      await requestPasswordReset(
        { email: trimmedEmail },
        trimmedTenantId || undefined,
      );
      setSent(true);
      setCooldownRemaining(PASSWORD_RESET_OTP_COOLDOWN_SECONDS);
    } catch (err) {
      setError(
        err instanceof ApiError && err.code === RATE_LIMITED_ERROR_CODE
          ? t('auth.tooManyRequests')
          : t('auth.unknownError'),
      );
    } finally {
      setSubmitting(false);
    }
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
              <Icon name="lock_reset" size={24} />
            </div>
            <div>
              <h1 className="font-headline-md text-headline-md text-on-surface">
                {t('forgotPassword.title')}
              </h1>
              <p className="font-body-sm text-body-sm text-on-surface-variant">
                {t('forgotPassword.subtitle')}
              </p>
            </div>
          </div>

          {sent && (
            <div
              aria-live="polite"
              className="flex items-start gap-sm p-sm rounded bg-primary-container text-on-primary-container font-body-sm text-body-sm"
            >
              <Icon name="mark_email_read" size={18} />
              <p>{t('forgotPassword.sentBody')}</p>
            </div>
          )}

          <form
            className="flex flex-col gap-md"
            noValidate
            onSubmit={handleSubmit}
          >
            <Input
              label={t('auth.email')}
              icon="mail"
              type="email"
              value={email}
              onChange={(event) => {
                setEmail(event.target.value);
                setEmailError(null);
              }}
              error={emailError ?? undefined}
              required
              autoComplete="username"
            />
            <Input
              label={t('forgotPassword.tenantIdOptional')}
              icon="apartment"
              type="text"
              value={tenantId}
              onChange={(event) => setTenantId(event.target.value)}
              autoComplete="off"
            />

            {error && (
              <div
                aria-live="polite"
                className="flex items-start gap-sm p-sm rounded bg-error-container text-on-error-container font-body-sm text-body-sm"
              >
                <Icon name="error" size={18} />
                <p>{error}</p>
              </div>
            )}

            <Button
              type="submit"
              fullWidth
              disabled={submitting || cooldownRemaining > 0}
              icon="send"
            >
              {submitting
                ? t('forgotPassword.sending')
                : cooldownRemaining > 0
                  ? t('forgotPassword.resendIn', { seconds: cooldownRemaining })
                  : sent
                    ? t('forgotPassword.resend')
                    : t('forgotPassword.submit')}
            </Button>

            {sent && (
              <Button
                type="button"
                variant="secondary"
                fullWidth
                icon="password"
                onClick={() =>
                  navigate(
                    `/reset-password?email=${encodeURIComponent(email.trim())}` +
                      (tenantId.trim()
                        ? `&tenantId=${encodeURIComponent(tenantId.trim())}`
                        : ''),
                  )
                }
              >
                {t('forgotPassword.enterCode')}
              </Button>
            )}
          </form>

          <p className="text-center font-body-sm text-body-sm text-on-surface-variant">
            <Link className="text-primary underline" to="/login">
              {t('forgotPassword.backToLogin')}
            </Link>
          </p>
        </div>
      </Card>
    </div>
  );
}
