import Link from 'next/link';
import { load } from '@/lib/server-api';
import { getI18n } from '@/lib/i18n-server';
import { Money } from '@/components/money';
import { PageHeader, StatTile } from '@/components/ui/page-header';
import { MonthPicker, MonthSuggestions } from '@/components/month/month-review';

export const dynamic = 'force-dynamic';

/**
 * Month in review (FLOW-01, AIA-01): one month's money in and out against usual, what changed, the biggest purchases,
 * the budget and next month's suggestions. The figures are computed; the AI (or plain sentences) only words them.
 */
export default async function MonthPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<{ month?: string; memberId?: string }>;
}) {
  const { workspaceId } = await params;
  const sp = await searchParams;
  const month = sp.month && /^\d{4}-\d{2}-\d{2}$/.test(sp.month) ? sp.month : undefined;
  const [d, { t, locale, money }] = await Promise.all([
    load((api) =>
      api.getMonthSummary(workspaceId, {
        ...(month ? { month } : {}),
        ...(sp.memberId ? { memberId: sp.memberId } : {}),
      }),
    ),
    getI18n(),
  ]);
  const base = `/w/${workspaceId}`;
  const ccy = d.currency;
  const label = (start: string) =>
    new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(
      new Date(`${start}T00:00:00Z`),
    );
  // The month dropdown: this month and the eleven before (plus the one shown, if it's older).
  const today = new Date();
  const months = Array.from({ length: 12 }, (_, i) => {
    const start = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - i, 1))
      .toISOString()
      .slice(0, 10);
    return { start, label: label(start) };
  });
  if (!months.some((m) => m.start === d.month.start))
    months.push({ start: d.month.start, label: label(d.month.start) });

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('month.title', { month: label(d.month.start) })}
        subtitle={d.complete ? t('month.subtitle') : t('month.subtitle_so_far')}
        actions={
          <MonthPicker
            base={`${base}/month`}
            value={d.month.start}
            months={months}
            memberId={d.memberId}
            label={t('month.pick')}
          />
        }
      />

      <section aria-labelledby="story-heading" className="card space-y-2" data-testid="month-story">
        <h2 id="story-heading" className="font-display text-xl font-semibold">
          {d.story.headline}
        </h2>
        <ul className="list-disc space-y-1 pl-5 text-sm">
          {d.story.points.map((p, i) => (
            <li key={i}>{p}</li>
          ))}
        </ul>
        <p className="text-xs text-muted">{d.story.by === 'ai' ? t('month.by_ai') : t('month.by_plain')}</p>
        {d.needsReview > 0 && (
          <p className="text-sm text-warn">
            {t('month.needs_review', { count: d.needsReview })}{' '}
            <Link href={`${base}/review`} className="underline">
              {t('month.open_review')}
            </Link>
          </p>
        )}
      </section>

      <section aria-label={t('month.figures')} className="grid gap-3 sm:grid-cols-3">
        <StatTile
          label={t('month.money_in')}
          value={<Money amount={d.income} currency={ccy} />}
          hint={d.usual ? t('month.usual_hint', { amount: money(d.usual.income, ccy) }) : undefined}
        />
        <StatTile
          label={t('month.money_out')}
          value={<Money amount={d.spent} currency={ccy} />}
          hint={d.usual ? t('month.usual_hint', { amount: money(d.usual.spent, ccy) }) : undefined}
        />
        <StatTile
          label={t('month.left_over')}
          value={<Money amount={d.left} currency={ccy} />}
          tone={BigInt(d.left) < 0n ? 'bad' : undefined}
          hint={d.keptPercent !== null ? t('month.kept', { percent: d.keptPercent }) : undefined}
        />
      </section>

      <div className="grid gap-6 lg:grid-cols-2">
        <section aria-labelledby="changes-heading" className="card space-y-3">
          <h2 id="changes-heading" className="font-semibold">
            {t('month.changes')}
          </h2>
          {d.changes.up.length + d.changes.down.length === 0 ? (
            <p className="text-sm text-muted">{d.usual ? t('month.no_changes') : t('month.no_usual')}</p>
          ) : (
            <ul className="divide-y divide-line text-sm">
              {[...d.changes.up, ...d.changes.down].map((c) => (
                <li key={c.categoryId} className="flex items-center justify-between gap-2 py-1.5">
                  <span>
                    {c.name}
                    <span className="block text-xs text-muted">
                      <Money amount={c.spent} currency={ccy} /> · {t('month.usually')}{' '}
                      <Money amount={c.usual} currency={ccy} />
                    </span>
                  </span>
                  <span className={c.change.startsWith('-') ? 'text-good' : 'text-bad'}>
                    <Money amount={c.change} currency={ccy} signed />
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section aria-labelledby="where-heading" className="card space-y-3">
          <h2 id="where-heading" className="font-semibold">
            {t('month.where')}
          </h2>
          {d.categories.length === 0 ? (
            <p className="text-sm text-muted">{t('month.nothing_spent')}</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-muted">
                  <th className="py-1 font-normal">{t('month.category')}</th>
                  <th className="py-1 text-right font-normal">{t('month.this_month')}</th>
                  <th className="py-1 text-right font-normal">{t('month.usually')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {d.categories.map((c) => (
                  <tr key={c.categoryId}>
                    <td className="py-1.5">{c.name}</td>
                    <td className="num py-1.5 text-right">
                      <Money amount={c.spent} currency={ccy} />
                    </td>
                    <td className="num py-1.5 text-right text-muted">
                      {c.usual === null ? '—' : <Money amount={c.usual} currency={ccy} />}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {d.largest.length > 0 && (
            <div>
              <h3 className="mb-1 text-sm font-medium">{t('month.largest')}</h3>
              <ul className="space-y-1 text-sm">
                {d.largest.map((l) => (
                  <li key={l.transactionId} className="flex justify-between gap-2">
                    <Link
                      href={`${base}/transactions/${l.transactionId}`}
                      className="truncate hover:underline"
                    >
                      {l.payee || l.categoryName}
                      <span className="text-xs text-muted"> · {l.categoryName}</span>
                    </Link>
                    <Money amount={l.amount} currency={ccy} />
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>
      </div>

      {d.budget && (
        <section aria-labelledby="budget-heading" className="card space-y-2">
          <div className="flex items-baseline justify-between">
            <h2 id="budget-heading" className="font-semibold">
              {t('month.budget')}
            </h2>
            <Link href={`${base}/budget`} className="text-sm font-medium text-brand-600 underline">
              {t('month.open_budget')}
            </Link>
          </div>
          <p className="text-sm">
            {t('month.budget_line')} <Money amount={d.budget.spent} currency={ccy} /> /{' '}
            <Money amount={d.budget.assigned} currency={ccy} />
          </p>
          {d.budget.over.length === 0 ? (
            <p className="text-sm text-good">{t('month.budget_none_over')}</p>
          ) : (
            <ul className="space-y-1 text-sm">
              {d.budget.over.map((o) => (
                <li key={o.categoryId}>
                  {t('month.over_by', { name: o.name })}{' '}
                  <span className="text-bad">
                    <Money amount={o.overBy} currency={ccy} />
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {d.suggestions && (
        <MonthSuggestions
          workspaceId={workspaceId}
          base={base}
          entityId={d.entityId}
          memberId={d.memberId}
          currency={ccy}
          period={d.suggestions.period}
          monthLabel={label(d.suggestions.period.start)}
          note={d.story.budgetNote}
          lines={d.suggestions.lines}
        />
      )}
    </div>
  );
}
