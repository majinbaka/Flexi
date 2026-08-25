import type { ReactNode } from 'react';
import { Icon } from './Icon';

export type BadgeTone =
  'neutral' | 'primary' | 'success' | 'warning' | 'danger';

export interface BadgeProps {
  tone?: BadgeTone;
  /** Material Symbols name rendered before the label. */
  icon?: string;
  children: ReactNode;
  className?: string;
}

/**
 * Pill-shaped status/label chip -- the one place the design system uses a
 * fully rounded shape besides navigation-level actions.
 *
 * `success` and `warning` are mapped onto the palette's secondary and
 * tertiary ramps, which is what the Stitch screens use for those states
 * (the theme defines no dedicated success/warning colors).
 */
const TONE_CLASSES: Record<BadgeTone, string> = {
  neutral:
    'bg-surface-container-high text-on-surface-variant border border-outline-variant',
  primary:
    'bg-primary-fixed text-on-primary-fixed border border-primary-fixed-dim',
  success:
    'bg-secondary-fixed-dim text-on-secondary-fixed border border-transparent',
  warning:
    'bg-tertiary-fixed text-on-tertiary-fixed border border-tertiary-fixed-dim',
  danger:
    'bg-error-container text-on-error-container border border-transparent',
};

export function Badge({
  tone = 'neutral',
  icon,
  children,
  className = '',
}: BadgeProps) {
  return (
    <span
      className={[
        'inline-flex items-center gap-xs px-2 py-1 rounded-full',
        'text-[12px] font-medium whitespace-nowrap',
        TONE_CLASSES[tone],
        className,
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {icon && <Icon name={icon} size={14} />}
      {children}
    </span>
  );
}
