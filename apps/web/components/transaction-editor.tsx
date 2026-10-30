'use client';

import { useRouter } from 'next/navigation';
import { useMemo, useState, type FormEvent } from 'react';
import type {
  AccountDto,
  CategoryDto,
  FamilyMemberDto,
  TransactionDto,
  WorkspaceDto,
} from '@montra/api-client';
import { browserApi } from '@/lib/browser-api';
import { friendlyMessage, toFormErrors, type FormErrors } from '@/lib/errors';
import { buildPatch, isEmptyPatch, toEditState, type EditState } from '@/lib/transaction-edit';
import { groupCategories } from '@/lib/view-models';
import { Field, FormError } from './field';
import { SplitEditor } from './split-editor';

/**
 * Edits a transaction (DE-10). Only changed fields are sent, with If-Match for optimistic concurrency; the
 * API rewrites, reclassifies or reverses depending on locks. Delete moves it to the trash.
 */
export function TransactionEditor({
  workspace,
  transaction,
  accounts,
  categories,
  members,
}: {
  workspace: WorkspaceDto;
  transaction: TransactionDto;
  accounts: AccountDto[];
  categories: CategoryDto[];
  members: FamilyMemberDto[];
}) {
  const router = useRouter();
  const accountIds = useMemo(() => new Set(accounts.map((a) => a.id)), [accounts]);
  const initial = useMemo(() => toEditState(transaction, accountIds), [transaction, accountIds]);
  const [state, setState] = useState<EditState>(initial);
  const [errors, setErrors] = useState<FormErrors>({ fields: {} });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [splitOpen, setSplitOpen] = useState(false);
  const deleted = transaction.status === 'void';
  const groups = useMemo(
    () => groupCategories(workspace, categories, state.direction),
    [workspace, categories, state.direction],
  );
  const set = <K extends keyof EditState>(k: K, v: EditState[K]) => setState((s) => ({ ...s, [k]: v }));

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const result = buildPatch(initial, state);
    if (!result.ok) return setErrors({ fields: { [result.field]: result.error } });
    if (isEmptyPatch(result.patch)) return setNotice('Nothing changed.');
    setBusy(true);
    setErrors({ fields: {} });
    setNotice(null);
    try {
      await browserApi.updateTransaction(workspace.id, transaction.id, transaction.version, result.patch);
      setNotice('Saved.');
      router.refresh();
    } catch (err) {
      setErrors(toFormErrors(err, { 'amount.amount': 'amount', splits: 'amount' }));
    } finally {
      setBusy(false);
    }
  }

  async function onDelete() {
    if (!window.confirm('Move this transaction to the trash?')) return;
    setBusy(true);
    try {
      const { outcome } = await browserApi.deleteTransaction(
        workspace.id,
        transaction.id,
        transaction.version,
      );
      setNotice(
        outcome === 'reversed'
          ? 'Moved to trash. Its period is closed, so a reversing entry was posted.'
          : 'Moved to trash.',
      );
      router.refresh();
      setBusy(false);
    } catch (err) {
      setErrors({ form: friendlyMessage(err), fields: {} });
      setBusy(false);
    }
  }

  async function onRestore() {
    setBusy(true);
    try {
      await browserApi.restoreTransaction(workspace.id, transaction.id);
      router.refresh();
    } catch (err) {
      setErrors({ form: friendlyMessage(err), fields: {} });
    } finally {
      setBusy(false);
    }
  }

  async function onConfirm() {
    setBusy(true);
    try {
      await browserApi.confirmOccurrence(workspace.id, transaction.id);
      router.refresh();
    } catch (err) {
      setErrors({ form: friendlyMessage(err), fields: {} });
    } finally {
      setBusy(false);
    }
  }

  if (deleted) {
    return (
      <div className="card space-y-3">
        <FormError message={errors.form} />
        <p className="text-sm" role="status">
          {notice ?? 'This transaction is in the trash.'}
        </p>
        <button type="button" className="btn-primary" disabled={busy} onClick={onRestore}>
          Restore
        </button>
      </div>
    );
  }

  const currencyAccounts = accounts.filter((a) => a.currency === state.currency && !a.archived);

  return (
    <>
      <form onSubmit={onSubmit} className="card space-y-4" aria-label="Edit transaction" noValidate>
        <FormError message={errors.form} />
        {transaction.reviewState === 'needs_review' && (
          <p className="text-sm text-muted">Needs review: saving a category marks it reviewed.</p>
        )}
        {!initial.ledgerEditable && (
          <p className="text-sm text-muted">
            Transfers are edited as descriptive details only. Delete and re-enter to change accounts or
            amounts.
          </p>
        )}
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Field id="ed-date" label="Date" error={errors.fields.date}>
            {(p) => (
              <input
                {...p}
                type="date"
                className="input"
                value={state.date}
                onChange={(e) => set('date', e.target.value)}
              />
            )}
          </Field>
          <Field id="ed-amount" label="Amount" error={errors.fields.amount}>
            {(p) => (
              <input
                {...p}
                className="input num"
                inputMode="decimal"
                value={state.amount}
                disabled={!initial.ledgerEditable}
                onChange={(e) => set('amount', e.target.value)}
              />
            )}
          </Field>
          <Field id="ed-direction" label="Type" error={errors.fields.direction}>
            {(p) => (
              <select
                {...p}
                className="input"
                value={state.direction}
                disabled={!initial.ledgerEditable}
                onChange={(e) => set('direction', e.target.value as EditState['direction'])}
              >
                <option value="expense">Expense (money out)</option>
                <option value="income">Income (money in)</option>
              </select>
            )}
          </Field>
          <Field id="ed-account" label="Account" error={errors.fields.accountId}>
            {(p) => (
              <select
                {...p}
                className="input"
                value={state.accountId}
                disabled={!initial.ledgerEditable}
                onChange={(e) => set('accountId', e.target.value)}
              >
                {!state.accountId && <option value="">—</option>}
                {currencyAccounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field id="ed-payee" label="Payee" error={errors.fields.payee} className="sm:col-span-2">
            {(p) => (
              <input
                {...p}
                className="input"
                maxLength={200}
                value={state.payee}
                onChange={(e) => set('payee', e.target.value)}
              />
            )}
          </Field>
          <Field
            id="ed-category"
            label="Category"
            error={errors.fields.categoryId ?? errors.fields.splits}
            className="sm:col-span-2"
          >
            {(p) =>
              state.mode === 'splits' ? (
                <button
                  {...p}
                  type="button"
                  className="input text-left"
                  disabled={!initial.ledgerEditable}
                  aria-label={`Category: split into ${state.splits.length} lines. Edit split`}
                  onClick={() => setSplitOpen(true)}
                >
                  Split into {state.splits.length} lines
                </button>
              ) : (
                <div className="flex gap-2">
                  <select
                    {...p}
                    className="input"
                    value={state.categoryId}
                    disabled={!initial.ledgerEditable}
                    onChange={(e) => set('categoryId', e.target.value)}
                  >
                    {!state.categoryId && <option value="">Uncategorized</option>}
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
                  <button
                    type="button"
                    className="btn-secondary"
                    disabled={!initial.ledgerEditable}
                    onClick={() => setSplitOpen(true)}
                  >
                    Split
                  </button>
                </div>
              )
            }
          </Field>
          <Field id="ed-member" label="Family member" error={errors.fields.memberId}>
            {(p) => (
              <select
                {...p}
                className="input"
                value={state.memberId}
                onChange={(e) => set('memberId', e.target.value)}
              >
                <option value="">Household</option>
                {members
                  .filter((m) => m.status === 'active' || m.id === state.memberId)
                  .map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
              </select>
            )}
          </Field>
          <Field
            id="ed-tags"
            label="Tags"
            error={errors.fields.tags}
            hint="Comma separated"
            className="sm:col-span-3"
          >
            {(p) => (
              <input
                {...p}
                className="input"
                value={state.tags}
                onChange={(e) => set('tags', e.target.value)}
              />
            )}
          </Field>
          <Field id="ed-memo" label="Memo" error={errors.fields.memo} className="sm:col-span-2 lg:col-span-4">
            {(p) => (
              <textarea
                {...p}
                className="input"
                rows={2}
                maxLength={2000}
                value={state.memo}
                onChange={(e) => set('memo', e.target.value)}
              />
            )}
          </Field>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button type="submit" className="btn-primary" disabled={busy}>
            {busy ? 'Saving…' : 'Save changes'}
          </button>
          {transaction.status === 'scheduled' && (
            <button type="button" className="btn-secondary" disabled={busy} onClick={onConfirm}>
              Confirm occurrence
            </button>
          )}
          <button type="button" className="btn-secondary ml-auto text-bad" disabled={busy} onClick={onDelete}>
            Delete
          </button>
          <span role="status" className="w-full text-sm text-good">
            {notice}
          </span>
        </div>
      </form>
      <SplitEditor
        open={splitOpen}
        total={state.amount}
        currency={state.currency}
        groups={groupCategories(workspace, categories, state.direction)}
        initial={state.mode === 'splits' ? state.splits : []}
        onClose={() => setSplitOpen(false)}
        onSave={(lines) => {
          setState((s) => ({ ...s, mode: 'splits', splits: lines, categoryId: '' }));
          setSplitOpen(false);
        }}
      />
    </>
  );
}
