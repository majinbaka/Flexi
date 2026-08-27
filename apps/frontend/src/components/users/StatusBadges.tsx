import { useTranslation } from 'react-i18next';
import { TenantUserStatus, UserInviteStatus } from '@flexi/shared-types';
import { Badge, type BadgeTone } from '../ui';

/**
 * Lifecycle state as a chip.
 *
 * Both maps are exhaustive `Record`s over their enum, so a status added to
 * `@flexi/shared-types` fails to compile here rather than rendering as a
 * blank badge with an untranslated key.
 */

const USER_STATUS_TONES: Record<TenantUserStatus, BadgeTone> = {
  [TenantUserStatus.ACTIVE]: 'success',
  [TenantUserStatus.PENDING_SETUP]: 'warning',
  [TenantUserStatus.PENDING_INVITE]: 'warning',
  [TenantUserStatus.PENDING_APPROVAL]: 'warning',
  [TenantUserStatus.LOCKED]: 'danger',
  [TenantUserStatus.DELETED]: 'neutral',
};

const USER_STATUS_ICONS: Record<TenantUserStatus, string> = {
  [TenantUserStatus.ACTIVE]: 'check_circle',
  [TenantUserStatus.PENDING_SETUP]: 'hourglass_empty',
  [TenantUserStatus.PENDING_INVITE]: 'mail',
  [TenantUserStatus.PENDING_APPROVAL]: 'how_to_reg',
  [TenantUserStatus.LOCKED]: 'lock',
  [TenantUserStatus.DELETED]: 'delete',
};

const INVITE_STATUS_TONES: Record<UserInviteStatus, BadgeTone> = {
  [UserInviteStatus.PENDING]: 'warning',
  [UserInviteStatus.USED]: 'success',
  [UserInviteStatus.REVOKED]: 'neutral',
  [UserInviteStatus.EXPIRED]: 'danger',
};

export interface UserStatusBadgeProps {
  /** `null` for a SystemUser, which has no lifecycle status. */
  status: TenantUserStatus | null;
}

export function UserStatusBadge({ status }: UserStatusBadgeProps) {
  const { t } = useTranslation();

  if (status === null) {
    return <Badge tone="neutral">{t('users.status.none')}</Badge>;
  }

  return (
    <Badge tone={USER_STATUS_TONES[status]} icon={USER_STATUS_ICONS[status]}>
      {t(`users.status.${status}`)}
    </Badge>
  );
}

export interface InviteStatusBadgeProps {
  status: UserInviteStatus;
}

export function InviteStatusBadge({ status }: InviteStatusBadgeProps) {
  const { t } = useTranslation();

  return (
    <Badge tone={INVITE_STATUS_TONES[status]}>
      {t(`users.inviteStatus.${status}`)}
    </Badge>
  );
}
