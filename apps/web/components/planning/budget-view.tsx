'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { ArrowRightLeft, ChevronLeft, ChevronRight, Copy } from 'lucide-react';
import type { BudgetPeriodDto } from '@montra/api-client';
import { browserApi } from '@/lib/browser-api';
import { minorToInput, parseAmountInput } from '@/lib/money';
import { drillHref, percentOf, shiftDays, shiftMonth } from '@/lib/planning';
import { ProgressBar } from '../charts/line-chart';
import { DateText, useI18n } from '../i18n';
import { Money } from '../money';
import { StatusLine, useAction } from '../use-action';

type Line = BudgetPeriodDto['groups'][number]['lines'][number];
const ROLLOVERS = ['carry_surplus', 'carry_deficit', 'carry_both', 'reset'] as const;

/**
 * One budget period (BUD-01..10, FLOW-04): left to assign at the top, then each category group with assigned
 * (editable), activity (drills to the transactions), available and pace. Every write sends the budget version
 * and shows the recomputed period the server returns.
 */
export function BudgetView({ initial, workspaceId }: { initial: BudgetPeriodDto; workspaceId: string }) {
  const router = useRouter();
  const { t, locale, money } = useI18n();
  const { run, busy, message, setMessage } = useAction();
  const [p, setP] = useState(initial);
  const [moving, setMoving] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  // Lines with nothing assigned, carried, spent or planned stay out of the way until asked for.
  const used = (l: Line) =>
    BigInt(l.assigned) !== 0n ||
    BigInt(l.activity) !== 0n ||
    BigInt(l.available) !== 0n ||
    BigInt(l.carriedIn) !== 0n ||
    l.goal !== null;
  if (p.start !== initial.start || p.budget.version < initial.budget.version) setP(initial);

  const base = `/w/${workspaceId}`;
  const search = useSearchParams();
  const periodHref = (start: string | null) => {
    const q = new URLSearchParams(search?.toString() ?? '');
    if (start) q.set('start', start);
    else q.delete('start');
    const s = q.toString();
    return s ? `?${s}` : '?';
  };
  const ccy = p.budget.currency;
  const b = p.budget;
  const step = (n: number) =>
    b.periodType === 'monthly'
      ? shiftMonth(p.start, n)
      : shiftDays(p.start, n * (b.periodType === 'weekly' ? 7 : 14));
  const lta = BigInt(p.leftToAssign);
  const allLines = p.groups.flatMap((g) => g.lines);

  async function write(fn: (version: number) => Promise<BudgetPeriodDto>, ok?: string) {
    const res = await run(() => fn(p.budget.version), ok);
    if (res) setP(res);
  }

  function assign(line: Line, raw: string) {
    const parsed = parseAmountInput(raw || '0', ccy, locale);
    if (!parsed.ok || parsed.minor < 0n) {
      setMessage({ tone: 'bad', text: t('budget.amount_invalid') });
      return;
    }
    if (parsed.minor === BigInt(line.assigned)) return;
    void write((version) =>
      browserApi.assignBudget(workspaceId, b.id, p.start, line.categoryId, {
        assigned: String(parsed.minor),
        version,
      }),
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-1">
          <Link href={periodHref(step(-1))} className="icon-btn" aria-label={t('budget.previous')}>
            <ChevronLeft aria-hidden size={18} />
          </Link>
          <h2 className="min-w-48 text-center text-lg font-semibold">
            <DateText date={p.start} /> – <DateText date={p.end} />
          </h2>
          <Link href={periodHref(step(1))} className="icon-btn" aria-label={t('budget.next')}>
            <ChevronRight aria-hidden size={18} />
          </Link>
          {!p.current && (
            <Link href={periodHref(null)} className="btn-ghost text-xs">
              {t('budget.today')}
            </Link>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          {(['last', 'avg3'] as const).map((from) => (
            <button
              key={from}
              type="button"
              className="btn-secondary"
              disabled={busy}
              onClick={() =>
                void write(
                  (version) => browserApi.copyBudget(workspaceId, b.id, p.start, { from, version }),
                  t('budget.copied'),
                )
              }
            >
              <Copy aria-hidden size={15} />
              {t(from === 'last' ? 'budget.copy_last' : 'budget.copy_avg3')}
            </button>
          ))}
        </div>
      </div>

      <section aria-label={t('budget.summary')} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="card">
          <div className="text-xs font-semibold text-muted">{t('budget.income')}</div>
          <div className="mt-1 font-display text-2xl font-semibold">
            <Money amount={p.income.budgeted} currency={ccy} />
          </div>
          <div className="mt-0.5 text-xs text-muted">
            {t('budget.income_detail', {
              expected: money(p.income.expected, ccy),
              actual: money(p.income.actual, ccy),
            })}
          </div>
        </div>
        <div className="card">
          <div className="text-xs font-semibold text-muted">{t('budget.assigned')}</div>
          <div className="mt-1 font-display text-2xl font-semibold">
            <Money amount={p.assigned} currency={ccy} />
          </div>
          <div className="mt-0.5 text-xs text-muted">
            {t('budget.carried_unassigned')} <Money amount={p.carriedUnassigned} currency={ccy} />
          </div>
        </div>
        <div className="card">
          <div className="text-xs font-semibold text-muted">{t('budget.spent')}</div>
          <div className="mt-1 font-display text-2xl font-semibold">
            <Money amount={p.activity} currency={ccy} />
          </div>
          <div className="mt-0.5 text-xs text-muted">
            {t('budget.available')} <Money amount={p.available} currency={ccy} />
          </div>
        </div>
        {b.method === 'category_limits' ? (
          <div className="card">
            <div className="text-xs font-semibold text-muted">{t('budget.available')}</div>
            <div className="mt-1 font-display text-2xl font-semibold">
              <Money amount={p.available} currency={ccy} signed />
            </div>
          </div>
        ) : (
          <div
            className={`card ${lta < 0n ? 'border-bad/50 bg-bad/5' : lta > 0n ? 'border-brand-600/40 bg-brand-50' : ''}`}
          >
            <div className="text-xs font-semibold text-muted">{t('budget.lta_label')}</div>
            <div
              className={`mt-1 font-display text-2xl font-semibold ${lta < 0n ? 'text-bad' : lta > 0n ? 'text-brand-600' : ''}`}
              data-testid="left-to-assign"
            >
              <Money amount={p.leftToAssign} currency={ccy} />
            </div>
            <div className="mt-0.5 text-xs text-muted">
              {lta < 0n
                ? t('budget.over_assigned_hint')
                : lta === 0n
                  ? t('budget.every_dollar')
                  : t('budget.ready_to_assign')}
            </div>
          </div>
        )}
      </section>

      {p.light && (
        <section className="card grid gap-4 sm:grid-cols-2" aria-label={t('budget.light')}>
          <div>
            <div className="section-h">{t('budget.light_savings')}</div>
            <div className="mt-1 text-lg font-semibold">
              <Money amount={p.light.saved} currency={ccy} /> /{' '}
              <Money amount={p.light.savingsTarget} currency={ccy} />
            </div>
            <ProgressBar
              label={t('budget.light_savings')}
              percent={percentOf(BigInt(p.light.saved), BigInt(p.light.savingsTarget))}
              tone="good"
            />
          </div>
          <div>
            <div className="section-h">{t('budget.light_everything')}</div>
            <div className="mt-1 text-lg font-semibold">
              <Money amount={p.light.everythingElse.activity} currency={ccy} /> /{' '}
              <Money amount={p.light.everythingElse.budget} currency={ccy} />
            </div>
            <ProgressBar
              label={t('budget.light_everything')}
              percent={percentOf(
                BigInt(p.light.everythingElse.activity),
                BigInt(p.light.everythingElse.budget),
              )}
              tone={BigInt(p.light.everythingElse.available) < 0n ? 'bad' : 'brand'}
            />
          </div>
        </section>
      )}

      <StatusLine message={message} />

      <div className="flex justify-end">
        <label className="flex items-center gap-2 text-sm text-muted">
          <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} />
          {t('budget.show_all')}
        </label>
      </div>

      {p.groups
        .map((g) => ({ ...g, lines: g.lines.filter((l) => showAll || used(l) || l.categoryId === moving) }))
        .filter((g) => g.lines.length > 0)
        .map((g) => (
          <section key={g.id} className="card-flush" aria-labelledby={`group-${g.id}`}>
            <div className="flex items-center justify-between border-b border-line bg-canvas px-4 py-2">
              <h3 id={`group-${g.id}`} className="text-sm font-bold">
                {g.name}
              </h3>
              <div className="flex gap-6 text-xs text-muted">
                <span>
                  {t('budget.assigned')} <Money amount={g.assigned} currency={ccy} />
                </span>
                <span>
                  {t('budget.available')} <Money amount={g.available} currency={ccy} />
                </span>
              </div>
            </div>
            <div className="overflow-x-auto">
              <table className="tbl min-w-[44rem]">
                <thead>
                  <tr>
                    <th scope="col" className="px-4 py-2">
                      {t('budget.category')}
                    </th>
                    <th scope="col" className="w-36 px-2 py-2 text-right">
                      {t('budget.assigned')}
                    </th>
                    <th scope="col" className="w-32 px-2 py-2 text-right">
                      {t('budget.activity')}
                    </th>
                    <th scope="col" className="w-32 px-2 py-2 text-right">
                      {t('budget.available')}
                    </th>
                    <th scope="col" className="w-44 px-4 py-2">
                      {t('budget.pace')}
                    </th>
                    <th scope="col" className="w-12 px-2 py-2">
                      <span className="sr-only">{t('budget.actions')}</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {g.lines.map((l) => {
                    const available = BigInt(l.available);
                    const total = available + BigInt(l.activity);
                    return (
                      <tr key={l.categoryId}>
                        <th scope="row" className="px-4 py-2 text-left font-medium">
                          {l.name}
                          {l.goal && (
                            <span className="block text-xs font-normal text-muted">
                              {t('budget.goal_needs')} <Money amount={l.goal.monthlyNeeded} currency={ccy} />
                            </span>
                          )}
                          {BigInt(l.carriedIn) !== 0n && (
                            <span className="block text-xs font-normal text-muted">
                              {t('budget.carried_in')} <Money amount={l.carriedIn} currency={ccy} />
                            </span>
                          )}
                        </th>
                        <td className="px-2 py-1.5 text-right">
                          <input
                            key={`${l.categoryId}-${l.assigned}`}
                            className="input num text-right"
                            defaultValue={
                              BigInt(l.assigned) === 0n ? '' : minorToInput(BigInt(l.assigned), ccy)
                            }
                            placeholder="0"
                            inputMode="decimal"
                            aria-label={t('budget.assigned_for', { name: l.name })}
                            disabled={busy}
                            onBlur={(e) => assign(l, e.currentTarget.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') e.currentTarget.blur();
                            }}
                          />
                        </td>
                        <td className="px-2 py-2 text-right">
                          <Link
                            href={drillHref(base, {
                              entityId: b.entityId,
                              ...(b.memberId ? { memberId: b.memberId } : {}),
                              categoryIds: [l.categoryId],
                              from: p.start,
                              to: p.end,
                            })}
                            className="hover:underline"
                          >
                            <Money amount={l.activity} currency={ccy} />
                          </Link>
                        </td>
                        <td className="px-2 py-2 text-right">
                          <span
                            className={`chip ${available < 0n ? 'chip-bad' : available > 0n ? 'chip-good' : 'chip-muted'}`}
                          >
                            <Money amount={l.available} currency={ccy} />
                          </span>
                        </td>
                        <td className="px-4 py-2">
                          {total > 0n ? (
                            <ProgressBar
                              label={t('budget.pace_for', { name: l.name })}
                              percent={percentOf(BigInt(l.activity), total)}
                              marker={l.pace ? percentOf(BigInt(l.pace.expectedByToday), total) : null}
                              tone={l.pace?.status === 'over' || available < 0n ? 'bad' : 'brand'}
                            />
                          ) : (
                            <span className="text-xs text-muted">—</span>
                          )}
                          {l.pace?.status === 'over' && (
                            <span className="mt-0.5 block text-xs text-bad">{t('budget.over_pace')}</span>
                          )}
                        </td>
                        <td className="px-2 py-2">
                          <button
                            type="button"
                            className="icon-btn size-8"
                            aria-label={t('budget.move_from', { name: l.name })}
                            aria-expanded={moving === l.categoryId}
                            onClick={() => setMoving(moving === l.categoryId ? null : l.categoryId)}
                          >
                            <ArrowRightLeft aria-hidden size={15} />
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {g.lines.some((l) => l.categoryId === moving) && (
              <MoveForm
                line={g.lines.find((l) => l.categoryId === moving)!}
                lines={allLines}
                currency={ccy}
                busy={busy}
                onCancel={() => setMoving(null)}
                onMove={(input) =>
                  void write(
                    (version) => browserApi.moveBudget(workspaceId, b.id, p.start, { ...input, version }),
                    t('budget.moved'),
                  ).then(() => setMoving(null))
                }
                onRollover={(rolloverMode) =>
                  void write((version) =>
                    browserApi.assignBudget(workspaceId, b.id, p.start, moving!, {
                      assigned: g.lines.find((l) => l.categoryId === moving)!.assigned,
                      rolloverMode,
                      version,
                    }),
                  )
                }
              />
            )}
          </section>
        ))}

      {p.unbudgeted.length > 0 && (
        <section className="card" aria-label={t('budget.unbudgeted')}>
          <h3 className="section-h mb-2">{t('budget.unbudgeted')}</h3>
          <ul className="divide-y divide-line text-sm">
            {p.unbudgeted.map((u) => (
              <li key={u.categoryId} className="flex justify-between py-1.5">
                <Link
                  href={drillHref(base, {
                    entityId: b.entityId,
                    categoryIds: [u.categoryId],
                    from: p.start,
                    to: p.end,
                  })}
                  className="hover:underline"
                >
                  {u.name}
                </Link>
                <Money amount={u.activity} currency={ccy} />
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="card" aria-label={t('budget.split')}>
        <h3 className="section-h mb-3">{t('budget.split')}</h3>
        <div className="grid gap-4 sm:grid-cols-3">
          {(['needs', 'wants', 'savings'] as const).map((k) => (
            <div key={k}>
              <div className="flex justify-between text-sm">
                <span className="font-semibold">{t(`budget.split_${k}`)}</span>
                <span className="num text-muted">
                  {p.fiftyThirtyTwenty[k].percent}% / {k === 'needs' ? 50 : k === 'wants' ? 30 : 20}%
                </span>
              </div>
              <ProgressBar
                label={t(`budget.split_${k}`)}
                percent={p.fiftyThirtyTwenty[k].percent}
                marker={k === 'needs' ? 50 : k === 'wants' ? 30 : 20}
                tone={k === 'savings' ? 'good' : 'brand'}
              />
              <div className="mt-1 text-xs text-muted">
                <Money amount={p.fiftyThirtyTwenty[k].amount} currency={ccy} />
              </div>
            </div>
          ))}
        </div>
      </section>
      <p className="text-xs text-muted">
        <button type="button" className="underline" onClick={() => router.refresh()}>
          {t('budget.refresh')}
        </button>
      </p>
    </div>
  );
}

function MoveForm({
  line,
  lines,
  currency,
  busy,
  onCancel,
  onMove,
  onRollover,
}: {
  line: Line;
  lines: Line[];
  currency: string;
  busy: boolean;
  onCancel: () => void;
  onMove: (input: { from: string | null; to: string | null; amount: string; note?: string }) => void;
  onRollover: (mode: (typeof ROLLOVERS)[number]) => void;
}) {
  const { t, locale } = useI18n();
  const [direction, setDirection] = useState<'out' | 'in'>(BigInt(line.available) < 0n ? 'in' : 'out');
  const [other, setOther] = useState<string>('');
  const [amount, setAmount] = useState(
    BigInt(line.available) < 0n ? minorToInput(-BigInt(line.available), currency) : '',
  );
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className="grid gap-3 border-t border-line bg-brand-50/50 px-4 py-3 sm:grid-cols-[auto_1fr_10rem_1fr_auto]"
      onSubmit={(e) => {
        e.preventDefault();
        const parsed = parseAmountInput(amount, currency, locale);
        if (!parsed.ok || parsed.minor <= 0n) {
          setError(t('budget.amount_invalid'));
          return;
        }
        const otherId = other === '' ? null : other;
        onMove({
          from: direction === 'out' ? line.categoryId : otherId,
          to: direction === 'out' ? otherId : line.categoryId,
          amount: String(parsed.minor),
          ...(note ? { note } : {}),
        });
      }}
      aria-label={t('budget.move_from', { name: line.name })}
    >
      <div
        className="segmented segmented-md self-end"
        role="radiogroup"
        aria-label={t('budget.move_direction')}
      >
        {(['out', 'in'] as const).map((d) => (
          <button
            key={d}
            type="button"
            role="radio"
            aria-checked={direction === d}
            onClick={() => setDirection(d)}
          >
            {t(d === 'out' ? 'budget.move_out' : 'budget.move_in')}
          </button>
        ))}
      </div>
      <label>
        <span className="field-label">
          {direction === 'out' ? t('budget.move_to') : t('budget.move_from_label')}
        </span>
        <select className="input" value={other} onChange={(e) => setOther(e.target.value)}>
          <option value="">{t('budget.lta_label')}</option>
          {lines
            .filter((l) => l.categoryId !== line.categoryId)
            .map((l) => (
              <option key={l.categoryId} value={l.categoryId}>
                {l.name}
              </option>
            ))}
        </select>
      </label>
      <label>
        <span className="field-label">{t('budget.amount')}</span>
        <input
          className="input num text-right"
          inputMode="decimal"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          aria-invalid={error ? true : undefined}
        />
      </label>
      <label>
        <span className="field-label">{t('budget.note')}</span>
        <input className="input" value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />
      </label>
      <div className="flex items-end gap-2">
        <button type="submit" className="btn-primary" disabled={busy}>
          {t('budget.move')}
        </button>
        <button type="button" className="btn-ghost" onClick={onCancel}>
          {t('common.cancel')}
        </button>
      </div>
      {error && <p className="field-error sm:col-span-5">{error}</p>}
      <label className="flex items-center gap-2 text-sm sm:col-span-5">
        <span className="text-muted">{t('budget.rollover')}</span>
        <select
          className="input w-auto"
          value={line.rolloverMode}
          onChange={(e) => onRollover(e.target.value as (typeof ROLLOVERS)[number])}
          disabled={busy}
        >
          {ROLLOVERS.map((r) => (
            <option key={r} value={r}>
              {t(`budget.rollover_${r}`)}
            </option>
          ))}
        </select>
      </label>
    </form>
  );
}
