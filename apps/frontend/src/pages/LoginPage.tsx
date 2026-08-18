import { useState, type CSSProperties, type FormEvent } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../auth/AuthContext';
import { ApiError } from '../lib/api-client';

const formStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '0.75rem',
  maxWidth: 320,
};

const labelStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '0.25rem',
  fontSize: '0.9rem',
};

const inputStyle: CSSProperties = {
  padding: '0.5rem',
  borderRadius: 6,
  border: '1px solid #333',
  background: 'transparent',
  color: 'inherit',
};

const errorStyle: CSSProperties = {
  color: '#e5484d',
};

/**
 * Tenant User login (`/login`). Always sends `x-tenant-id` from a
 * required "Tenant ID" field alongside email/password -- see spec
 * Boundaries. System Admin login (`/admin/login`) is deferred.
 */
export function LoginPage() {
  const { t } = useTranslation();
  const { accessToken, login } = useAuth();
  const navigate = useNavigate();

  const [tenantId, setTenantId] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
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
    setSubmitting(true);
    try {
      await login(email, password, tenantId);
      navigate('/', { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('auth.unknownError'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <div>
        <h1>{t('auth.loginTitle')}</h1>
        <form style={formStyle} onSubmit={handleSubmit}>
          <label style={labelStyle}>
            {t('auth.tenantId')}
            <input
              style={inputStyle}
              type="text"
              value={tenantId}
              onChange={(e) => setTenantId(e.target.value)}
              required
              autoComplete="off"
            />
          </label>
          <label style={labelStyle}>
            {t('auth.email')}
            <input
              style={inputStyle}
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoComplete="username"
            />
          </label>
          <label style={labelStyle}>
            {t('auth.password')}
            <input
              style={inputStyle}
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              autoComplete="current-password"
            />
          </label>
          {error && (
            <p style={errorStyle} aria-live="polite">
              {error}
            </p>
          )}
          <button type="submit" disabled={submitting}>
            {submitting ? t('auth.loggingIn') : t('auth.login')}
          </button>
        </form>
      </div>
    </div>
  );
}
