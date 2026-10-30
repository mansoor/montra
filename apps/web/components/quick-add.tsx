'use client';

import { useRouter } from 'next/navigation';
import { useMemo, useRef, useState, type FormEvent } from 'react';
import type { AccountDto, CategoryDto, WorkspaceDto } from '@montra/api-client';
import { browserApi } from '@/lib/browser-api';
import { toFormErrors, type FormErrors } from '@/lib/errors';
import { parseAmountInput } from '@/lib/money';
import { signedTotal, toSplitPayload, type Direction, type SplitLine } from '@/lib/splits';
import { groupCategories } from '@/lib/view-models';
import { Field, FormError } from './field';
import { SplitEditor } from './split-editor';
import { useI18n } from './i18n';

/**
 * Quick-add bar (TXN-01): amount, payee, category, account and date in one row; Enter submits. An empty
 * category posts as "Uncategorized" and lands in the review queue.
 */
export function QuickAdd({
  workspace,
  accounts,
  categories,
  today,
}: {
  workspace: WorkspaceDto;
  accounts: AccountDto[];
  categories: CategoryDto[];
  today: string;
}) {
  const router = useRouter();
  const { t, locale } = useI18n();
  const amountRef = useRef<HTMLInputElement>(null);
  const [direction, setDirection] = useState<Direction>('expense');
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? '');
  const [amount, setAmount] = useState('');
  const [splits, setSplits] = useState<SplitLine[]>([]);
  const [splitOpen, setSplitOpen] = useState(false);
  const [errors, setErrors] = useState<FormErrors>({ fields: {} });
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);

  const account = accounts.find((a) => a.id === accountId);
  const currency = account?.currency ?? workspace.baseCurrency;
  const allGroups = useMemo(
    () => groupCategories(workspace, categories, direction),
    [workspace, categories, direction],
  );
  // The single-category picker shows the account's own books first; splits can reach every entity.
  const pickerGroups = useMemo(
    () => [
      ...allGroups.filter((g) => g.categories.some((c) => c.entityId === account?.entityId)),
      ...allGroups.filter((g) => !g.categories.some((c) => c.entityId === account?.entityId)),
    ],
    [allGroups, account?.entityId],
  );

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    const get = (k: string) => String(f.get(k) ?? '').trim();
    const parsed = parseAmountInput(amount, currency, locale, t);
    if (!account) return setErrors({ fields: { accountId: t('quick_add.add_account_first') } });
    if (!parsed.ok) return setErrors({ fields: { amount: parsed.error } });
    if (parsed.minor === 0n) return setErrors({ fields: { amount: t('money.not_zero') } });
    const signed = signedTotal(parsed.minor, direction);
    setBusy(true);
    setErrors({ fields: {} });
    try {
      await browserApi.createTransaction(workspace.id, {
        date: get('date') || today,
        accountId: account.id,
        amount: { amount: signed.toString(), currency },
        payee: get('payee') || undefined,
        ...(splits.length
          ? { splits: toSplitPayload(splits, currency, direction) }
          : get('categoryId')
            ? { categoryId: get('categoryId') }
            : {}),
      });
      setSaved(t('quick_add.saved', { name: get('payee') || t('quick_add.transaction') }));
      setAmount('');
      setSplits([]);
      // Keep account, date and type for the next entry; clear what describes this one.
      const payee = form.elements.namedItem('payee');
      if (payee instanceof HTMLInputElement) payee.value = '';
      const category = form.elements.namedItem('categoryId');
      if (category instanceof HTMLSelectElement) category.value = '';
      router.refresh();
      amountRef.current?.focus();
    } catch (err) {
      setErrors(toFormErrors(err, { 'amount.amount': 'amount', splits: 'amount' }, t));
    } finally {
      setBusy(false);
    }
  }

  if (accounts.length === 0) {
    return <p className="card text-sm">{t('quick_add.no_accounts')}</p>;
  }

  return (
    <>
      <form onSubmit={onSubmit} className="card space-y-3" aria-labelledby="quick-add-title" noValidate>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="quick-add-title" className="text-base font-semibold">
            {t('quick_add.title')}
          </h2>
          <div
            role="radiogroup"
            aria-label={t('quick_add.type')}
            className="inline-flex overflow-hidden rounded-md border border-line"
          >
            {(['expense', 'income'] as const).map((d) => (
              <button
                key={d}
                type="button"
                role="radio"
                aria-checked={direction === d}
                onClick={() => {
                  setDirection(d);
                  setSplits([]);
                }}
                className={`px-3 py-1.5 text-sm ${direction === d ? 'bg-brand-600 text-white' : 'bg-surface hover:bg-brand-50'}`}
              >
                {t(d === 'expense' ? 'quick_add.expense' : 'quick_add.income')}
              </button>
            ))}
          </div>
        </div>
        <FormError message={errors.form} action={errors.action} />
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[8rem_1fr_1fr_1fr_9rem_auto]">
          <Field id="qa-amount" label={t('fields.amount')} error={errors.fields.amount}>
            {(p) => (
              <input
                {...p}
                ref={amountRef}
                name="amount"
                className="input num"
                inputMode="decimal"
                placeholder="0.00"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                autoFocus
              />
            )}
          </Field>
          <Field id="qa-payee" label={t('fields.payee')} error={errors.fields.payee}>
            {(p) => (
              <input
                {...p}
                name="payee"
                className="input"
                maxLength={200}
                placeholder={t('quick_add.payee_placeholder')}
              />
            )}
          </Field>
          <Field id="qa-category" label={t('fields.category')} error={errors.fields.categoryId}>
            {(p) =>
              splits.length ? (
                <button
                  {...p}
                  type="button"
                  className="input text-left"
                  aria-label={t('split.button_label', { count: splits.length })}
                  onClick={() => setSplitOpen(true)}
                >
                  {t('split.summary', { count: splits.length })}
                </button>
              ) : (
                <select {...p} name="categoryId" className="input" defaultValue="">
                  <option value="">{t('quick_add.uncategorized')}</option>
                  {pickerGroups.map((g) => (
                    <optgroup key={g.label} label={g.label}>
                      {g.categories.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </select>
              )
            }
          </Field>
          <Field id="qa-account" label={t('fields.account')} error={errors.fields.accountId}>
            {(p) => (
              <select
                {...p}
                name="accountId"
                className="input"
                value={accountId}
                onChange={(e) => setAccountId(e.target.value)}
              >
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field id="qa-date" label={t('fields.date')} error={errors.fields.date}>
            {(p) => <input {...p} name="date" type="date" className="input" defaultValue={today} />}
          </Field>
          <div className="flex items-end gap-2">
            <button type="button" className="btn-secondary" onClick={() => setSplitOpen(true)}>
              {t('split.open')}
            </button>
            <button type="submit" className="btn-primary" disabled={busy}>
              {busy ? t('common.saving') : t('quick_add.add')}
            </button>
          </div>
        </div>
        <p aria-live="polite" className="text-sm text-good">
          {saved}
        </p>
      </form>
      {/* Outside the quick-add form: the dialog has its own form, and forms can't nest. */}
      <SplitEditor
        open={splitOpen}
        total={amount}
        currency={currency}
        groups={allGroups}
        initial={splits}
        onClose={() => setSplitOpen(false)}
        onSave={(lines) => {
          setSplits(lines);
          setSplitOpen(false);
        }}
      />
    </>
  );
}
