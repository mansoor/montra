'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import type { WorkspaceDto } from '@montra/api-client';
import { browserApi } from '@/lib/browser-api';
import { toFormErrors, type FormErrors } from '@/lib/errors';
import { parseAmountInput } from '@/lib/money';
import { Field, FormError } from './field';

const KINDS = [
  ['checking', 'Checking'],
  ['savings', 'Savings'],
  ['credit_card', 'Credit card'],
  ['cash', 'Cash'],
  ['loan', 'Loan'],
  ['mortgage', 'Mortgage'],
  ['line_of_credit', 'Line of credit'],
  ['investment', 'Investment (balance only)'],
  ['asset', 'Other asset (property, vehicle)'],
  ['liability', 'Other liability'],
] as const;
type Kind = (typeof KINDS)[number][0];

const LIABILITY: ReadonlySet<Kind> = new Set([
  'credit_card',
  'loan',
  'mortgage',
  'line_of_credit',
  'liability',
]);

export function NewAccountForm({ workspace, today }: { workspace: WorkspaceDto; today: string }) {
  const router = useRouter();
  const [kind, setKind] = useState<Kind>('checking');
  const [errors, setErrors] = useState<FormErrors>({ fields: {} });
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const get = (k: string) => String(f.get(k) ?? '').trim();
    const currency = get('currency').toUpperCase() || workspace.baseCurrency;
    const balanceInput = get('openingBalance');
    let openingBalance: { amount: string; currency: string } | undefined;
    if (balanceInput) {
      const parsed = parseAmountInput(balanceInput, currency);
      if (!parsed.ok) {
        setErrors({ fields: { openingBalance: parsed.error } });
        return;
      }
      openingBalance = { amount: parsed.minor.toString(), currency };
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
        openingBalance,
        openingDate: get('openingDate') || undefined,
      });
      router.push(`/w/${workspace.id}/accounts/${account.id}`);
      router.refresh();
    } catch (err) {
      setErrors(
        toFormErrors(err, {
          'openingBalance.amount': 'openingBalance',
          'openingBalance.currency': 'currency',
        }),
      );
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="card max-w-xl space-y-4" noValidate>
      <FormError message={errors.form} />
      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="kind" label="Account type" error={errors.fields.kind}>
          {(p) => (
            <select
              {...p}
              name="kind"
              className="input"
              value={kind}
              onChange={(e) => setKind(e.target.value as Kind)}
            >
              {KINDS.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field id="entityId" label="Belongs to" error={errors.fields.entityId}>
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
      <Field id="name" label="Name" error={errors.fields.name}>
        {(p) => (
          <input
            {...p}
            name="name"
            className="input"
            required
            maxLength={200}
            placeholder="Everyday checking"
          />
        )}
      </Field>
      <div className="grid gap-4 sm:grid-cols-3">
        <Field
          id="institution"
          label="Bank (optional)"
          error={errors.fields.institution}
          className="sm:col-span-2"
        >
          {(p) => <input {...p} name="institution" className="input" maxLength={200} />}
        </Field>
        <Field id="last4" label="Last 4 digits" error={errors.fields.last4}>
          {(p) => (
            <input {...p} name="last4" className="input" inputMode="numeric" pattern="\d{4}" maxLength={4} />
          )}
        </Field>
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        <Field
          id="openingBalance"
          label={LIABILITY.has(kind) ? 'Amount owed' : 'Current balance'}
          error={errors.fields.openingBalance}
          hint={LIABILITY.has(kind) ? 'What you owe today, e.g. 1250.00' : 'e.g. 2500.00'}
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
        <Field id="currency" label="Currency" error={errors.fields.currency}>
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
        <Field id="openingDate" label="As of" error={errors.fields.openingDate}>
          {(p) => <input {...p} name="openingDate" type="date" className="input" defaultValue={today} />}
        </Field>
      </div>
      <button type="submit" className="btn-primary" disabled={busy}>
        {busy ? 'Saving…' : 'Add account'}
      </button>
    </form>
  );
}
