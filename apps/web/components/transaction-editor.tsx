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
import { errorAction, friendlyMessage, toFormErrors, type FormErrors } from '@/lib/errors';
import { buildPatch, isEmptyPatch, toEditState, type EditState } from '@/lib/transaction-edit';
import { parseAmountInput } from '@/lib/money';
import { signedTotal } from '@/lib/splits';
import { groupCategories } from '@/lib/view-models';
import { Field, FormError } from './field';
import { SplitEditor } from './split-editor';
import { CategorySuggestion } from './category-suggestion';
import { Explanation } from './ai/shared';
import { useI18n } from './i18n';

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
  const { t, locale } = useI18n();
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
    const result = buildPatch(initial, state, t);
    if (!result.ok) return setErrors({ fields: { [result.field]: result.error } });
    if (isEmptyPatch(result.patch)) return setNotice(t('editor.nothing_changed'));
    setBusy(true);
    setErrors({ fields: {} });
    setNotice(null);
    try {
      await browserApi.updateTransaction(workspace.id, transaction.id, transaction.version, result.patch);
      setNotice(t('editor.saved'));
      router.refresh();
    } catch (err) {
      setErrors(toFormErrors(err, { 'amount.amount': 'amount', splits: 'amount' }, t));
    } finally {
      setBusy(false);
    }
  }

  async function onDelete() {
    if (!window.confirm(t('editor.confirm_delete'))) return;
    setBusy(true);
    try {
      const { outcome } = await browserApi.deleteTransaction(
        workspace.id,
        transaction.id,
        transaction.version,
      );
      setNotice(outcome === 'reversed' ? t('editor.deleted_reversed') : t('editor.deleted'));
      router.refresh();
      setBusy(false);
    } catch (err) {
      setErrors({ form: friendlyMessage(err, t), fields: {}, action: errorAction(err, t) });
      setBusy(false);
    }
  }

  async function onRestore() {
    setBusy(true);
    try {
      await browserApi.restoreTransaction(workspace.id, transaction.id);
      router.refresh();
    } catch (err) {
      setErrors({ form: friendlyMessage(err, t), fields: {}, action: errorAction(err, t) });
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
      setErrors({ form: friendlyMessage(err, t), fields: {}, action: errorAction(err, t) });
    } finally {
      setBusy(false);
    }
  }

  if (deleted) {
    return (
      <div className="card space-y-3">
        <FormError message={errors.form} action={errors.action} />
        <p className="text-sm" role="status">
          {notice ?? t('editor.in_trash')}
        </p>
        <button type="button" className="btn-primary" disabled={busy} onClick={onRestore}>
          {t('common.restore')}
        </button>
      </div>
    );
  }

  const parsedAmount = parseAmountInput(state.amount, state.currency, locale, t);
  const suggestionAmount = parsedAmount.ok ? signedTotal(parsedAmount.minor, state.direction) : null;
  const currencyAccounts = accounts.filter((a) => a.currency === state.currency && !a.archived);

  return (
    <>
      <form onSubmit={onSubmit} className="card space-y-4" aria-label={t('editor.label')} noValidate>
        <FormError message={errors.form} action={errors.action} />
        {transaction.reviewState === 'needs_review' && (
          <p className="text-sm text-muted">{t('editor.needs_review_hint')}</p>
        )}
        {transaction.categorization && (
          <p className="text-sm" data-testid="editor-categorization">
            <span className="text-muted">{t('editor.categorized_by')}</span>{' '}
            <Explanation categorization={transaction.categorization} />
          </p>
        )}
        {!initial.ledgerEditable && <p className="text-sm text-muted">{t('editor.transfer_hint')}</p>}
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Field id="ed-date" label={t('fields.date')} error={errors.fields.date}>
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
          <Field id="ed-amount" label={t('fields.amount')} error={errors.fields.amount}>
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
          <Field id="ed-direction" label={t('fields.type')} error={errors.fields.direction}>
            {(p) => (
              <select
                {...p}
                className="input"
                value={state.direction}
                disabled={!initial.ledgerEditable}
                onChange={(e) => set('direction', e.target.value as EditState['direction'])}
              >
                <option value="expense">{t('fields.expense_out')}</option>
                <option value="income">{t('fields.income_in')}</option>
              </select>
            )}
          </Field>
          <Field id="ed-account" label={t('fields.account')} error={errors.fields.accountId}>
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
            label={t('fields.category')}
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
                  aria-label={t('split.button_label', { count: state.splits.length })}
                  onClick={() => setSplitOpen(true)}
                >
                  {t('split.summary', { count: state.splits.length })}
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
                    {!state.categoryId && <option value="">{t('editor.uncategorized')}</option>}
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
                    {t('split.open')}
                  </button>
                </div>
              )
            }
          </Field>
          {state.mode === 'category' && !state.categoryId && initial.ledgerEditable && (
            <div className="sm:col-span-2 lg:col-span-4">
              <CategorySuggestion
                workspaceId={workspace.id}
                payee={state.payee}
                amountMinor={suggestionAmount}
                currency={state.currency}
                accountId={state.accountId}
                date={state.date}
                categoryName={(id) => categories.find((c) => c.id === id)?.name ?? null}
                onApply={(sg) =>
                  setState((st) => ({
                    ...st,
                    categoryId: sg.categoryId ?? st.categoryId,
                    ...(sg.memberId && !st.memberId ? { memberId: sg.memberId } : {}),
                  }))
                }
              />
            </div>
          )}
          <Field id="ed-member" label={t('fields.member')} error={errors.fields.memberId}>
            {(p) => (
              <select
                {...p}
                className="input"
                value={state.memberId}
                onChange={(e) => set('memberId', e.target.value)}
              >
                <option value="">{t('members.household')}</option>
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
            label={t('fields.tags')}
            error={errors.fields.tags}
            hint={t('fields.comma_separated')}
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
          <Field
            id="ed-memo"
            label={t('fields.memo')}
            error={errors.fields.memo}
            className="sm:col-span-2 lg:col-span-4"
          >
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
            {busy ? t('common.saving') : t('editor.save')}
          </button>
          {transaction.status === 'scheduled' && (
            <button type="button" className="btn-secondary" disabled={busy} onClick={onConfirm}>
              {t('editor.confirm_occurrence')}
            </button>
          )}
          <button type="button" className="btn-secondary ml-auto text-bad" disabled={busy} onClick={onDelete}>
            {t('common.delete')}
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
