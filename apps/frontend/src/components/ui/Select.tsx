import { useId, type SelectHTMLAttributes, type ReactNode } from 'react';
import { Icon } from './Icon';

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label?: string;
  children: ReactNode;
}

/**
 * Dropdown matching Input's height and border treatment. The native chevron
 * is suppressed (`appearance-none`) and replaced with a Material Symbols
 * one so the control looks identical across browsers, as in the Stitch
 * toolbar rows.
 */
export function Select({
  label,
  className = '',
  id,
  children,
  ...rest
}: SelectProps) {
  const generatedId = useId();
  const selectId = id ?? generatedId;

  return (
    <div className="flex flex-col gap-xs w-full">
      {label && (
        <label
          className="text-label-caps font-label-caps uppercase tracking-wider text-on-surface-variant"
          htmlFor={selectId}
        >
          {label}
        </label>
      )}

      <div className="relative w-full">
        <select
          id={selectId}
          className={[
            'appearance-none w-full py-2 pl-3 pr-8 rounded cursor-pointer',
            'bg-surface-container-lowest border border-outline-variant text-on-surface',
            'text-body-sm font-body-sm transition-all',
            'focus:outline-none focus:ring-2 focus:ring-primary focus:border-primary',
            'disabled:opacity-50 disabled:cursor-not-allowed',
            className,
          ]
            .filter(Boolean)
            .join(' ')}
          {...rest}
        >
          {children}
        </select>
        <Icon
          name="expand_more"
          className="absolute right-2 top-1/2 -translate-y-1/2 pointer-events-none text-outline"
        />
      </div>
    </div>
  );
}
