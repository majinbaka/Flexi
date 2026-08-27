import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  AUTH_ERROR_CODES,
  type ChangePasswordRequestDto,
  type ChangePasswordResponseDto,
} from '@flexi/shared-types';
import { useAuth } from '../auth/AuthContext';
import { Button, Card, Icon, Input } from '../components/ui';
import { ApiError, apiPost } from '../lib/api-client';
import { describeLocalPasswordViolations } from '../auth/password-policy-message';
import { PasswordPolicyNotice } from './ResetPasswordPage';

export interface ChangePasswordPageProps {
  /** Injectable for Storybook and focused UI tests; production uses the API. */
  changePassword?: (
    request: ChangePasswordRequestDto,
  ) => Promise<ChangePasswordResponseDto>;
}

function defaultChangePassword(
  request: ChangePasswordRequestDto,
): Promise<ChangePasswordResponseDto> {
  return apiPost<ChangePasswordResponseDto>('/auth/change-password', request);
}

/**
 * Lets a signed-in holder replace their own password (`/change-password`).
 *
 * Also the destination `ProtectedRoute` forces somebody under an admin
 * force-reset to, which is why the screen explains itself when
 * `mustChangePassword` is set instead of looking like an ordinary settings
 * page the user wandered into.
 *
 * On success the session is reloaded rather than merely re-fetched:
 * `mustChangePassword` on `GET /api/auth/me` comes from the access token,
 * which is a snapshot from issuance time, so the flag only clears once the
 * token has been rotated.
 */
export function ChangePasswordPage({
  changePassword = defaultChangePassword,
}: ChangePasswordPageProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { currentUser, reloadSession } = useAuth();

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [currentPasswordError, setCurrentPasswordError] = useState<
    string | null
  >(null);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [policyViolations, setPolicyViolations] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const forced = currentUser?.mustChangePassword === true;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setCurrentPasswordError(null);
    setConfirmError(null);
    setPolicyViolations([]);
    setError(null);

    let hasFieldError = false;
    if (!currentPassword.trim()) {
      setCurrentPasswordError(t('auth.passwordRequired'));
      hasFieldError = true;
    }
    if (newPassword !== confirmPassword) {
      setConfirmError(t('setupAccount.passwordMismatch'));
      hasFieldError = true;
    }

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
      await changePassword({ currentPassword, newPassword });
      // Rotate the token so the cleared flag actually reaches the client,
      // then leave the flow.
      await reloadSession();
      navigate('/', { replace: true });
    } catch (err) {
      if (
        err instanceof ApiError &&
        err.code === AUTH_ERROR_CODES.INVALID_CREDENTIALS
      ) {
        setCurrentPasswordError(t('changePassword.wrongCurrentPassword'));
      } else {
        setError(t('auth.unknownError'));
      }
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
              <Icon name="key" size={24} />
            </div>
            <div>
              <h1 className="font-headline-md text-headline-md text-on-surface">
                {t('changePassword.title')}
              </h1>
              <p className="font-body-sm text-body-sm text-on-surface-variant">
                {forced
                  ? t('changePassword.forcedSubtitle')
                  : t('changePassword.subtitle')}
              </p>
            </div>
          </div>

          <form
            className="flex flex-col gap-md"
            noValidate
            onSubmit={handleSubmit}
          >
            <Input
              label={t('changePassword.currentPassword')}
              icon="lock"
              type="password"
              value={currentPassword}
              onChange={(event) => {
                setCurrentPassword(event.target.value);
                setCurrentPasswordError(null);
              }}
              error={currentPasswordError ?? undefined}
              required
              autoComplete="current-password"
            />
            <Input
              label={t('changePassword.newPassword')}
              icon="lock_reset"
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
              icon="lock_reset"
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
                ? t('changePassword.submitting')
                : t('changePassword.submit')}
            </Button>
          </form>
        </div>
      </Card>
    </div>
  );
}
