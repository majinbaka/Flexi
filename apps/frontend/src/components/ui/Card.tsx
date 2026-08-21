import type { HTMLAttributes, ReactNode } from 'react';

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  /**
   * `glass` is the translucent blurred panel the Stitch screens use for
   * toolbars floating over the page background; `solid` is the standard
   * content surface.
   */
  variant?: 'solid' | 'glass';
  padded?: boolean;
  children: ReactNode;
}

/**
 * Content surface: a 1px outlined panel on the app background, per the
 * design system's "Elevation & Depth" rules (borders separate, shadows
 * stay very soft).
 */
export function Card({
  variant = 'solid',
  padded = true,
  className = '',
  children,
  ...rest
}: CardProps) {
  return (
    <div
      className={[
        'rounded-lg shadow-sm',
        variant === 'glass'
          ? 'bg-surface-container-lowest/70 backdrop-blur-md border border-white/30'
          : 'bg-surface border border-outline-variant',
        padded ? 'p-md' : '',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
      {...rest}
    >
      {children}
    </div>
  );
}
