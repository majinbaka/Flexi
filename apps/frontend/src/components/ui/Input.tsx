import { useId, type InputHTMLAttributes } from 'react';
import { Icon } from './Icon';

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  /** Material Symbols name shown inside the field's leading edge. */
  icon?: string;
  /** Validation message; also flips the field to its error styling. */
  error?: string;
}

/**
 * Text field at the 40px height the Stitch design system specifies, with
 * the optional leading search icon used by the toolbar rows.
 *
 * The generated id is wired to both the label and `aria-describedby` so
 * the error text is announced with the field rather than read adrift.
 */
export function Input({
  label,
  icon,
  error,
  className = '',
  id,
  ...rest
}: InputProps) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const errorId = `${inputId}-error`;

  return (
    <div className="flex flex-col gap-xs w-full">
      {label && (
        <label
          className="text-label-caps font-label-caps uppercase tracking-wider text-on-surface-variant"
          htmlFor={inputId}
        >
          {label}
        </label>
      )}

      <div className="relative w-full">
        {icon && (
          <Icon
            name={icon}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-outline pointer-events-none"
          />
        )}
        <input
          id={inputId}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          className={[
            'w-full py-2 pr-4 rounded border bg-surface-container-lowest',
            'text-body-sm font-body-sm text-on-surface placeholder:text-outline',
            'transition-all focus:outline-none focus:ring-2',
            icon ? 'pl-10' : 'pl-3',
            error
              ? 'border-error focus:ring-error focus:border-error'
              : 'border-outline-variant focus:ring-primary focus:border-primary',
            'disabled:opacity-50 disabled:cursor-not-allowed',
            className,
          ]
            .filter(Boolean)
            .join(' ')}
          {...rest}
        />
      </div>

      {error && (
        <p className="text-body-sm font-body-sm text-error" id={errorId}>
          {error}
        </p>
      )}
    </div>
  );
}
