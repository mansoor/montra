'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import type { AccountDto, WorkspaceDto } from '@montra/api-client';
import { browserApi } from '@/lib/browser-api';
import { toFormErrors, type FormErrors } from '@/lib/errors';
import { parseAmountInput } from '@/lib/money';
import { Field, FormError } from './field';
import { useI18n } from './i18n';

/** Transfer between accounts, including card payments (TXN-04). Never counts as income or expense. */
export function TransferForm({
  workspace,
  accounts,
  today,
}: {
  workspace: WorkspaceDto;
  accounts: AccountDto[];
  today: string;
}) {
  const router = useRouter();
  const { t, locale } = useI18n();
  const [fromId, setFromId] = useState(accounts[0]?.id ?? '');
  const [errors, setErrors] = useState<FormErrors>({ fields: {} });
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);

  if (accounts.length < 2)
    return <p className="card text-sm text-muted">{t('transfer.need_two_accounts')}</p>;
  const from = accounts.find((a) => a.id === fromId);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    const get = (k: string) => String(f.get(k) ?? '').trim();
    const currency = from?.currency ?? workspace.baseCurrency;
    const parsed = parseAmountInput(get('amount'), currency, locale, t);
    if (!parsed.ok) return setErrors({ fields: { amount: parsed.error } });
    if (parsed.minor <= 0n) return setErrors({ fields: { amount: t('money.positive') } });
    if (get('toAccountId') === fromId)
      return setErrors({ fields: { toAccountId: t('transfer.different_account') } });
    setBusy(true);
    setErrors({ fields: {} });
    try {
      await browserApi.createTransfer(workspace.id, {
        date: get('date') || today,
        fromAccountId: fromId,
        toAccountId: get('toAccountId'),
        amount: { amount: parsed.minor.toString(), currency },
        description: get('description') || undefined,
      });
      setSaved(t('transfer.saved'));
      form.reset();
      setFromId(accounts[0]?.id ?? '');
      router.refresh();
    } catch (err) {
      setErrors(toFormErrors(err, { 'amount.amount': 'amount' }, t));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="card space-y-3" aria-labelledby="transfer-title" noValidate>
      <h2 id="transfer-title" className="text-base font-semibold">
        {t('transfer.title')}
      </h2>
      <FormError message={errors.form} action={errors.action} />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <Field id="tr-from" label={t('transfer.from')} error={errors.fields.fromAccountId}>
          {(p) => (
            <select
              {...p}
              name="fromAccountId"
              className="input"
              value={fromId}
              onChange={(e) => setFromId(e.target.value)}
            >
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field id="tr-to" label={t('transfer.to')} error={errors.fields.toAccountId}>
          {(p) => (
            <select
              {...p}
              name="toAccountId"
              className="input"
              defaultValue={accounts.find((a) => a.id !== fromId)?.id}
            >
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field id="tr-amount" label={t('fields.amount')} error={errors.fields.amount}>
          {(p) => <input {...p} name="amount" className="input num" inputMode="decimal" placeholder="0.00" />}
        </Field>
        <Field id="tr-date" label={t('fields.date')} error={errors.fields.date}>
          {(p) => <input {...p} name="date" type="date" className="input" defaultValue={today} />}
        </Field>
        <Field id="tr-desc" label={t('transfer.note')} error={errors.fields.description}>
          {(p) => (
            <input
              {...p}
              name="description"
              className="input"
              maxLength={500}
              placeholder={t('common.optional')}
            />
          )}
        </Field>
      </div>
      <div className="flex items-center gap-3">
        <button type="submit" className="btn-primary" disabled={busy}>
          {busy ? t('common.saving') : t('transfer.submit')}
        </button>
        <span aria-live="polite" className="text-sm text-good">
          {saved}
        </span>
      </div>
    </form>
  );
}
