import type { ReactNode } from 'react';
import { errorAction, type ErrorAction } from '@/lib/errors';

/** Label + control + inline error with the ARIA wiring (accessible labels, NFR-10). */
export function Field({
  id,
  label,
  error,
  hint,
  children,
  className,
}: {
  id: string;
  label: string;
  error?: string;
  hint?: string;
  children: (props: { id: string; 'aria-invalid'?: 'true'; 'aria-describedby'?: string }) => ReactNode;
  className?: string;
}) {
  const describedBy =
    [error ? `${id}-error` : null, hint ? `${id}-hint` : null].filter(Boolean).join(' ') || undefined;
  return (
    <div className={className}>
      <label htmlFor={id} className="field-label">
        {label}
      </label>
      {children({ id, 'aria-invalid': error ? 'true' : undefined, 'aria-describedby': describedBy })}
      {hint && !error && (
        <p id={`${id}-hint`} className="mt-1 text-xs text-muted">
          {hint}
        </p>
      )}
      {error && (
        <p id={`${id}-error`} className="field-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/** Form-level error, with an optional next step (e.g. "Verify with your second factor"). */
export function FormError({ message, action }: { message?: string; action?: ErrorAction }) {
  if (!message) return null;
  return (
    <p role="alert" className="rounded-md border border-bad/40 bg-bad/10 px-3 py-2 text-sm text-bad">
      {message}
      {action && (
        <>
          {' '}
          <a href={action.href} className="font-medium underline">
            {action.label}
          </a>
        </>
      )}
    </p>
  );
}

/** FormError for an arbitrary caught error, deriving the step-up link from the problem code. */
export function ErrorWithAction({ message, error }: { message: string; error: unknown }) {
  return <FormError message={message} action={errorAction(error)} />;
}
