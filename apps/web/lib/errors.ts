import { ApiError } from '@montra/api-client';
import { staticT } from './i18n-static';
import { stepUpHref } from './session';

type T = (key: string, values?: Record<string, string | number>) => string;

export interface ErrorAction {
  href: string;
  label: string;
}

export interface FormErrors {
  /** Message for the whole form. */
  form?: string;
  /** Messages keyed by form field name. */
  fields: Record<string, string>;
  /** A next step that fixes the error, e.g. "Verify with your second factor". */
  action?: ErrorAction;
}

/** Problem codes with a plain-language message in the catalog (errors.*). */
const CODE_KEYS: Record<string, string> = {
  'transaction.reconciled': 'errors.transaction_reconciled',
  'period.locked': 'errors.period_locked',
  'version.mismatch': 'errors.version_mismatch',
  'transaction.reversed': 'errors.transaction_reversed',
  'invite.invalid': 'errors.invite_invalid',
  'invite.email_mismatch': 'errors.invite_email_mismatch',
  forbidden: 'errors.forbidden',
  'mfa.required': 'errors.mfa_required',
  'reauth.required': 'errors.reauth_required',
  'email.unverified': 'errors.email_unverified',
  'import.not_ready': 'errors.import_not_ready',
  'import.not_editable': 'errors.import_not_editable',
  'import.not_committed': 'errors.import_not_committed',
  'import.undo_expired': 'errors.import_undo_expired',
  'upload.too_large': 'imports.error.doc_too_large',
  'upload.unsupported_type': 'imports.error.unsupported_type',
  'upload.empty': 'imports.error.empty',
  'reconciliation.in_progress': 'errors.reconciliation_in_progress',
  'reconciliation.completed': 'errors.reconciliation_completed',
  'reconciliation.difference': 'errors.reconciliation_difference',
  'account.not_a_bank_account': 'errors.not_a_bank_account',
};

const ACTION_KEYS: Record<string, string> = {
  'mfa.required': 'errors.action_step_up',
  'reauth.required': 'errors.action_reauth',
  'email.unverified': 'errors.action_verify',
};

export function friendlyMessage(err: unknown, t: T = staticT): string {
  if (err instanceof ApiError) {
    if (err.status === 0) return t('errors.network');
    const key = CODE_KEYS[err.code];
    return key ? t(key) : err.message;
  }
  return t('errors.generic');
}

const currentLocation = () =>
  typeof window === 'undefined' ? '/' : window.location.pathname + window.location.search;

/** For 403 mfa.required / reauth.required / email.unverified: where to go to fix it (AUTH-03/04/09). */
export function errorAction(
  err: unknown,
  t: T = staticT,
  returnTo: string = currentLocation(),
): ErrorAction | undefined {
  if (!(err instanceof ApiError) || err.status !== 403) return undefined;
  const href = stepUpHref(err.code, returnTo);
  const key = ACTION_KEYS[err.code];
  return href && key ? { href, label: t(key) } : undefined;
}

/**
 * Maps an API problem to form errors (docs/design/05 §1). `fieldMap` translates contract paths
 * (e.g. "amount.amount") to the form's field names (e.g. "amount").
 */
export function toFormErrors(
  err: unknown,
  fieldMap: Record<string, string> = {},
  t: T = staticT,
): FormErrors {
  if (!(err instanceof ApiError)) return { form: t('errors.generic'), fields: {} };
  const action = errorAction(err, t);
  if (CODE_KEYS[err.code]) return { form: friendlyMessage(err, t), fields: {}, action };
  const fields: Record<string, string> = {};
  const unmatched: string[] = [];
  for (const e of err.errors) {
    const name = fieldMap[e.path] ?? fieldMap[e.path.split('.')[0] ?? ''] ?? (e.path.split('.')[0] || '');
    if (name) fields[name] ??= e.message;
    else unmatched.push(e.message);
  }
  const form =
    err.errors.length === 0 ? friendlyMessage(err, t) : unmatched.length ? unmatched.join(' ') : undefined;
  return { form, fields, action };
}
