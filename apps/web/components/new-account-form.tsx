'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { ACCOUNT_PROFILES, accountProfile, kindsWhere, percentToBps, type AccountKind } from '@montra/domain';
import type { AccountDto, EmployerDto, WorkspaceDto } from '@montra/api-client';
import { WORKPLACE_PLANS, type PlanType } from '@montra/domain';
import { browserApi } from '@/lib/browser-api';
import { toFormErrors, type FormErrors } from '@/lib/errors';
import { parseAmountInput } from '@/lib/money';
import { PlanFields } from './accounts/investment-panel';
import { initialLoanTerms, LoanTermsFields, readLoanTerms } from './accounts/loan-tracking';
import { Field, FormError } from './field';
import { useI18n } from './i18n';

const HAVE = kindsWhere((k) => k.side === 'asset');
const OWE = kindsWhere((k) => k.side === 'liability');

export function NewAccountForm({
  workspace,
  accounts,
  employers,
  today,
}: {
  workspace: WorkspaceDto;
  accounts: readonly AccountDto[];
  employers: readonly EmployerDto[];
  today: string;
}) {
  const router = useRouter();
  const { t, locale } = useI18n();
  const [kind, setKind] = useState<AccountKind>('checking');
  const [errors, setErrors] = useState<FormErrors>({ fields: {} });
  const [busy, setBusy] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const type = ACCOUNT_PROFILES[kind];
  const [entityId, setEntityId] = useState(workspace.entities[0]?.id ?? '');
  const [track, setTrack] = useState(false);
  const [terms, setTerms] = useState(() => initialLoanTerms('mortgage', today));
  const tracking = type.installment && track;
  const [plan, setPlan] = useState<PlanType | ''>('');
  const [employerId, setEmployerId] = useState('');
  const [contributions, setContributions] = useState(false);
  const workplace = kind === 'investment' && plan !== '' && WORKPLACE_PLANS.has(plan);
  const entity = workspace.entities.find((e) => e.id === entityId);
  const loanCurrency = entity?.functionalCurrency ?? workspace.baseCurrency;
  const payingAccounts = accounts.filter(
    (a) =>
      !a.archived &&
      a.entityId === entityId &&
      a.currency === loanCurrency &&
      accountProfile(a.kind).forecast === 'cash',
  );

  function changeKind(next: AccountKind) {
    setKind(next);
    if (ACCOUNT_PROFILES[next].installment) setTerms(initialLoanTerms(next, today));
  }

  async function submitTracked(f: FormData) {
    const get = (k: string) => String(f.get(k) ?? '').trim();
    const read = readLoanTerms(terms, loanCurrency, locale, t);
    const fields: Record<string, string> = read.ok ? {} : { ...read.fields };
    let owed: string | undefined;
    const owedInput = get('openingBalance');
    if (owedInput) {
      const parsed = parseAmountInput(owedInput, loanCurrency, locale);
      if (!parsed.ok) fields.openingBalance = parsed.error;
      else if (parsed.minor <= 0n) fields.openingBalance = t('budget.amount_invalid');
      else owed = parsed.minor.toString();
    }
    if (!read.ok || Object.keys(fields).length) {
      setErrors({ fields });
      return;
    }
    setBusy(true);
    setErrors({ fields: {} });
    try {
      const loan = await browserApi.createLoan(workspace.id, {
        name: get('name'),
        newAccount: {
          kind: kind as 'loan' | 'mortgage',
          entityId,
          institution: get('institution') || undefined,
          last4: get('last4') || undefined,
          owed,
        },
        balanceAsOf: (get('openingDate') || today) as never,
        ...read.value,
        startDate: read.value.startDate as never,
        firstPaymentDate: read.value.firstPaymentDate as never,
      });
      router.push(`/w/${workspace.id}/accounts/${loan.loanAccountId}`);
      router.refresh();
    } catch (err) {
      setErrors(
        toFormErrors(err, {
          'newAccount.owed': 'openingBalance',
          'newAccount.last4': 'last4',
          rateBps: 'rate',
          termMonths: 'term',
        }),
      );
      setBusy(false);
    }
  }

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    if (tracking) return submitTracked(f);
    const get = (k: string) => String(f.get(k) ?? '').trim();
    const currency = get('currency').toUpperCase() || workspace.baseCurrency;
    const fields: Record<string, string> = {};
    const minor = (name: string, allowNegative = false): string | undefined => {
      const raw = get(name);
      if (!raw) return undefined;
      const parsed = parseAmountInput(raw, currency, locale);
      if (!parsed.ok) {
        fields[name] = parsed.error;
        return undefined;
      }
      if (parsed.minor < 0n && !allowNegative) {
        fields[name] = t('budget.amount_invalid');
        return undefined;
      }
      return parsed.minor.toString();
    };
    const balance = minor('openingBalance', true);
    const creditLimit = minor('creditLimit');
    const minPayment = minor('minPayment');
    const lowBalance = minor('lowBalance', true);
    const rate = get('interestRate');
    const interestRateBps = rate ? percentToBps(rate) : undefined;
    if (interestRateBps === null) fields.interestRate = t('account.rate_invalid');
    if (Object.keys(fields).length) {
      setErrors({ fields });
      if (Object.keys(fields).some((name) => name !== 'openingBalance')) setDetailsOpen(true);
      return;
    }
    setBusy(true);
    setErrors({ fields: {} });
    try {
      const account = await browserApi.createAccount(workspace.id, {
        name: get('name'),
        kind,
        entityId: get('entityId') || undefined,
        currency,
        institution: get('institution') || undefined,
        last4: get('last4') || undefined,
        openingBalance: balance === undefined ? undefined : { amount: balance, currency },
        openingDate: get('openingDate') || undefined,
        creditLimit,
        interestRateBps: interestRateBps ?? undefined,
        minPayment,
        lowBalance,
        ...(kind === 'investment' && plan ? { planType: plan } : {}),
        ...(workplace && employerId ? { employerId, employerContributions: contributions } : {}),
      });
      router.push(`/w/${workspace.id}/accounts/${account.id}`);
      router.refresh();
    } catch (err) {
      setErrors(
        toFormErrors(err, {
          'openingBalance.amount': 'openingBalance',
          'openingBalance.currency': 'currency',
          interestRateBps: 'interestRate',
        }),
      );
      setBusy(false);
    }
  }

  const option = (k: AccountKind) => (
    <option key={k} value={k}>
      {t(`account.add_kind.${k}`)}
    </option>
  );

  return (
    <form onSubmit={onSubmit} className="card max-w-xl space-y-4" noValidate>
      <FormError message={errors.form} />
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          id="kind"
          label={t('account.field.type')}
          error={errors.fields.kind}
          hint={t(`account.kind_help.${kind}`)}
        >
          {(p) => (
            <select
              {...p}
              name="kind"
              className="input"
              value={kind}
              onChange={(e) => changeKind(e.target.value as AccountKind)}
            >
              <optgroup label={t('accounts.total_assets')}>{HAVE.map(option)}</optgroup>
              <optgroup label={t('accounts.total_liabilities')}>{OWE.map(option)}</optgroup>
            </select>
          )}
        </Field>
        <Field id="entityId" label={t('account.field.belongs_to')} error={errors.fields.entityId}>
          {(p) => (
            <select
              {...p}
              name="entityId"
              className="input"
              value={entityId}
              onChange={(e) => setEntityId(e.target.value)}
            >
              {workspace.entities.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name}
                </option>
              ))}
            </select>
          )}
        </Field>
      </div>
      {type.installment && (
        <fieldset data-testid="loan-track-choice">
          <legend className="field-label">{t('account.loan.how')}</legend>
          <div className="mt-1 grid gap-2 sm:grid-cols-2">
            <label className="flex items-start gap-2 rounded-lg border border-line p-3 text-sm">
              <input
                type="radio"
                name="track"
                className="mt-1"
                checked={!track}
                onChange={() => setTrack(false)}
              />
              <span>
                <span className="font-medium">{t('account.loan.how_balance')}</span>
                <span className="block text-muted">{t('account.loan.how_balance_help')}</span>
              </span>
            </label>
            <label className="flex items-start gap-2 rounded-lg border border-line p-3 text-sm">
              <input
                type="radio"
                name="track"
                className="mt-1"
                checked={track}
                onChange={() => setTrack(true)}
              />
              <span>
                <span className="font-medium">{t('account.loan.how_payments')}</span>
                <span className="block text-muted">{t('account.loan.how_payments_help')}</span>
              </span>
            </label>
          </div>
        </fieldset>
      )}
      <Field id="name" label={t('account.field.name')} error={errors.fields.name}>
        {(p) => (
          <input
            {...p}
            name="name"
            className="input"
            required
            maxLength={200}
            placeholder={t(`account.kind_example.${kind}`)}
          />
        )}
      </Field>
      {(type.holder || type.hasNumber) && (
        <div className="grid gap-4 sm:grid-cols-3">
          {type.holder && (
            <Field
              id="institution"
              label={t(`account.holder.${type.holder}`)}
              error={errors.fields.institution}
              className="sm:col-span-2"
            >
              {(p) => <input {...p} name="institution" className="input" maxLength={200} />}
            </Field>
          )}
          {type.hasNumber && (
            <Field id="last4" label={t('account.field.last4')} error={errors.fields.last4}>
              {(p) => (
                <input
                  {...p}
                  name="last4"
                  className="input"
                  inputMode="numeric"
                  pattern="\d{4}"
                  maxLength={4}
                />
              )}
            </Field>
          )}
        </div>
      )}
      <div className="grid gap-4 sm:grid-cols-3">
        <Field
          id="openingBalance"
          label={t(`account.balance_word.${type.balanceWord}`)}
          error={errors.fields.openingBalance}
          hint={
            tracking
              ? t('account.loan.owed_hint')
              : t(type.balanceWord === 'owed' ? 'account.balance_hint_owed' : 'account.balance_hint')
          }
        >
          {(p) => (
            <input
              {...p}
              name="openingBalance"
              className="input num"
              inputMode="decimal"
              placeholder="0.00"
            />
          )}
        </Field>
        {!tracking && (
          <Field id="currency" label={t('account.field.currency')} error={errors.fields.currency}>
            {(p) => (
              <input
                {...p}
                name="currency"
                className="input uppercase"
                defaultValue={workspace.baseCurrency}
                maxLength={3}
              />
            )}
          </Field>
        )}
        <Field id="openingDate" label={t('account.field.as_of')} error={errors.fields.openingDate}>
          {(p) => <input {...p} name="openingDate" type="date" className="input" defaultValue={today} />}
        </Field>
      </div>
      {kind === 'investment' && (
        <PlanFields
          plan={plan}
          onPlan={setPlan}
          employerId={employerId}
          onEmployer={setEmployerId}
          contributions={contributions}
          onContributions={setContributions}
          employers={employers.filter((e) => e.entityId === entityId)}
        />
      )}
      {tracking && (
        <LoanTermsFields
          kind={kind}
          value={terms}
          onChange={setTerms}
          currency={loanCurrency}
          payingAccounts={payingAccounts}
          errors={errors.fields}
        />
      )}
      {!tracking && type.details.length > 0 && (
        <details
          open={detailsOpen}
          onToggle={(e) => setDetailsOpen(e.currentTarget.open)}
          data-testid="account-details"
        >
          <summary className="cursor-pointer text-sm font-semibold">{t('account.more_details')}</summary>
          <div className="mt-3 grid gap-4 sm:grid-cols-3">
            {type.details.includes('creditLimit') && (
              <Field id="creditLimit" label={t('accounts.credit_limit')} error={errors.fields.creditLimit}>
                {(p) => <input {...p} name="creditLimit" className="input num" inputMode="decimal" />}
              </Field>
            )}
            {type.details.includes('interestRate') && (
              <Field
                id="interestRate"
                label={t(kind === 'credit_card' ? 'accounts.apr' : 'accounts.interest_rate')}
                error={errors.fields.interestRate}
              >
                {(p) => <input {...p} name="interestRate" className="input num" inputMode="decimal" />}
              </Field>
            )}
            {type.details.includes('minPayment') && (
              <Field id="minPayment" label={t('accounts.min_payment')} error={errors.fields.minPayment}>
                {(p) => <input {...p} name="minPayment" className="input num" inputMode="decimal" />}
              </Field>
            )}
            {type.details.includes('lowBalance') && (
              <Field
                id="lowBalance"
                label={t('accounts.low_balance')}
                error={errors.fields.lowBalance}
                hint={t('account.low_balance_hint')}
              >
                {(p) => <input {...p} name="lowBalance" className="input num" inputMode="decimal" />}
              </Field>
            )}
          </div>
        </details>
      )}
      <button type="submit" className="btn-primary" disabled={busy}>
        {busy ? t('account.saving') : t('account.add')}
      </button>
    </form>
  );
}
