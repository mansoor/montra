'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { categoryStats, parseMoney, whatIf, type WhatIfChange } from '@montra/domain';
import { CHART_MONTHS, EXPLORE_MAX_CATEGORIES, type SpendingExploreDto } from '@montra/schemas';
import { drillHref } from '@/lib/planning';
import { LineChart } from '@/components/charts/line-chart';
import { useI18n } from '../i18n';

const RANGES: Record<(typeof CHART_MONTHS)[number], { label: string }> = {
  3: { label: 'home.charts.range_3' },
  6: { label: 'home.charts.range_6' },
  12: { label: 'home.charts.range_12' },
  24: { label: 'home.charts.range_24' },
};
const CUTS = [10, 20, 30, 50];

type Plan = { kind: 'none' } | { kind: 'cut'; percent: number } | { kind: 'cap'; amount: string };

/**
 * Explore spending (FLOW-01): the categories picked, month by month, as a chart and a table, what each says, and
 * what-ifs worked out here from the same numbers (nothing is saved).
 */
export function ExploreView({
  base,
  data: d,
  goals,
}: {
  base: string;
  data: SpendingExploreDto;
  /** Goals with a target: what's left to save. */
  goals: Array<{ id: string; name: string; remaining: string }>;
}) {
  const { t, money, locale } = useI18n();
  const router = useRouter();
  const ccy = d.currency;
  const ids = d.categories.map((c) => c.categoryId);
  const monthName = useMemo(
    () => new Intl.DateTimeFormat(locale, { month: 'short', year: 'numeric', timeZone: 'UTC' }),
    [locale],
  );
  const label = (start: string) => monthName.format(new Date(`${start}T00:00:00Z`));
  const href = (next: { months?: number; c?: string[] }) => {
    const q = new URLSearchParams({ months: String(next.months ?? d.months) });
    const c = next.c ?? ids;
    if (c.length) q.set('c', c.join(','));
    if (d.memberId) q.set('memberId', d.memberId);
    return `${base}/explore?${q}`;
  };
  const big = (s: string) => BigInt(s);
  const stats = d.categories.map((c) => categoryStats(c.monthly.map(big), c.counts, d.spending.map(big)));

  const [plans, setPlans] = useState<Record<string, Plan>>({});
  const changes = d.categories.flatMap((c): WhatIfChange[] => {
    const p = plans[c.categoryId];
    if (!p || p.kind === 'none') return [];
    if (p.kind === 'cut') return [{ categoryId: c.categoryId, cutPercent: p.percent }];
    try {
      return [{ categoryId: c.categoryId, capMinor: parseMoney(p.amount.replace(',', '.'), ccy).amount }];
    } catch {
      return [];
    }
  });
  const result = whatIf({
    income: d.income.map(big),
    spending: d.spending.map(big),
    categories: d.categories.map((c) => ({ categoryId: c.categoryId, monthly: c.monthly.map(big) })),
    changes,
    goals: goals.map((g) => ({ ...g, remaining: big(g.remaining) })),
  });
  const unpicked = d.choices.filter((c) => !ids.includes(c.categoryId));
  const monthDrill = (categoryId: string, i: number) =>
    drillHref(base, {
      entityId: d.entityId,
      ...(d.memberId ? { memberId: d.memberId } : {}),
      categoryIds: [categoryId],
      from: d.periods[i]!.start,
      to: d.periods[i]!.end,
    });

  return (
    <div className="space-y-6">
      <section aria-label={t('explore.pick')} className="card space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          {d.categories.map((c) => (
            <span key={c.categoryId} className="chip inline-flex items-center gap-1">
              {c.name}
              {ids.length > 1 && (
                <Link
                  href={href({ c: ids.filter((x) => x !== c.categoryId) })}
                  aria-label={t('explore.remove', { name: c.name })}
                  className="text-muted hover:text-ink"
                >
                  ×
                </Link>
              )}
            </span>
          ))}
          {ids.length < EXPLORE_MAX_CATEGORIES && unpicked.length > 0 && (
            <select
              className="input w-auto"
              aria-label={t('explore.add')}
              value=""
              onChange={(e) => e.target.value && router.push(href({ c: [...ids, e.target.value] }))}
              data-testid="explore-add"
            >
              <option value="">{t('explore.add')}</option>
              {unpicked.map((c) => (
                <option key={c.categoryId} value={c.categoryId}>
                  {c.name}
                  {c.group ? ` · ${c.group}` : ''} ({money(big(c.total), ccy)})
                </option>
              ))}
            </select>
          )}
          <nav aria-label={t('home.charts.range')} className="segmented ml-auto">
            {CHART_MONTHS.map((n) => (
              <Link key={n} href={href({ months: n })} aria-current={n === d.months ? 'page' : undefined}>
                {t(RANGES[n].label)}
              </Link>
            ))}
          </nav>
        </div>
        {d.categories.length === 0 ? (
          <p className="text-sm text-muted">{t('explore.nothing')}</p>
        ) : (
          <>
            {/* Narrow screens get the compact drawing, whose labels stay readable. */}
            <div className="md:hidden">
              <LineChart
                compact
                months
                title={t('explore.chart')}
                series={d.categories.map((c) => ({ label: c.name, values: c.monthly }))}
                labels={d.periods.map((p) => p.start)}
                currency={ccy}
              />
            </div>
            <div className="hidden md:block">
              <LineChart
                months
                title={t('explore.chart')}
                series={d.categories.map((c) => ({ label: c.name, values: c.monthly }))}
                labels={d.periods.map((p) => p.start)}
                currency={ccy}
              />
            </div>
          </>
        )}
        <p className="text-xs text-muted">{t('home.charts.current_month_note')}</p>
      </section>

      {d.categories.length > 0 && (
        <section aria-labelledby="explore-table" className="card-flush overflow-x-auto">
          <h2 id="explore-table" className="px-4 pt-3 font-semibold">
            {t('explore.by_month')}
          </h2>
          <table className="tbl" data-testid="explore-table">
            <thead>
              <tr>
                <th scope="col" className="px-4 py-2">
                  {t('explore.month')}
                </th>
                {d.categories.map((c) => (
                  <th key={c.categoryId} scope="col" className="px-4 py-2 text-right">
                    {c.name}
                  </th>
                ))}
                <th scope="col" className="px-4 py-2 text-right">
                  {t('explore.all_spending')}
                </th>
              </tr>
            </thead>
            <tbody>
              {[...d.periods.keys()].reverse().map((i) => (
                <tr key={d.periods[i]!.start}>
                  <th scope="row" className="whitespace-nowrap px-4 py-1.5 text-left font-normal">
                    {label(d.periods[i]!.start)}
                  </th>
                  {d.categories.map((c) => (
                    <td key={c.categoryId} className="num px-4 py-1.5 text-right">
                      <Link href={monthDrill(c.categoryId, i)} className="hover:underline">
                        {money(big(c.monthly[i]!), ccy)}
                      </Link>
                    </td>
                  ))}
                  <td className="num px-4 py-1.5 text-right text-muted">{money(big(d.spending[i]!), ccy)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <th scope="row" className="px-4 py-1.5 text-left">
                  {t('explore.average')}
                </th>
                {stats.map((s, i) => (
                  <td key={ids[i]} className="num px-4 py-1.5 text-right font-medium">
                    {money(s.average, ccy)}
                  </td>
                ))}
                <td />
              </tr>
              <tr>
                <th scope="row" className="px-4 py-1.5 text-left">
                  {t('explore.total')}
                </th>
                {stats.map((s, i) => (
                  <td key={ids[i]} className="num px-4 py-1.5 text-right">
                    <Link href={drillHref(base, d.categories[i]!.drill)} className="hover:underline">
                      {money(s.total, ccy)}
                    </Link>
                  </td>
                ))}
                <td />
              </tr>
            </tfoot>
          </table>
        </section>
      )}

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {d.categories.map((c, i) => {
          const s = stats[i]!;
          return (
            <section
              key={c.categoryId}
              aria-label={c.name}
              className="card space-y-2 text-sm"
              data-testid="explore-card"
            >
              <h2 className="text-base font-semibold">
                {c.name}
                {c.group && <span className="ml-1 text-xs font-normal text-muted">· {c.group}</span>}
              </h2>
              <p>
                {s.changePercent === null
                  ? t('explore.steady_unknown', { average: money(s.average, ccy) })
                  : t(
                      s.changePercent > 0
                        ? 'explore.up'
                        : s.changePercent < 0
                          ? 'explore.down'
                          : 'explore.flat',
                      {
                        percent: Math.abs(s.changePercent),
                        recent: money(s.recent, ccy),
                      },
                    )}
              </p>
              <ul className="space-y-0.5 text-muted">
                <li>{t('explore.average_line', { amount: money(s.average, ccy) })}</li>
                <li>{t('explore.share', { percent: s.share })}</li>
                <li>
                  {t('explore.purchases', { count: s.purchasesPerMonth })}
                  {s.typical !== null && ` ${t('explore.typical', { amount: money(s.typical, ccy) })}`}
                </li>
                {s.highest && (
                  <li>
                    {t('explore.highest', {
                      month: label(d.periods[s.highest.index]!.start),
                      amount: money(s.highest.amount, ccy),
                    })}
                  </li>
                )}
                <li>{t('explore.pace', { amount: money(s.recent * 12n, ccy) })}</li>
              </ul>
              {c.topPlaces.length > 0 && (
                <div>
                  <h3 className="text-xs font-semibold uppercase text-muted">{t('explore.top_places')}</h3>
                  <ul>
                    {c.topPlaces.map((p) => (
                      <li key={p.name} className="flex justify-between gap-2">
                        <span className="truncate">{p.name}</span>
                        <span className="num shrink-0">
                          {money(big(p.amount), ccy)} <span className="text-xs text-muted">×{p.count}</span>
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </section>
          );
        })}
      </div>

      {d.categories.length > 0 && (
        <section aria-labelledby="whatif-heading" className="card space-y-3" data-testid="explore-whatif">
          <div>
            <h2 id="whatif-heading" className="font-semibold">
              {t('explore.whatif')}
            </h2>
            <p className="text-xs text-muted">{t('explore.whatif_hint')}</p>
          </div>
          <ul className="space-y-2">
            {d.categories.map((c) => {
              const p = plans[c.categoryId] ?? { kind: 'none' };
              const saved = result.perCategory.find((x) => x.categoryId === c.categoryId)?.monthly;
              return (
                <li key={c.categoryId} className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="w-40 truncate font-medium">{c.name}</span>
                  <select
                    className="input w-auto"
                    aria-label={t('explore.change_for', { name: c.name })}
                    value={p.kind === 'cut' ? `cut-${p.percent}` : p.kind}
                    onChange={(e) => {
                      const v = e.target.value;
                      setPlans((all) => ({
                        ...all,
                        [c.categoryId]: v.startsWith('cut-')
                          ? { kind: 'cut', percent: Number(v.slice(4)) }
                          : v === 'cap'
                            ? { kind: 'cap', amount: '' }
                            : { kind: 'none' },
                      }));
                    }}
                  >
                    <option value="none">{t('explore.no_change')}</option>
                    {CUTS.map((n) => (
                      <option key={n} value={`cut-${n}`}>
                        {t('explore.cut', { percent: n })}
                      </option>
                    ))}
                    <option value="cap">{t('explore.cap')}</option>
                  </select>
                  {p.kind === 'cap' && (
                    <label className="flex items-center gap-1">
                      <input
                        className="input num w-24"
                        inputMode="decimal"
                        aria-label={t('explore.cap_amount', { name: c.name })}
                        value={p.amount}
                        onChange={(e) =>
                          setPlans((all) => ({
                            ...all,
                            [c.categoryId]: { kind: 'cap', amount: e.target.value },
                          }))
                        }
                      />
                      <span className="text-muted">{t('explore.per_month')}</span>
                    </label>
                  )}
                  {saved !== undefined && saved > 0n && (
                    <span className="text-good">{t('explore.saves', { amount: money(saved, ccy) })}</span>
                  )}
                </li>
              );
            })}
          </ul>
          {result.monthly > 0n ? (
            <div className="rounded-lg bg-sunken p-3 text-sm" aria-live="polite">
              <p className="font-medium">
                {t('explore.result', {
                  monthly: money(result.monthly, ccy),
                  yearly: money(result.yearly, ccy),
                })}
              </p>
              {result.keptBefore !== null && result.keptAfter !== null && (
                <p>{t('explore.result_kept', { before: result.keptBefore, after: result.keptAfter })}</p>
              )}
              {result.goals.length > 0 && (
                <ul className="mt-1 space-y-0.5">
                  {result.goals.map((g) => (
                    <li key={g.id}>
                      {g.monthsAfter === null
                        ? t('explore.goal_never', { name: g.name })
                        : g.monthsBefore === null
                          ? t('explore.goal_now', { name: g.name, after: g.monthsAfter })
                          : t('explore.goal', { name: g.name, before: g.monthsBefore, after: g.monthsAfter })}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ) : (
            <p className="text-sm text-muted">{t('explore.whatif_empty')}</p>
          )}
        </section>
      )}
    </div>
  );
}
