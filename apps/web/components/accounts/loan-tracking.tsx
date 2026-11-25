'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import {
  accountProfile,
  addMonths,
  calendarDate,
  monthlyPayment,
  percentToBps,
  type AccountKind,
} from '@montra/domain';
import type { AccountDto } from '@montra/api-client';
import { browserApi } from '@/lib/browser-api';
import { toFormErrors, type FormErrors } from '@/lib/errors';
import { defaultInterestMethod, type InterestMethod } from '@/lib/loans';
import { parseAmountInput } from '@/lib/money';
import { Field, FormError } from '../field';
import { useI18n } from '../i18n';

export interface LoanTermsState {
  start: string;
  first: string;
  firstEdited: boolean;
  principal: string;
  rate: string;
  termValue: string;
  termUnit: 'years' | 'months';
  paying: string;
  payment: string;
  taxes: string;
  insurance: string;
  autoRecord: boolean;
  /** How interest is charged (ADR-0024 §13). */
  method: InterestMethod;
  /** The grace period and late fee (ADR-0024 §14). */
  graceDays: string;
  lateFee: string;
  lateFeePercent: string;
}

const dayAfterMonth = (date: string): string => addMonths(calendarDate(date), 1);

export const initialLoanTerms = (kind: AccountKind, today: string): LoanTermsState => ({
  method: defaultInterestMethod(kind),
  graceDays: '',
  lateFee: '',
  lateFeePercent: '',
  start: today,
  first: dayAfterMonth(today),
  firstEdited: false,
  principal: '',
  rate: '',
  termValue: kind === 'mortgage' ? '30' : '5',
  termUnit: 'years',
  paying: '',
  payment: '',
  taxes: '',
  insurance: '',
  autoRecord: false,
});

export interface LoanTermsInput {
  startDate: string;
  firstPaymentDate: string;
  principal: string;
  rateBps: number;
  termMonths: number;
  payingAccountId?: string;
  paymentAmount?: string;
  escrowTaxes: string;
  escrowInsurance: string;
  autoRecord: boolean;
  interestMethod: InterestMethod;
  graceDays: number;
  lateFee?: string;
  lateFeeBps?: number;
}

/** A grace period from 0 to 60 days; blank is none. */
export function readGraceDays(raw: string): number | null {
  if (!raw.trim()) return 0;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 && n <= 60 ? n : null;
}

/** A late fee as a percent of the payment, 0 to 100 with up to two decimals; blank is none. */
export function readLateFeeBps(raw: string): number | undefined | null {
  if (!raw.trim()) return undefined;
  const bps = percentToBps(raw);
  return bps === null || bps > 10000 ? null : bps;
}

/** The form's terms as an API request, or what's wrong with them, by field. */
export function readLoanTerms(
  s: LoanTermsState,
  currency: string,
  locale: string,
  t: (key: string) => string,
): { ok: true; value: LoanTermsInput } | { ok: false; fields: Record<string, string> } {
  const fields: Record<string, string> = {};
  const minor = (name: string, raw: string, required = false): string | undefined => {
    if (!raw.trim()) {
      if (required) fields[name] = t('account.loan.required');
      return undefined;
    }
    const parsed = parseAmountInput(raw, currency, locale);
    if (!parsed.ok) fields[name] = parsed.error;
    else if (parsed.minor < 0n || (required && parsed.minor === 0n))
      fields[name] = t('budget.amount_invalid');
    else return parsed.minor.toString();
    return undefined;
  };
  const principal = minor('principal', s.principal, true);
  const paymentAmount = minor('paymentAmount', s.payment);
  const escrowTaxes = minor('escrowTaxes', s.taxes);
  const escrowInsurance = minor('escrowInsurance', s.insurance);
  const rateBps = percentToBps(s.rate);
  if (rateBps === null || rateBps > 5000) fields.rate = t('account.loan.rate_invalid');
  const term = Number(s.termValue);
  const termMonths = s.termUnit === 'years' ? term * 12 : term;
  if (!Number.isInteger(termMonths) || termMonths < 1 || termMonths > 600)
    fields.term = t('account.loan.term_invalid');
  if (!s.first) fields.firstPaymentDate = t('account.loan.required');
  // Daily interest runs from the start date, so it's needed, and can't be after the first payment.
  if (s.method === 'daily') {
    if (!s.start) fields.startDate = t('account.loan.start_required');
    else if (s.first && s.start > s.first) fields.startDate = t('account.loan.start_after_first');
  }
  const graceDays = readGraceDays(s.graceDays);
  if (graceDays === null) fields.graceDays = t('account.loan.grace_invalid');
  const lateFee = minor('lateFee', s.lateFee);
  const lateFeeBps = readLateFeeBps(s.lateFeePercent);
  if (lateFeeBps === null) fields.lateFeePercent = t('account.loan.late_fee_percent_invalid');
  if (s.autoRecord && !s.paying) fields.payingAccountId = t('account.loan.auto_needs_account');
  if (Object.keys(fields).length) return { ok: false, fields };
  return {
    ok: true,
    value: {
      startDate: s.start,
      firstPaymentDate: s.first,
      principal: principal!,
      rateBps: rateBps!,
      termMonths,
      payingAccountId: s.paying || undefined,
      paymentAmount,
      escrowTaxes: escrowTaxes ?? '0',
      escrowInsurance: escrowInsurance ?? '0',
      autoRecord: s.autoRecord,
      interestMethod: s.method,
      graceDays: graceDays!,
      ...(lateFee !== undefined ? { lateFee } : {}),
      ...(lateFeeBps !== undefined && lateFeeBps !== null ? { lateFeeBps } : {}),
    },
  };
}

/** The terms of a loan, shared by adding one and by starting to track an existing one. */
export function LoanTermsFields({
  kind,
  value,
  onChange,
  currency,
  payingAccounts,
  errors,
}: {
  kind: AccountKind;
  value: LoanTermsState;
  onChange: (next: LoanTermsState) => void;
  currency: string;
  payingAccounts: readonly AccountDto[];
  errors: Record<string, string | undefined>;
}) {
  const { t, money, locale } = useI18n();
  const set = (patch: Partial<LoanTermsState>) => onChange({ ...value, ...patch });
  const preview = (() => {
    const principal = parseAmountInput(value.principal, currency, locale);
    const bps = percentToBps(value.rate);
    const term = Number(value.termValue) * (value.termUnit === 'years' ? 12 : 1);
    if (!principal.ok || principal.minor <= 0n || bps === null || bps > 5000) return null;
    if (!Number.isInteger(term) || term < 1 || term > 600) return null;
    return monthlyPayment({ principal: principal.minor, rateBps: bps, termMonths: term });
  })();
  return (
    <div className="space-y-4" data-testid="loan-terms">
      <div className="grid gap-4 sm:grid-cols-3">
        <Field id="principal" label={t('account.loan.original_amount')} error={errors.principal}>
          {(p) => (
            <input
              {...p}
              className="input num"
              inputMode="decimal"
              value={value.principal}
              onChange={(e) => set({ principal: e.target.value })}
            />
          )}
        </Field>
        <Field id="rate" label={t('accounts.interest_rate')} error={errors.rate}>
          {(p) => (
            <input
              {...p}
              className="input num"
              inputMode="decimal"
              value={value.rate}
              onChange={(e) => set({ rate: e.target.value })}
            />
          )}
        </Field>
        <Field id="term" label={t('account.loan.term')} error={errors.term}>
          {(p) => (
            <div className="flex gap-2">
              <input
                {...p}
                className="input num w-20"
                inputMode="numeric"
                value={value.termValue}
                onChange={(e) => set({ termValue: e.target.value })}
              />
              <select
                className="input"
                aria-label={t('account.loan.term_unit')}
                value={value.termUnit}
                onChange={(e) => set({ termUnit: e.target.value as 'years' | 'months' })}
              >
                <option value="years">{t('account.loan.years')}</option>
                <option value="months">{t('account.loan.months')}</option>
              </select>
            </div>
          )}
        </Field>
      </div>
      <Field
        id="interestMethod"
        label={t('account.loan.interest_method')}
        error={errors.interestMethod}
        hint={
          value.method === 'daily'
            ? t('account.loan.method_daily_hint')
            : t('account.loan.method_monthly_hint')
        }
      >
        {(p) => (
          <select
            {...p}
            className="input"
            value={value.method}
            onChange={(e) => set({ method: e.target.value as InterestMethod })}
          >
            <option value="monthly">{t('account.loan.method_monthly')}</option>
            <option value="daily">{t('account.loan.method_daily')}</option>
          </select>
        )}
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          id="loanStart"
          label={t('account.loan.start')}
          error={errors.startDate}
          hint={value.method === 'daily' ? t('account.loan.start_daily_hint') : undefined}
        >
          {(p) => (
            <input
              {...p}
              type="date"
              className="input"
              value={value.start}
              onChange={(e) =>
                set({
                  start: e.target.value,
                  ...(!value.firstEdited && e.target.value ? { first: dayAfterMonth(e.target.value) } : {}),
                })
              }
            />
          )}
        </Field>
        <Field
          id="firstPaymentDate"
          label={t('account.loan.first_payment')}
          error={errors.firstPaymentDate}
          hint={t('account.loan.first_payment_hint')}
        >
          {(p) => (
            <input
              {...p}
              type="date"
              className="input"
              value={value.first}
              onChange={(e) => set({ first: e.target.value, firstEdited: true })}
            />
          )}
        </Field>
      </div>
      <LateFeeFields value={value} onChange={(patch) => set(patch)} errors={errors} currency={currency} />
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          id="payingAccountId"
          label={t('account.loan.paid_from')}
          error={errors.payingAccountId}
          hint={t('account.loan.paid_from_hint')}
        >
          {(p) => (
            <select
              {...p}
              className="input"
              value={value.paying}
              onChange={(e) => set({ paying: e.target.value })}
            >
              <option value="">{t('account.loan.paid_from_none')}</option>
              {payingAccounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field
          id="paymentAmount"
          label={t('account.loan.lender_payment')}
          error={errors.paymentAmount}
          hint={
            preview !== null
              ? t('account.loan.calculated', { amount: money(preview, currency) })
              : t('account.loan.lender_payment_hint')
          }
        >
          {(p) => (
            <input
              {...p}
              className="input num"
              inputMode="decimal"
              value={value.payment}
              onChange={(e) => set({ payment: e.target.value })}
            />
          )}
        </Field>
      </div>
      {kind === 'mortgage' && (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            id="escrowTaxes"
            label={t('account.loan.escrow_taxes')}
            error={errors.escrowTaxes}
            hint={t('account.loan.escrow_hint')}
          >
            {(p) => (
              <input
                {...p}
                className="input num"
                inputMode="decimal"
                value={value.taxes}
                onChange={(e) => set({ taxes: e.target.value })}
              />
            )}
          </Field>
          <Field
            id="escrowInsurance"
            label={t('account.loan.escrow_insurance')}
            error={errors.escrowInsurance}
          >
            {(p) => (
              <input
                {...p}
                className="input num"
                inputMode="decimal"
                value={value.insurance}
                onChange={(e) => set({ insurance: e.target.value })}
              />
            )}
          </Field>
        </div>
      )}
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          className="mt-1"
          checked={value.autoRecord}
          onChange={(e) => set({ autoRecord: e.target.checked })}
        />
        <span>
          {t('account.loan.auto_record')}
          <span className="block text-muted">{t('account.loan.auto_record_hint')}</span>
        </span>
      </label>
    </div>
  );
}

/** The grace period and late fee: a fixed amount, a percent of the payment, or the greater of the two (ADR-0024 §14). */
export function LateFeeFields({
  value,
  onChange,
  errors,
  currency,
}: {
  value: Pick<LoanTermsState, 'graceDays' | 'lateFee' | 'lateFeePercent'>;
  onChange: (patch: Partial<Pick<LoanTermsState, 'graceDays' | 'lateFee' | 'lateFeePercent'>>) => void;
  errors: Record<string, string | undefined>;
  currency: string;
}) {
  const { t } = useI18n();
  return (
    <div className="grid gap-4 sm:grid-cols-3" data-testid="loan-late-fee">
      <Field
        id="graceDays"
        label={t('account.loan.grace_days')}
        error={errors.graceDays}
        hint={t('account.loan.grace_hint')}
      >
        {(p) => (
          <input
            {...p}
            className="input num"
            inputMode="numeric"
            value={value.graceDays}
            onChange={(e) => onChange({ graceDays: e.target.value })}
          />
        )}
      </Field>
      <Field id="lateFee" label={t('account.loan.late_fee_amount', { currency })} error={errors.lateFee}>
        {(p) => (
          <input
            {...p}
            className="input num"
            inputMode="decimal"
            value={value.lateFee}
            onChange={(e) => onChange({ lateFee: e.target.value })}
          />
        )}
      </Field>
      <Field
        id="lateFeePercent"
        label={t('account.loan.late_fee_percent')}
        error={errors.lateFeePercent}
        hint={t('account.loan.late_fee_hint')}
      >
        {(p) => (
          <input
            {...p}
            className="input num"
            inputMode="decimal"
            value={value.lateFeePercent}
            onChange={(e) => onChange({ lateFeePercent: e.target.value })}
          />
        )}
      </Field>
    </div>
  );
}

const LOAN_FIELDS: Record<string, string> = {
  rateBps: 'rate',
  termMonths: 'term',
  lateFeeBps: 'lateFeePercent',
};

/** Starts tracking an account that so far only had a balance. */
export function TrackLoanForm({
  workspaceId,
  account,
  accounts,
  today,
}: {
  workspaceId: string;
  account: AccountDto;
  accounts: readonly AccountDto[];
  today: string;
}) {
  const router = useRouter();
  const { t, locale } = useI18n();
  const [terms, setTerms] = useState(() => initialLoanTerms(account.kind, today));
  const [errors, setErrors] = useState<FormErrors>({ fields: {} });
  const [busy, setBusy] = useState(false);
  const paying = accounts.filter(
    (a) =>
      !a.archived &&
      a.entityId === account.entityId &&
      a.currency === account.currency &&
      accountProfile(a.kind).forecast === 'cash',
  );

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const read = readLoanTerms(terms, account.currency, locale, t);
    if (!read.ok) return setErrors({ fields: read.fields });
    setBusy(true);
    setErrors({ fields: {} });
    try {
      await browserApi.createLoan(workspaceId, {
        name: account.name,
        loanAccountId: account.id,
        balanceAsOf: today as never,
        ...read.value,
        startDate: read.value.startDate as never,
        firstPaymentDate: read.value.firstPaymentDate as never,
      });
      router.refresh();
    } catch (err) {
      setErrors(toFormErrors(err, LOAN_FIELDS));
    }
    setBusy(false);
  }

  return (
    <details className="card" data-testid="track-loan">
      <summary className="cursor-pointer text-sm font-semibold">{t('account.loan.track_title')}</summary>
      <p className="mt-2 text-sm text-muted">{t('account.loan.track_help')}</p>
      <form onSubmit={onSubmit} className="mt-3 space-y-4" noValidate>
        <FormError message={errors.form} />
        <LoanTermsFields
          kind={account.kind}
          value={terms}
          onChange={setTerms}
          currency={account.currency}
          payingAccounts={paying}
          errors={errors.fields}
        />
        <button type="submit" className="btn-primary" disabled={busy}>
          {t('account.loan.track_button')}
        </button>
      </form>
    </details>
  );
}
