import { ApiError } from '@montra/api-client';

export interface FormErrors {
  /** Message for the whole form. */
  form?: string;
  /** Messages keyed by form field name. */
  fields: Record<string, string>;
}

/** Plain-language explanations for problem codes that need more than the server's detail. */
const FRIENDLY: Record<string, string> = {
  'transaction.reconciled':
    'This transaction is reconciled with a statement, so its account and amount can’t change. You can still recategorize it.',
  'period.locked':
    'The books are closed for this date. Reopen the period in Settings → Entities, or use a date after the close.',
  'version.mismatch':
    'Someone else changed this since you opened it. Reload the page to see the latest version.',
  'transaction.reversed':
    'This transaction was reversed in a closed period. Record it again instead of restoring it.',
  'invite.invalid': 'This invite link is invalid, expired or already used. Ask for a new one.',
  'invite.email_mismatch':
    'This invite was sent to a different email address. Sign in with that address to accept it.',
  forbidden: 'You don’t have permission to do that in this workspace.',
};

export function friendlyMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 0) return 'Cannot reach the server. Check your connection.';
    return FRIENDLY[err.code] ?? err.message;
  }
  return 'Something went wrong. Please try again.';
}

/**
 * Maps an API problem to form errors (docs/design/05 §1). `fieldMap` translates contract paths
 * (e.g. "amount.amount") to the form's field names (e.g. "amount").
 */
export function toFormErrors(err: unknown, fieldMap: Record<string, string> = {}): FormErrors {
  if (!(err instanceof ApiError)) return { form: 'Something went wrong. Please try again.', fields: {} };
  if (FRIENDLY[err.code]) return { form: FRIENDLY[err.code], fields: {} };
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
