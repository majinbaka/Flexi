import { useState, type FormEvent } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../auth/AuthContext';
import { ApiError } from '../lib/api-client';
import { Button, Card, Icon, Input } from '../components/ui';

/**
 * System Admin login (`/admin/login`). Same `POST /auth/login` endpoint as
 * the tenant LoginPage, but omits `x-tenant-id` entirely -- the backend
 * resolves system vs. tenant login by that header's absence/presence (see
 * auth.controller.ts).
 */
export function AdminLoginPage() {
  const { t } = useTranslation();
  const { accessToken, login } = useAuth();
  const navigate = useNavigate();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [emailError, setEmailError] = useState<string | null>(null);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  if (accessToken) {
    return <Navigate to="/" replace />;
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setEmailError(null);
    setPasswordError(null);

    const trimmedEmail = email.trim();
    let hasFieldError = false;
    if (!trimmedEmail) {
      setEmailError(t('auth.emailRequired'));
      hasFieldError = true;
    }
    if (!password.trim()) {
      setPasswordError(t('auth.passwordRequired'));
      hasFieldError = true;
    }
    if (hasFieldError) {
      return;
    }

    setSubmitting(true);
    try {
      await login(trimmedEmail, password);
      navigate('/', { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('auth.unknownError'));
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
              <Icon name="admin_panel_settings" size={24} />
            </div>
            <div>
              <h1 className="font-headline-md text-headline-md text-on-surface">
                {t('auth.adminLoginTitle')}
              </h1>
              <p className="font-body-sm text-body-sm text-on-surface-variant">
                {t('auth.adminLoginSubtitle')}
              </p>
            </div>
          </div>

          <form className="flex flex-col gap-md" onSubmit={handleSubmit}>
            <Input
              label={t('auth.email')}
              icon="mail"
              type="email"
              value={email}
              onChange={(e) => {
                setEmail(e.target.value);
                setEmailError(null);
              }}
              error={emailError ?? undefined}
              required
              autoComplete="username"
            />
            <Input
              label={t('auth.password')}
              icon="lock"
              type="password"
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
                setPasswordError(null);
              }}
              error={passwordError ?? undefined}
              required
              autoComplete="current-password"
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

            <Button type="submit" fullWidth disabled={submitting} icon="login">
              {submitting ? t('auth.loggingIn') : t('auth.login')}
            </Button>
          </form>
        </div>
      </Card>
    </div>
  );
}
