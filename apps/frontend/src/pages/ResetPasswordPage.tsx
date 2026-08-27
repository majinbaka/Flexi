import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  AUTH_ERROR_CODES,
  PASSWORD_RESET_OTP_LENGTH,
  type ResetPasswordRequestDto,
  type ResetPasswordResponseDto,
} from '@flexi/shared-types';
import { Button, Card, Icon, Input } from '../components/ui';
import { ApiError, apiPost, RATE_LIMITED_ERROR_CODE } from '../lib/api-client';
import {
  describeLocalPasswordViolations,
  describePasswordViolations,
  parsePasswordViolations,
} from '../auth/password-policy-message';

export interface ResetPasswordPageProps {
  /** Injectable for Storybook and focused UI tests; production uses the public API. */
  resetPassword?: (
    request: ResetPasswordRequestDto,
    tenantId?: string,
  ) => Promise<ResetPasswordResponseDto>;
}

function defaultResetPassword(
  request: ResetPasswordRequestDto,
  tenantId?: string,
): Promise<ResetPasswordResponseDto> {
  return apiPost<ResetPasswordResponseDto>('/auth/reset-password', request, {
    headers: tenantId ? { 'x-tenant-id': tenantId } : {},
    skipAuth: true,
  });
}

/**
 * Redeems an emailed reset code (`/reset-password`).
 *
 * Errors are branched on `AUTH_ERROR_CODES`, never on the server's message
 * text, which is server-authored and untranslated. `INVALID_OTP` covers
 * every failure the server collapses together -- wrong code, expired code,
 * no code outstanding, unknown address, attempt budget spent -- so the copy
 * for it has to stay as uninformative as the response, or the screen would
 * leak what the endpoint went out of its way not to.
 */
export function ResetPasswordPage({
  resetPassword = defaultResetPassword,
}: ResetPasswordPageProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const [email, setEmail] = useState(searchParams.get('email') ?? '');
  const [tenantId, setTenantId] = useState(searchParams.get('tenantId') ?? '');
  const [otp, setOtp] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');

  const [emailError, setEmailError] = useState<string | null>(null);
  const [otpError, setOtpError] = useState<string | null>(null);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [policyViolations, setPolicyViolations] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [completed, setCompleted] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setEmailError(null);
    setOtpError(null);
    setConfirmError(null);
    setPolicyViolations([]);
    setError(null);

    const trimmedEmail = email.trim();
    const trimmedOtp = otp.trim();
    let hasFieldError = false;

    if (!trimmedEmail) {
      setEmailError(t('auth.emailRequired'));
      hasFieldError = true;
    }
    if (!trimmedOtp) {
      setOtpError(t('resetPassword.codeRequired'));
      hasFieldError = true;
    }
    if (newPassword !== confirmPassword) {
      setConfirmError(t('setupAccount.passwordMismatch'));
      hasFieldError = true;
    }

    // Checked locally with the same function the server enforces, so every
    // unmet requirement is shown at once rather than discovered one submit
    // at a time.
    const localViolations = describeLocalPasswordViolations(newPassword, t);
    if (localViolations.length > 0) {
      setPolicyViolations(localViolations);
      hasFieldError = true;
    }

    if (hasFieldError) {
      return;
    }

    setSubmitting(true);
    try {
      await resetPassword(
        { email: trimmedEmail, otp: trimmedOtp, newPassword },
        tenantId.trim() || undefined,
      );
      setCompleted(true);
    } catch (err) {
      handleFailure(err);
    } finally {
      setSubmitting(false);
    }
  }

  function handleFailure(err: unknown) {
    if (!(err instanceof ApiError)) {
      setError(t('auth.unknownError'));
      return;
    }

    if (err.code === RATE_LIMITED_ERROR_CODE) {
      setError(t('auth.tooManyRequests'));
      return;
    }

    if (err.code === AUTH_ERROR_CODES.PASSWORD_POLICY_VIOLATION) {
      // The server sends the same violation codes the local check produces,
      // so they render through the same translator.
      setPolicyViolations(
        describePasswordViolations(parsePasswordViolations(err.message), t),
      );
      return;
    }

    if (err.code === AUTH_ERROR_CODES.INVALID_OTP) {
      setError(t('resetPassword.invalidCode'));
      return;
    }

    setError(t('auth.unknownError'));
  }

  if (completed) {
    return (
      <div className="min-h-screen flex items-center justify-center p-lg bg-background">
        <Card className="w-full max-w-md" padded={false}>
          <div className="p-xl flex flex-col items-center gap-lg text-center">
            <div className="w-12 h-12 rounded-lg bg-primary-container text-on-primary-container flex items-center justify-center shadow-sm">
              <Icon name="check_circle" size={24} />
            </div>
            <div className="flex flex-col gap-sm">
              <h1 className="font-headline-md text-headline-md text-on-surface">
                {t('resetPassword.successTitle')}
              </h1>
              <p className="font-body-sm text-body-sm text-on-surface-variant">
                {t('resetPassword.successBody')}
              </p>
            </div>
            <Button fullWidth icon="login" onClick={() => navigate('/login')}>
              {t('setupAccount.goToLogin')}
            </Button>
          </div>
        </Card>
      </div>
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
              <Icon name="password" size={24} />
            </div>
            <div>
              <h1 className="font-headline-md text-headline-md text-on-surface">
                {t('resetPassword.title')}
              </h1>
              <p className="font-body-sm text-body-sm text-on-surface-variant">
                {t('resetPassword.subtitle', {
                  length: PASSWORD_RESET_OTP_LENGTH,
                })}
              </p>
            </div>
          </div>

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
            <Input
              label={t('resetPassword.code')}
              icon="pin"
              type="text"
              inputMode="numeric"
              maxLength={PASSWORD_RESET_OTP_LENGTH}
              value={otp}
              onChange={(event) => {
                setOtp(event.target.value);
                setOtpError(null);
              }}
              error={otpError ?? undefined}
              required
              autoComplete="one-time-code"
            />
            <Input
              label={t('resetPassword.newPassword')}
              icon="lock"
              type="password"
              value={newPassword}
              onChange={(event) => {
                setNewPassword(event.target.value);
                setPolicyViolations([]);
              }}
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
                setConfirmError(null);
              }}
              error={confirmError ?? undefined}
              required
              autoComplete="new-password"
            />

            <PasswordPolicyNotice violations={policyViolations} />

            {error && (
              <div
                aria-live="polite"
                className="flex items-start gap-sm p-sm rounded bg-error-container text-on-error-container font-body-sm text-body-sm"
              >
                <Icon name="error" size={18} />
                <p>{error}</p>
              </div>
            )}

            <Button type="submit" fullWidth disabled={submitting} icon="check">
              {submitting
                ? t('resetPassword.submitting')
                : t('resetPassword.submit')}
            </Button>
          </form>

          <p className="text-center font-body-sm text-body-sm text-on-surface-variant">
            <Link className="text-primary underline" to="/forgot-password">
              {t('resetPassword.requestNewCode')}
            </Link>
          </p>
        </div>
      </Card>
    </div>
  );
}

/**
 * Renders every unmet password rule together. Shared by this page and
 * ChangePasswordPage so the two never drift in how they present the policy.
 */
export function PasswordPolicyNotice({
  violations,
}: {
  violations: readonly string[];
}) {
  const { t } = useTranslation();

  if (violations.length === 0) {
    return null;
  }

  return (
    <div
      aria-live="polite"
      className="flex items-start gap-sm p-sm rounded bg-error-container text-on-error-container font-body-sm text-body-sm"
    >
      <Icon name="error" size={18} />
      <div>
        <p>{t('password.policy.title')}</p>
        <ul className="list-disc pl-4">
          {violations.map((violation) => (
            <li key={violation}>{violation}</li>
          ))}
        </ul>
      </div>
    </div>
  );
}
