'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import type { AccountDto, CategoryDto, RecurringDto, WorkspaceDto } from '@montra/api-client';
import { browserApi } from '@/lib/browser-api';
import { friendlyMessage, toFormErrors, type FormErrors } from '@/lib/errors';
import { parseAmountInput } from '@/lib/money';
import { signedTotal, type Direction } from '@/lib/splits';
import { groupCategories } from '@/lib/view-models';
import { Field, FormError } from './field';
import { Money } from './money';
import { useI18n } from './i18n';

const CADENCES = [
  ['weekly', 'Weekly'],
  ['biweekly', 'Every 2 weeks'],
  ['semimonthly', 'Twice a month'],
  ['monthly', 'Monthly'],
  ['quarterly', 'Quarterly'],
  ['yearly', 'Yearly'],
] as const;

const CADENCE_LABEL: Record<string, string> = Object.fromEntries(CADENCES);

/** Recurring templates (TXN-05): list, create, pause/resume. */
export function RecurringManager({
  workspace,
  recurring,
  accounts,
  categories,
  today,
}: {
  workspace: WorkspaceDto;
  recurring: RecurringDto[];
  accounts: AccountDto[];
  categories: CategoryDto[];
  today: string;
}) {
  const router = useRouter();
  const { date } = useI18n();
  const [direction, setDirection] = useState<Direction>('expense');
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? '');
  const [errors, setErrors] = useState<FormErrors>({ fields: {} });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const account = accounts.find((a) => a.id === accountId);
  const currency = account?.currency ?? workspace.baseCurrency;
  const groups = groupCategories(workspace, categories, direction);

  async function onCreate(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    const get = (k: string) => String(f.get(k) ?? '').trim();
    const parsed = parseAmountInput(get('amount'), currency);
    if (!parsed.ok) return setErrors({ fields: { amount: parsed.error } });
    if (!get('categoryId')) return setErrors({ fields: { categoryId: 'Choose a category' } });
    setBusy(true);
    setErrors({ fields: {} });
    try {
      const created = await browserApi.createRecurring(workspace.id, {
        name: get('name'),
        accountId,
        amount: { amount: signedTotal(parsed.minor, direction).toString(), currency },
        payee: get('payee') || undefined,
        categoryId: get('categoryId'),
        cadence: get('cadence') as RecurringDto['cadence'],
        startDate: get('startDate'),
        endDate: get('endDate') || undefined,
        autoCreate: get('autoCreate') === 'posted' ? 'posted' : 'scheduled',
      });
      setMessage(`Created ${created.name}. Next on ${date(created.nextDate)}.`);
      form.reset();
      router.refresh();
    } catch (err) {
      setErrors(toFormErrors(err, { 'amount.amount': 'amount' }));
    } finally {
      setBusy(false);
    }
  }

  async function setStatus(r: RecurringDto, status: RecurringDto['status']) {
    try {
      await browserApi.updateRecurring(workspace.id, r.id, { status });
      router.refresh();
    } catch (err) {
      setMessage(friendlyMessage(err));
    }
  }

  const accountName = new Map(accounts.map((a) => [a.id, a.name]));

  return (
    <div className="space-y-6">
      {recurring.length === 0 ? (
        <p className="card text-sm text-muted">No recurring items yet.</p>
      ) : (
        <ul className="card divide-y divide-line p-0" aria-label="Recurring items">
          {recurring.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
              <div className="min-w-0 flex-1">
                <p className="font-medium">
                  {r.name}
                  {r.status !== 'active' && <span className="ml-2 text-xs text-muted">({r.status})</span>}
                </p>
                <p className="text-xs text-muted">
                  {CADENCE_LABEL[r.cadence] ?? r.cadence} · next {date(r.nextDate)} ·{' '}
                  {accountName.get(r.accountId) ?? ''} ·{' '}
                  {r.autoCreate === 'posted' ? 'posts automatically' : 'asks to confirm'}
                </p>
              </div>
              <Money amount={r.amount.amount} currency={r.amount.currency} signed />
              {r.status === 'active' ? (
                <button type="button" className="btn-secondary" onClick={() => setStatus(r, 'paused')}>
                  Pause
                </button>
              ) : r.status === 'paused' ? (
                <button type="button" className="btn-secondary" onClick={() => setStatus(r, 'active')}>
                  Resume
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      <form onSubmit={onCreate} className="card space-y-4" aria-labelledby="new-recurring" noValidate>
        <h2 id="new-recurring" className="text-base font-semibold">
          New recurring item
        </h2>
        <FormError message={errors.form} />
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Field id="rc-name" label="Name" error={errors.fields.name}>
            {(p) => (
              <input {...p} name="name" className="input" required maxLength={200} placeholder="Rent" />
            )}
          </Field>
          <Field id="rc-type" label="Type" error={errors.fields.direction}>
            {(p) => (
              <select
                {...p}
                className="input"
                value={direction}
                onChange={(e) => setDirection(e.target.value as Direction)}
              >
                <option value="expense">Expense (money out)</option>
                <option value="income">Income (money in)</option>
              </select>
            )}
          </Field>
          <Field id="rc-amount" label="Amount" error={errors.fields.amount}>
            {(p) => (
              <input {...p} name="amount" className="input num" inputMode="decimal" placeholder="0.00" />
            )}
          </Field>
          <Field id="rc-account" label="Account" error={errors.fields.accountId}>
            {(p) => (
              <select
                {...p}
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
          <Field id="rc-payee" label="Payee" error={errors.fields.payee}>
            {(p) => <input {...p} name="payee" className="input" maxLength={200} />}
          </Field>
          <Field id="rc-category" label="Category" error={errors.fields.categoryId}>
            {(p) => (
              <select {...p} name="categoryId" className="input" defaultValue="">
                <option value="">Choose…</option>
                {groups.map((g) => (
                  <optgroup key={g.label} label={g.label}>
                    {g.categories.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
            )}
          </Field>
          <Field id="rc-cadence" label="Repeats" error={errors.fields.cadence}>
            {(p) => (
              <select {...p} name="cadence" className="input" defaultValue="monthly">
                {CADENCES.map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field id="rc-start" label="First date" error={errors.fields.startDate}>
            {(p) => <input {...p} name="startDate" type="date" className="input" defaultValue={today} />}
          </Field>
          <Field id="rc-end" label="End date (optional)" error={errors.fields.endDate}>
            {(p) => <input {...p} name="endDate" type="date" className="input" />}
          </Field>
          <Field id="rc-auto" label="When due" error={errors.fields.autoCreate}>
            {(p) => (
              <select {...p} name="autoCreate" className="input" defaultValue="scheduled">
                <option value="scheduled">Ask me to confirm</option>
                <option value="posted">Post automatically</option>
              </select>
            )}
          </Field>
        </div>
        <div className="flex items-center gap-3">
          <button type="submit" className="btn-primary" disabled={busy || accounts.length === 0}>
            {busy ? 'Saving…' : 'Create recurring item'}
          </button>
          <span role="status" className="text-sm text-good">
            {message}
          </span>
        </div>
      </form>
    </div>
  );
}
