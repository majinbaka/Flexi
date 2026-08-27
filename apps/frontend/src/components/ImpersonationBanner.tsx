import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../auth/AuthContext';
import { isImpersonating } from '../auth/permissions';
import { endImpersonation } from '../lib/users-api';
import { describeUserError } from '../lib/user-error-message';
import { Button, Icon } from './ui';

export interface ImpersonationBannerProps {
  /** Injectable for Storybook and focused UI tests. */
  endSession?: () => Promise<void>;
}

/**
 * Permanent warning that the session in this tab belongs to somebody else.
 *
 * Rendered from `impersonatedBy` on the access token, which only
 * `ImpersonationService` can set -- there is no dismiss control and no
 * client-side state that could hide it, so an impersonated session cannot
 * be made to look like an ordinary one.
 *
 * Anchored to the bottom of the viewport rather than the top: the shell's
 * sidebar and header are both `fixed` at `top-0` and the page canvas is
 * offset to clear them, so a top banner would either cover the breadcrumb
 * or force every one of those offsets to become conditional. The bottom
 * edge is unoccupied, and `z-50` keeps the banner above the sidebar.
 *
 * Exiting revokes the impersonation session server-side and then clears
 * this browser's session outright. It does not "switch back": an
 * impersonation token is minted without a refresh token (see the Users
 * specification), so there is nothing here to restore -- the System Admin
 * signs in again on their own credentials.
 */
export function ImpersonationBanner({
  endSession = endImpersonation,
}: ImpersonationBannerProps = {}) {
  const { t } = useTranslation();
  const { currentUser, logout } = useAuth();
  const navigate = useNavigate();
  const [exiting, setExiting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!isImpersonating(currentUser)) {
    return null;
  }

  async function handleExit() {
    setExiting(true);
    setError(null);
    try {
      await endSession();
    } catch (caught) {
      // The local session is cleared regardless -- leaving the operator
      // inside somebody else's identity because a revoke call failed is
      // worse than the failed revoke. The token expires in <= 15 minutes
      // on its own, so the message is informational, not a blocker.
      setError(describeUserError(caught, t));
    }
    await logout();
    navigate('/admin/login', { replace: true });
  }

  return (
    <div
      role="alert"
      aria-live="assertive"
      className="fixed bottom-0 inset-x-0 z-50 bg-error text-on-error shadow-sm"
    >
      <div className="flex flex-wrap items-center justify-between gap-sm px-lg py-sm">
        <p className="flex items-center gap-sm font-body-sm text-body-sm">
          <Icon name="warning" size={18} />
          <span>
            {t('impersonation.banner', {
              email: currentUser?.email ?? '',
            })}
          </span>
        </p>

        <div className="flex items-center gap-sm">
          {error && <span className="font-body-sm text-body-sm">{error}</span>}
          <Button
            variant="secondary"
            size="sm"
            icon="logout"
            disabled={exiting}
            onClick={handleExit}
          >
            {exiting ? t('impersonation.exiting') : t('impersonation.exit')}
          </Button>
        </div>
      </div>
    </div>
  );
}
