import { useTranslation } from 'react-i18next';
import type { TenantSeatUsageDto } from '@flexi/shared-types';
import { Icon } from '../ui';

export interface SeatUsageProps {
  usage: TenantSeatUsageDto;
}

/**
 * How many seats the tenant holds against `max_users`.
 *
 * Deliberately a presentational component taking the DTO as a prop rather
 * than fetching it: `TenantSeatUsageDto` has no endpoint of its own. The
 * backend computes it in `UserQuotaService` and returns it only as part of
 * the *result* of `POST /api/users/invites` and
 * `POST /api/users/direct-create`, so the only honest place to render it
 * today is the outcome of one of those calls. The Users list therefore
 * shows no seat counter -- there is nothing to read on page load.
 */
export function SeatUsage({ usage }: SeatUsageProps) {
  const { t } = useTranslation();

  return (
    <p className="flex items-center gap-xs font-body-sm text-body-sm text-on-surface-variant">
      <Icon name="event_seat" size={16} />
      <span>
        {usage.unlimited
          ? t('users.seats.unlimited', { used: usage.usedSeats })
          : t('users.seats.usedOfMax', {
              used: usage.usedSeats,
              max: usage.maxUsers,
              remaining: usage.remainingSeats ?? 0,
            })}
      </span>
    </p>
  );
}
