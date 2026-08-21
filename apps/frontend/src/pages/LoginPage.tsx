import { useState, type FormEvent } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../auth/AuthContext';
import { getLoginErrorMessage } from '../auth/login-error';
import { Button, Card, Icon, Input } from '../components/ui';

/**
 * Tenant User login (`/login`). Always sends `x-tenant-id` from a
 * required "Tenant ID" field alongside email/password -- see spec
 * Boundaries. System Admin login lives at `/admin/login` (AdminLoginPage).
 */
export function LoginPage() {
  const { t } = useTranslation();
  const { accessToken, login } = useAuth();
  const navigate = useNavigate();

  const [tenantId, setTenantId] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [tenantIdError, setTenantIdError] = useState<string | null>(null);
  const [emailError, setEmailError] = useState<string | null>(null);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Already authenticated (e.g. navigated back to /login manually, or a
  // stored session survived) -- go straight to the app instead of
  // showing the form again.
  if (accessToken) {
    return <Navigate to="/" replace />;
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setTenantIdError(null);
    setEmailError(null);
    setPasswordError(null);

    const trimmedTenantId = tenantId.trim();
    const trimmedEmail = email.trim();
    let hasFieldError = false;
    if (!trimmedTenantId) {
      setTenantIdError(t('auth.tenantIdRequired'));
      hasFieldError = true;
    }
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
      await login(trimmedEmail, password, trimmedTenantId);
      navigate('/', { replace: true });
    } catch (err) {
      setError(getLoginErrorMessage(err, t));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="relative min-h-screen flex items-center justify-center p-lg bg-background overflow-hidden">
      {/* Soft primary wash behind the card, as on the Stitch screens. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -top-32 -right-32 w-96 h-96 rounded-full bg-primary-container opacity-20 blur-3xl"
      />

      <Card className="relative w-full max-w-md" padded={false}>
        <div className="p-xl flex flex-col gap-lg">
          <div className="flex flex-col items-center gap-sm text-center">
            <div className="w-12 h-12 rounded-lg bg-primary-container flex items-center justify-center text-on-primary-container shadow-sm">
              <Icon name="dataset" size={24} />
            </div>
            <div>
              <h1 className="font-headline-md text-headline-md text-on-surface">
                {t('auth.loginTitle')}
              </h1>
              <p className="font-body-sm text-body-sm text-on-surface-variant">
                {t('auth.loginSubtitle')}
              </p>
            </div>
          </div>

          <form className="flex flex-col gap-md" onSubmit={handleSubmit}>
            <Input
              label={t('auth.tenantId')}
              icon="apartment"
              type="text"
              value={tenantId}
              onChange={(e) => {
                setTenantId(e.target.value);
                setTenantIdError(null);
              }}
              error={tenantIdError ?? undefined}
              required
              autoComplete="off"
            />
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
