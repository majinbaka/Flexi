import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { Icon } from './Icon';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Material Symbols name rendered before the label. */
  icon?: string;
  /** Stretch to the full width of the parent (used in forms and the sidebar CTA). */
  fullWidth?: boolean;
  children?: ReactNode;
}

const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  primary:
    'bg-primary text-on-primary hover:opacity-90 shadow-sm border border-transparent',
  secondary:
    'bg-surface text-on-surface border border-outline-variant hover:bg-surface-container-low shadow-sm',
  ghost:
    'bg-transparent text-on-surface-variant border border-transparent hover:bg-surface-container-high hover:text-on-surface',
  danger:
    'bg-error text-on-error hover:opacity-90 shadow-sm border border-transparent',
};

const SIZE_CLASSES: Record<ButtonSize, string> = {
  sm: 'px-3 py-1.5 text-body-sm font-body-sm',
  md: 'px-4 py-2 text-body-sm font-body-sm',
};

/**
 * Action button in the four variants the Stitch screens use: filled
 * `primary` for the main action, outlined `secondary` beside it, borderless
 * `ghost` for toolbar/icon actions, and `danger` for destructive ones.
 *
 * An icon-only button (no `children`) collapses to a square so it lines up
 * with the neighbouring inputs in a toolbar row.
 */
export function Button({
  variant = 'primary',
  size = 'md',
  icon,
  fullWidth = false,
  className = '',
  children,
  type = 'button',
  ...rest
}: ButtonProps) {
  const iconOnly = !children;

  return (
    <button
      type={type}
      className={[
        'inline-flex items-center justify-center gap-xs rounded font-medium',
        'transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary',
        'disabled:opacity-50 disabled:cursor-not-allowed disabled:shadow-none',
        VARIANT_CLASSES[variant],
        iconOnly ? 'p-2' : SIZE_CLASSES[size],
        fullWidth ? 'w-full' : '',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
      {...rest}
    >
      {icon && <Icon name={icon} size={18} />}
      {children}
    </button>
  );
}
