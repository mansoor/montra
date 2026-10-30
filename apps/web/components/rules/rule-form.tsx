'use client';

import { useEffect, useMemo, useState, type FormEvent } from 'react';
import type {
  AccountDto,
  CategoryDto,
  CreateRuleInput,
  FamilyMemberDto,
  WorkspaceDto,
} from '@montra/api-client';
import type { RulePreviewDto } from '@montra/schemas';
import { browserApi } from '@/lib/browser-api';
import { friendlyMessage, toFormErrors, type FormErrors } from '@/lib/errors';
import {
  draftConditions,
  draftActions,
  draftToRequest,
  emptyCondition,
  isListField,
  isTextField,
  newKey,
  OPS_BY_FIELD,
  RULE_FIELDS,
  withField,
  type ConditionDraft,
  type ConditionItem,
  type RuleDraft,
} from '@/lib/rules';
import { groupCategories } from '@/lib/view-models';
import { FormError } from '../field';
import { DateText, useI18n } from '../i18n';
import { Money } from '../money';

const PREVIEW_DELAY_MS = 400;
const DOW = ['0', '1', '2', '3', '4', '5', '6'];

/**
 * Create or edit a rule (UP-02): conditions (all must match; an "any of" group gives OR), actions, and a live
 * preview of how many existing transactions it matches and would change.
 */
export function RuleForm({
  workspace,
  accounts,
  categories,
  members,
  initial,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  workspace: WorkspaceDto;
  accounts: AccountDto[];
  categories: CategoryDto[];
  members: FamilyMemberDto[];
  initial: RuleDraft;
  submitLabel: string;
  onSubmit: (result: { value: CreateRuleInput }) => Promise<void>;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const [draft, setDraft] = useState<RuleDraft>(initial);
  const [errors, setErrors] = useState<FormErrors>({ fields: {} });
  const [badKey, setBadKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<RulePreviewDto | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const groups = useMemo(() => groupCategories(workspace, categories), [workspace, categories]);
  const categoryName = (id: string | null) => categories.find((c) => c.id === id)?.name ?? null;

  // Live preview, debounced; only when the conditions are complete.
  const conditionsKey = JSON.stringify([draft.items, draft.entityId, draft.actions]);
  useEffect(() => {
    const conditions = draftConditions(draft.items);
    if (!('ok' in conditions)) {
      setPreview(null);
      return;
    }
    const actions = draftActions(draft.actions);
    const timer = setTimeout(() => {
      browserApi
        .previewRule(workspace.id, {
          conditions: conditions.value,
          ...('error' in actions ? {} : { actions }),
          entityId: draft.entityId || null,
        })
        .then(
          (p) => {
            setPreview(p);
            setPreviewError(null);
          },
          (err) => setPreviewError(friendlyMessage(err, t)),
        );
    }, PREVIEW_DELAY_MS);
    return () => clearTimeout(timer);
  }, [conditionsKey, workspace.id]); // the key captures items, books and actions

  const setItems = (fn: (items: ConditionItem[]) => ConditionItem[]) =>
    setDraft((d) => ({ ...d, items: fn(d.items) }));
  const updateCond = (key: string, patch: Partial<ConditionDraft>) =>
    setItems((items) =>
      items.map((it) =>
        it.kind === 'cond'
          ? it.cond.key === key
            ? { ...it, cond: { ...it.cond, ...patch } }
            : it
          : { ...it, conds: it.conds.map((c) => (c.key === key ? { ...c, ...patch } : c)) },
      ),
    );
  const changeField = (key: string, field: ConditionDraft['field']) =>
    setItems((items) =>
      items.map((it) =>
        it.kind === 'cond'
          ? it.cond.key === key
            ? { ...it, cond: withField(it.cond, field) }
            : it
          : { ...it, conds: it.conds.map((c) => (c.key === key ? withField(c, field) : c)) },
      ),
    );
  const removeCond = (key: string) =>
    setItems((items) =>
      items
        .map((it) => (it.kind === 'any' ? { ...it, conds: it.conds.filter((c) => c.key !== key) } : it))
        .filter((it) => (it.kind === 'cond' ? it.cond.key !== key : it.conds.length > 0)),
    );

  async function submit(e: FormEvent) {
    e.preventDefault();
    const result = draftToRequest(draft);
    if (!('ok' in result)) {
      setBadKey(result.key || null);
      return setErrors({ fields: {}, form: t(result.error) });
    }
    setBadKey(null);
    setBusy(true);
    setErrors({ fields: {} });
    try {
      await onSubmit(result);
    } catch (err) {
      setErrors(toFormErrors(err, {}, t));
    } finally {
      setBusy(false);
    }
  }

  const condRow = (c: ConditionDraft, label: string) => {
    const ops = OPS_BY_FIELD[c.field];
    return (
      <div
        key={c.key}
        className={`grid gap-2 sm:grid-cols-[10rem_9rem_1fr_auto] ${badKey === c.key ? 'rounded-md ring-2 ring-bad' : ''}`}
        data-testid="rule-condition"
      >
        <select
          aria-label={t('rules.form.field', { n: label })}
          className="input"
          value={c.field}
          onChange={(e) => changeField(c.key, e.target.value as ConditionDraft['field'])}
        >
          {RULE_FIELDS.map((f) => (
            <option key={f} value={f}>
              {t(`rules.field.${f}`)}
            </option>
          ))}
        </select>
        <select
          aria-label={t('rules.form.op', { n: label })}
          className="input"
          value={c.op}
          disabled={ops.length === 1}
          onChange={(e) => updateCond(c.key, { op: e.target.value as ConditionDraft['op'] })}
        >
          {ops.map((o) => (
            <option key={o} value={o}>
              {t(`rules.op.${o}`)}
            </option>
          ))}
        </select>
        <div className="min-w-0">
          {isListField(c.field) ? (
            <select
              multiple
              aria-label={t('rules.form.values', { n: label })}
              className="input h-24"
              value={c.values}
              onChange={(e) =>
                updateCond(c.key, { values: [...e.target.selectedOptions].map((o) => o.value) })
              }
            >
              {c.field === 'account' &&
                accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              {c.field === 'entity' &&
                workspace.entities.map((en) => (
                  <option key={en.id} value={en.id}>
                    {en.name}
                  </option>
                ))}
              {c.field === 'date_dow' &&
                DOW.map((d) => (
                  <option key={d} value={d}>
                    {t(`rules.dow.${d}`)}
                  </option>
                ))}
            </select>
          ) : c.op === 'between' ? (
            <div className="flex items-center gap-2">
              <input
                className="input num"
                inputMode="decimal"
                aria-label={t('rules.form.from', { n: label })}
                placeholder="-200.00"
                value={c.value}
                onChange={(e) => updateCond(c.key, { value: e.target.value })}
              />
              <span className="text-sm text-muted">{t('rules.form.and')}</span>
              <input
                className="input num"
                inputMode="decimal"
                aria-label={t('rules.form.to', { n: label })}
                placeholder="-5.00"
                value={c.value2}
                onChange={(e) => updateCond(c.key, { value2: e.target.value })}
              />
            </div>
          ) : (
            <input
              className={`input ${c.field === 'amount' ? 'num' : ''}`}
              inputMode={c.field === 'amount' ? 'decimal' : undefined}
              aria-label={t('rules.form.value', { n: label })}
              maxLength={c.op === 'regex' ? 100 : 200}
              value={c.value}
              onChange={(e) => updateCond(c.key, { value: e.target.value })}
            />
          )}
          {isTextField(c.field) && (
            <label className="mt-1 flex items-center gap-1 text-xs text-muted">
              <input
                type="checkbox"
                checked={!c.ci}
                onChange={(e) => updateCond(c.key, { ci: !e.target.checked })}
              />
              {t('rules.form.case_sensitive')}
            </label>
          )}
          {c.field === 'amount' && <p className="mt-1 text-xs text-muted">{t('rules.form.amount_hint')}</p>}
        </div>
        <button
          type="button"
          className="btn-secondary self-start"
          aria-label={t('rules.form.remove', { n: label })}
          onClick={() => removeCond(c.key)}
        >
          ×
        </button>
      </div>
    );
  };

  let n = 0;
  return (
    <form onSubmit={submit} className="card space-y-4" aria-label={t('rules.form.label')} noValidate>
      <FormError message={errors.form} action={errors.action} />
      <div className="grid gap-3 sm:grid-cols-[1fr_12rem_8rem]">
        <div>
          <label htmlFor="rule-name" className="field-label">
            {t('rules.form.name')}
          </label>
          <input
            id="rule-name"
            className={`input ${badKey === 'name' ? 'border-bad' : ''}`}
            maxLength={200}
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            placeholder={t('rules.form.name_placeholder')}
          />
        </div>
        <div>
          <label htmlFor="rule-entity" className="field-label">
            {t('rules.form.books')}
          </label>
          <select
            id="rule-entity"
            className="input"
            value={draft.entityId}
            onChange={(e) => setDraft({ ...draft, entityId: e.target.value })}
          >
            <option value="">{t('rules.form.all_books')}</option>
            {workspace.entities.map((en) => (
              <option key={en.id} value={en.id}>
                {en.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="rule-priority" className="field-label">
            {t('rules.form.priority')}
          </label>
          <input
            id="rule-priority"
            type="number"
            min={0}
            max={10000}
            className="input num"
            value={draft.priority}
            onChange={(e) => setDraft({ ...draft, priority: Number(e.target.value) || 0 })}
          />
        </div>
      </div>

      <fieldset className="space-y-2">
        <legend className="field-label">{t('rules.form.when')}</legend>
        {draft.items.map((it) =>
          it.kind === 'cond' ? (
            condRow(it.cond, String(++n))
          ) : (
            <fieldset key={it.key} className="space-y-2 rounded-md border border-dashed border-line p-2">
              <legend className="px-1 text-xs text-muted">{t('rules.form.any_of')}</legend>
              {it.conds.map((c) => condRow(c, String(++n)))}
              <button
                type="button"
                className="btn-secondary"
                onClick={() =>
                  setItems((items) =>
                    items.map((x) =>
                      x.kind === 'any' && x.key === it.key
                        ? { ...x, conds: [...x.conds, emptyCondition()] }
                        : x,
                    ),
                  )
                }
              >
                {t('rules.form.add_or')}
              </button>
            </fieldset>
          ),
        )}
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className="btn-secondary"
            onClick={() => setItems((items) => [...items, { kind: 'cond', cond: emptyCondition() }])}
          >
            {t('rules.form.add_condition')}
          </button>
          <button
            type="button"
            className="btn-secondary"
            onClick={() =>
              setItems((items) => [
                ...items,
                { kind: 'any', key: newKey(), conds: [emptyCondition(), emptyCondition()] },
              ])
            }
          >
            {t('rules.form.add_any')}
          </button>
        </div>
      </fieldset>

      <fieldset className="grid gap-3 sm:grid-cols-2">
        <legend className="field-label">{t('rules.form.then')}</legend>
        <div>
          <label htmlFor="rule-category" className="field-label">
            {t('fields.category')}
          </label>
          <select
            id="rule-category"
            className="input"
            value={draft.actions.categoryId}
            onChange={(e) =>
              setDraft({ ...draft, actions: { ...draft.actions, categoryId: e.target.value } })
            }
          >
            <option value="">{t('rules.form.keep')}</option>
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
        </div>
        <div>
          <label htmlFor="rule-member" className="field-label">
            {t('fields.member')}
          </label>
          <select
            id="rule-member"
            className="input"
            value={draft.actions.memberId}
            onChange={(e) => setDraft({ ...draft, actions: { ...draft.actions, memberId: e.target.value } })}
          >
            <option value="">{t('rules.form.keep')}</option>
            {members
              .filter((m) => m.status === 'active')
              .map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
          </select>
        </div>
        <div>
          <label htmlFor="rule-tags" className="field-label">
            {t('fields.tags')}
          </label>
          <input
            id="rule-tags"
            className="input"
            value={draft.actions.tags}
            placeholder={t('fields.comma_separated')}
            onChange={(e) => setDraft({ ...draft, actions: { ...draft.actions, tags: e.target.value } })}
          />
        </div>
        <div>
          <label htmlFor="rule-rename" className="field-label">
            {t('rules.form.rename_payee')}
          </label>
          <input
            id="rule-rename"
            className="input"
            maxLength={200}
            value={draft.actions.renamePayee}
            onChange={(e) =>
              setDraft({ ...draft, actions: { ...draft.actions, renamePayee: e.target.value } })
            }
          />
        </div>
        <label className="flex items-center gap-2 text-sm sm:col-span-2">
          <input
            type="checkbox"
            checked={draft.actions.markReviewed}
            onChange={(e) =>
              setDraft({ ...draft, actions: { ...draft.actions, markReviewed: e.target.checked } })
            }
          />
          {t('rules.form.mark_reviewed')}
        </label>
        <label className="flex items-center gap-2 text-sm sm:col-span-2">
          <input
            type="checkbox"
            checked={draft.enabled}
            onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })}
          />
          {t('rules.form.enabled')}
        </label>
      </fieldset>

      <section
        aria-live="polite"
        className="rounded-md border border-line bg-canvas p-3 text-sm"
        data-testid="rule-preview"
      >
        {previewError ? (
          <p className="text-bad">{previewError}</p>
        ) : preview ? (
          <>
            <p className="font-medium" data-testid="rule-preview-counts">
              {t('rules.preview.counts', { matches: preview.matches, changes: preview.changes })}
              {preview.skippedLocked > 0 && ` ${t('rules.preview.locked', { count: preview.skippedLocked })}`}
            </p>
            {preview.sample.length > 0 && (
              <ul className="mt-2 divide-y divide-line">
                {preview.sample.map((s) => (
                  <li key={s.transactionId} className="flex justify-between gap-3 py-1">
                    <span className="min-w-0 truncate">
                      <DateText date={s.date} /> · {s.payee || t('transactions.no_payee')}
                      {categoryName(s.categoryId) && (
                        <span className="text-muted"> · {categoryName(s.categoryId)}</span>
                      )}
                    </span>
                    {s.amount && <Money amount={s.amount.amount} currency={s.amount.currency} signed />}
                  </li>
                ))}
              </ul>
            )}
          </>
        ) : (
          <p className="text-muted">{t('rules.preview.hint')}</p>
        )}
      </section>

      <div className="flex gap-2">
        <button type="submit" className="btn-primary" disabled={busy}>
          {busy ? t('common.saving') : submitLabel}
        </button>
        <button type="button" className="btn-secondary" onClick={onCancel}>
          {t('common.cancel')}
        </button>
      </div>
    </form>
  );
}
