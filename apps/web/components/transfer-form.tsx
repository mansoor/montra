'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import type { AccountDto, TransferFxDto, WorkspaceDto } from '@montra/api-client';
import { browserApi } from '@/lib/browser-api';
import { toFormErrors, type FormErrors } from '@/lib/errors';
import { parseAmountInput } from '@/lib/money';
import { Field, FormError } from './field';
import { TransferFxSummary } from './transfer-fx-summary';
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
  const [toId, setToId] = useState(accounts.find((a) => a.id !== accounts[0]?.id)?.id ?? '');
  const [errors, setErrors] = useState<FormErrors>({ fields: {} });
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  // CUR-08: what is typed, for the FX cost preview between currencies.
  const [typed, setTyped] = useState({ amount: '', amountIn: '', date: today });
  const [preview, setPreview] = useState<TransferFxDto | null>(null);
  const from = accounts.find((a) => a.id === fromId);
  const to = accounts.find((a) => a.id === toId);
  // CUR-08: between currencies, both amounts are kept; the API books the gap as FX cost or gain.
  const crossCurrency = Boolean(from && to && from.currency !== to.currency);

  useEffect(() => {
    setPreview(null);
    if (!crossCurrency || !from || !to) return;
    const sent = parseAmountInput(typed.amount, from.currency, locale, t);
    const received = parseAmountInput(typed.amountIn, to.currency, locale, t);
    if (!sent.ok || !received.ok || sent.minor <= 0n || received.minor <= 0n) return;
    let live = true;
    const timer = setTimeout(() => {
      browserApi
        .transferFx(workspace.id, {
          date: typed.date || today,
          fromAccountId: from.id,
          toAccountId: to.id,
          amount: { amount: sent.minor.toString(), currency: from.currency },
          amountIn: { amount: received.minor.toString(), currency: to.currency },
        })
        .then(
          (fx) => {
            if (live) setPreview(fx);
          },
          () => undefined, // A preview only: saving reports any real problem.
        );
    }, 400);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [crossCurrency, from, to, typed, today, locale, t, workspace.id]);

  if (accounts.length < 2)
    return <p className="card text-sm text-muted">{t('transfer.need_two_accounts')}</p>;

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
    let amountIn: { amount: string; currency: string } | undefined;
    if (crossCurrency && to) {
      const received = parseAmountInput(get('amountIn'), to.currency, locale, t);
      if (!received.ok) return setErrors({ fields: { amountIn: received.error } });
      if (received.minor <= 0n) return setErrors({ fields: { amountIn: t('money.positive') } });
      amountIn = { amount: received.minor.toString(), currency: to.currency };
    }
    setBusy(true);
    setErrors({ fields: {} });
    try {
      await browserApi.createTransfer(workspace.id, {
        date: get('date') || today,
        fromAccountId: fromId,
        toAccountId: get('toAccountId'),
        amount: { amount: parsed.minor.toString(), currency },
        ...(amountIn ? { amountIn } : {}),
        description: get('description') || undefined,
      });
      setSaved(t('transfer.saved'));
      form.reset();
      setTyped({ amount: '', amountIn: '', date: today });
      setFromId(accounts[0]?.id ?? '');
      setToId(accounts.find((a) => a.id !== accounts[0]?.id)?.id ?? '');
      router.refresh();
    } catch (err) {
      setErrors(toFormErrors(err, { 'amount.amount': 'amount', 'amountIn.amount': 'amountIn' }, t));
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
              value={toId}
              onChange={(e) => setToId(e.target.value)}
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
          {(p) => (
            <input
              {...p}
              name="amount"
              className="input num"
              inputMode="decimal"
              placeholder="0.00"
              onChange={(e) => setTyped((v) => ({ ...v, amount: e.target.value }))}
            />
          )}
        </Field>
        {crossCurrency && to && (
          <Field
            id="tr-amount-in"
            label={t('transfer.amount_in', { currency: to.currency })}
            error={errors.fields.amountIn}
            hint={t('transfer.amount_in_hint')}
          >
            {(p) => (
              <input
                {...p}
                name="amountIn"
                className="input num"
                inputMode="decimal"
                placeholder="0.00"
                onChange={(e) => setTyped((v) => ({ ...v, amountIn: e.target.value }))}
              />
            )}
          </Field>
        )}
        <Field id="tr-date" label={t('fields.date')} error={errors.fields.date}>
          {(p) => (
            <input
              {...p}
              name="date"
              type="date"
              className="input"
              defaultValue={today}
              onChange={(e) => setTyped((v) => ({ ...v, date: e.target.value }))}
            />
          )}
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
      {crossCurrency && preview && (
        <div className="rounded border border-line p-3" aria-live="polite">
          <p className="mb-1 text-xs font-medium text-muted">{t('fx.transfer.preview')}</p>
          <TransferFxSummary fx={preview} date={typed.date || today} testId="transfer-fx-preview" />
        </div>
      )}
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
