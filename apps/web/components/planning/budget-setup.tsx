'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Sparkles } from 'lucide-react';
import type { DraftBudgetDto, FamilyMemberDto, WorkspaceDto } from '@montra/api-client';
import { browserApi } from '@/lib/browser-api';
import { parseAmountInput } from '@/lib/money';
import { useI18n } from '../i18n';
import { Money } from '../money';
import { StatusLine, useAction } from '../use-action';

const METHODS = ['zero_based', 'category_limits', 'light'] as const;
const PERIODS = ['monthly', 'biweekly', 'weekly'] as const;

/**
 * First budget for an entity (BUD-01, BUD-02, BUD-05, UP-11): pick a method and period, optionally preview a
 * draft from 1–3 months of history (numbers from code, explanation from AI) and start with it.
 */
export function BudgetSetup({
  workspace,
  entityId,
  member = null,
  today,
}: {
  workspace: WorkspaceDto;
  entityId: string;
  /** FAM-06: a budget for this member, alongside the household's. */
  member?: Pick<FamilyMemberDto, 'id' | 'name'> | null;
  today: string;
}) {
  const router = useRouter();
  const { t, locale } = useI18n();
  const { run, busy, message, setMessage } = useAction();
  const entity = workspace.entities.find((e) => e.id === entityId);
  const [name, setName] = useState(
    member
      ? t('budget.member_title', { name: member.name })
      : entity?.type === 'personal'
        ? t('budget.default_name')
        : (entity?.name ?? ''),
  );
  const [method, setMethod] = useState<(typeof METHODS)[number]>('zero_based');
  const [periodType, setPeriodType] = useState<(typeof PERIODS)[number]>('monthly');
  const [anchor, setAnchor] = useState(today);
  const [savings, setSavings] = useState('');
  const [months, setMonths] = useState(3);
  const [draft, setDraft] = useState<DraftBudgetDto | null>(null);
  const ccy = entity?.functionalCurrency ?? workspace.baseCurrency;

  async function create(useDraft: boolean) {
    let savingsTarget: string | null = null;
    if (method === 'light' && savings) {
      const parsed = parseAmountInput(savings, ccy, locale);
      if (!parsed.ok || parsed.minor < 0n) {
        setMessage({ tone: 'bad', text: t('budget.amount_invalid') });
        return;
      }
      savingsTarget = String(parsed.minor);
    }
    await run(async () => {
      const budget = await browserApi.createBudget(workspace.id, {
        entityId,
        memberId: member?.id ?? null,
        name,
        method,
        periodType,
        anchorDate: periodType === 'monthly' ? null : anchor,
        savingsTarget,
      });
      if (useDraft && draft) {
        let period = await browserApi.getBudgetPeriod(workspace.id, budget.id);
        for (const l of draft.lines) {
          period = await browserApi.assignBudget(workspace.id, budget.id, period.start, l.categoryId, {
            assigned: l.suggested,
            version: period.budget.version,
          });
        }
      }
      return budget;
    }, t('budget.created'));
    router.refresh();
  }

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <form
        className="card space-y-4"
        aria-label={t('budget.setup')}
        onSubmit={(e) => {
          e.preventDefault();
          void create(false);
        }}
      >
        <h2 className="text-lg font-semibold">{t('budget.setup')}</h2>
        <label className="block">
          <span className="field-label">{t('budget.name')}</span>
          <input
            className="input"
            value={name}
            required
            maxLength={200}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <fieldset>
          <legend className="field-label">{t('budget.method')}</legend>
          <div className="grid gap-2">
            {METHODS.map((m) => (
              <label
                key={m}
                className={`flex cursor-pointer gap-3 rounded-[var(--radius-m)] border p-3 ${method === m ? 'border-brand-600 bg-brand-50' : 'border-line'}`}
              >
                <input type="radio" name="method" checked={method === m} onChange={() => setMethod(m)} />
                <span>
                  <span className="block text-sm font-semibold">{t(`budget.method_${m}`)}</span>
                  <span className="block text-xs text-muted">{t(`budget.method_${m}_hint`)}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="field-label">{t('budget.period')}</span>
            <select
              className="input"
              value={periodType}
              onChange={(e) => setPeriodType(e.target.value as (typeof PERIODS)[number])}
            >
              {PERIODS.map((p) => (
                <option key={p} value={p}>
                  {t(`budget.period_${p}`)}
                </option>
              ))}
            </select>
          </label>
          {periodType !== 'monthly' && (
            <label className="block">
              <span className="field-label">{t('budget.anchor')}</span>
              <input
                type="date"
                className="input"
                value={anchor}
                onChange={(e) => setAnchor(e.target.value)}
              />
            </label>
          )}
          {method === 'light' && (
            <label className="block">
              <span className="field-label">{t('budget.savings_target')}</span>
              <input
                className="input num"
                inputMode="decimal"
                value={savings}
                onChange={(e) => setSavings(e.target.value)}
              />
            </label>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="submit" className="btn-primary" disabled={busy || !name.trim()}>
            {t('budget.create')}
          </button>
        </div>
        <StatusLine message={message} />
      </form>

      <section className="card space-y-3" aria-label={t('budget.draft')}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-lg font-semibold">{t('budget.draft')}</h2>
          <div className="flex items-center gap-2">
            <select
              className="input w-auto"
              value={months}
              onChange={(e) => setMonths(Number(e.target.value))}
              aria-label={t('budget.draft_months')}
            >
              {[1, 2, 3].map((m) => (
                <option key={m} value={m}>
                  {t('budget.months', { count: m })}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="btn-secondary"
              disabled={busy}
              onClick={async () => {
                const d = await run(() => browserApi.draftBudget(workspace.id, { entityId, months }));
                if (d) setDraft(d);
              }}
            >
              <Sparkles aria-hidden size={15} />
              {t('budget.draft_run')}
            </button>
          </div>
        </div>
        <p className="text-sm text-muted">{t('budget.draft_hint')}</p>
        {draft && (
          <>
            {draft.explanation && (
              <p className="rounded-[var(--radius-m)] bg-brand-50 p-3 text-sm">{draft.explanation}</p>
            )}
            {draft.lines.length === 0 ? (
              <p className="text-sm text-muted">{t('budget.draft_empty')}</p>
            ) : (
              <table className="tbl">
                <thead>
                  <tr>
                    <th scope="col" className="px-2 py-1.5">
                      {t('budget.category')}
                    </th>
                    <th scope="col" className="px-2 py-1.5 text-right">
                      {t('budget.suggested')}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {draft.lines.map((l) => (
                    <tr key={l.categoryId}>
                      <td className="px-2 py-1.5">
                        {l.name}{' '}
                        {l.fixed && <span className="chip chip-muted ml-1">{t('budget.fixed')}</span>}
                        {l.source === 'recurring' && (
                          <span className="chip chip-muted ml-1">{t('budget.recurring')}</span>
                        )}
                      </td>
                      <td className="px-2 py-1.5 text-right">
                        <Money amount={l.suggested} currency={draft.currency} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <button
              type="button"
              className="btn-primary"
              disabled={busy || !name.trim()}
              onClick={() => void create(true)}
            >
              {t('budget.create_with_draft')}
            </button>
          </>
        )}
      </section>
    </div>
  );
}
