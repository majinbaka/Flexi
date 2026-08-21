import type { ReactNode } from 'react';

export interface PageHeaderProps {
  title: string;
  description?: string;
  /** Trailing action buttons, right-aligned on desktop. */
  actions?: ReactNode;
}

/**
 * Title block that opens every content page in the Stitch designs: display
 * heading, supporting line, and an optional right-aligned action cluster
 * that wraps below the text on narrow viewports.
 */
export function PageHeader({ title, description, actions }: PageHeaderProps) {
  return (
    <div className="flex flex-col md:flex-row md:items-center justify-between gap-md">
      <div>
        <h1 className="font-display-lg text-display-lg-mobile md:text-[28px] font-bold text-on-surface tracking-tight mb-xs">
          {title}
        </h1>
        {description && (
          <p className="font-body-base text-body-base text-on-surface-variant">
            {description}
          </p>
        )}
      </div>

      {actions && <div className="flex items-center gap-sm">{actions}</div>}
    </div>
  );
}
