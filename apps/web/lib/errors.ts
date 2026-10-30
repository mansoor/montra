import { ApiError } from '@montra/api-client';

export interface FormErrors {
  /** Message for the whole form. */
  form?: string;
  /** Messages keyed by form field name. */
  fields: Record<string, string>;
}

/**
 * Maps an API problem to form errors (docs/design/05 §1). `fieldMap` translates contract paths
 * (e.g. "amount.amount") to the form's field names (e.g. "amount").
 */
export function toFormErrors(err: unknown, fieldMap: Record<string, string> = {}): FormErrors {
  if (!(err instanceof ApiError)) return { form: 'Something went wrong. Please try again.', fields: {} };
  const fields: Record<string, string> = {};
  const unmatched: string[] = [];
  for (const e of err.errors) {
    const name = fieldMap[e.path] ?? fieldMap[e.path.split('.')[0] ?? ''] ?? (e.path.split('.')[0] || '');
    if (name) fields[name] ??= e.message;
    else unmatched.push(e.message);
  }
  const form =
    err.errors.length === 0
      ? err.status === 0
        ? 'Cannot reach the server. Check your connection.'
        : err.message
      : unmatched.length
        ? unmatched.join(' ')
        : undefined;
  return { form, fields };
}
