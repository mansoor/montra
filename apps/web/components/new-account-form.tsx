'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { ACCOUNT_PROFILES, kindsWhere, percentToBps, type AccountKind } from '@montra/domain';
import type { WorkspaceDto } from '@montra/api-client';
import { browserApi } from '@/lib/browser-api';
import { toFormErrors, type FormErrors } from '@/lib/errors';
import { parseAmountInput } from '@/lib/money';
import { Field, FormError } from './field';
import { useI18n } from './i18n';

const HAVE = kindsWhere((k) => k.side === 'asset');
const OWE = kindsWhere((k) => k.side === 'liability');

export function NewAccountForm({ workspace, today }: { workspace: WorkspaceDto; today: string }) {
  const router = useRouter();
  const { t, locale } = useI18n();
  const [kind, setKind] = useState<AccountKind>('checking');
  const [errors, setErrors] = useState<FormErrors>({ fields: {} });
  const [busy, setBusy] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const type = ACCOUNT_PROFILES[kind];

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
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
              onChange={(e) => setKind(e.target.value as AccountKind)}
            >
              <optgroup label={t('accounts.total_assets')}>{HAVE.map(option)}</optgroup>
              <optgroup label={t('accounts.total_liabilities')}>{OWE.map(option)}</optgroup>
            </select>
          )}
        </Field>
        <Field id="entityId" label={t('account.field.belongs_to')} error={errors.fields.entityId}>
          {(p) => (
            <select {...p} name="entityId" className="input" defaultValue={workspace.entities[0]?.id}>
              {workspace.entities.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name}
                </option>
              ))}
            </select>
          )}
        </Field>
      </div>
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
          hint={t(type.balanceWord === 'owed' ? 'account.balance_hint_owed' : 'account.balance_hint')}
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
        <Field id="openingDate" label={t('account.field.as_of')} error={errors.fields.openingDate}>
          {(p) => <input {...p} name="openingDate" type="date" className="input" defaultValue={today} />}
        </Field>
      </div>
      {type.details.length > 0 && (
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
