'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { sharePercent } from '@montra/domain';
import type { AmortizationRowDto, LoanDto } from '@montra/api-client';
import {
  SCHEDULE_BARS_BY_YEAR_ABOVE,
  SCHEDULE_VIEW_KEY,
  paidSoFar,
  payoffProjection,
  readScheduleView,
  scheduleBars,
  todayIndex,
  type ScheduleView,
} from '@/lib/loan-charts';
import { ProjectedLine } from '../charts/projected-line';
import { StackedColumns, type Column, type ColumnSeries, type TooltipLine } from '../charts/stacked-columns';
import { useI18n } from '../i18n';

/** The same colour for principal and interest everywhere a loan shows them (both themes define every chart token). */
const PRINCIPAL = 'var(--chart-3)';
const INTEREST = 'var(--chart-2)';
const LATE_FEE = 'var(--chart-5)';

/** "Sep 2031", for a payoff date. */
const monthYear = (locale: string, d: string) =>
  new Intl.DateTimeFormat(locale, { month: 'short', year: 'numeric', timeZone: 'UTC' }).format(
    new Date(`${d}T00:00:00Z`),
  );

/**
 * The payment schedule section: the table or a chart of the same rows, with the choice remembered in this browser.
 * Table first, so the page renders the same on the server and before the stored choice is read.
 */
export function ScheduleSection({
  loan,
  rows,
  table,
}: {
  loan: LoanDto;
  rows: readonly AmortizationRowDto[];
  table: ReactNode;
}) {
  const { t } = useI18n();
  const [view, setView] = useState<ScheduleView>('table');
  useEffect(() => {
    try {
      setView(readScheduleView(window.localStorage.getItem(SCHEDULE_VIEW_KEY)));
    } catch {
      // Storage can be off; the table stays.
    }
  }, []);
  const choose = (v: ScheduleView) => {
    setView(v);
    try {
      window.localStorage.setItem(SCHEDULE_VIEW_KEY, v);
    } catch {
      // Not remembered, but still switched.
    }
  };
  return (
    <section className="card space-y-3 p-0" data-testid="loan-schedule">
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 pt-4">
        <h2 className="text-sm font-semibold">{t('account.loan.schedule')}</h2>
        <div role="group" aria-label={t('account.loan.view_as')} className="segmented">
          {(['table', 'chart'] as const).map((v) => (
            <button
              key={v}
              type="button"
              aria-pressed={view === v}
              onClick={() => choose(v)}
              data-testid={`loan-schedule-view-${v}`}
            >
              {t(v === 'table' ? 'account.loan.view_table' : 'account.loan.view_chart')}
            </button>
          ))}
        </div>
      </div>
      {view === 'chart' ? (
        <div className="px-4 pb-4" data-testid="loan-schedule-chart">
          <LoanScheduleChart loan={loan} rows={rows} />
        </div>
      ) : (
        table
      )}
    </section>
  );
}

/** One stacked bar per payment (or per year on a long loan): principal, interest, and a recorded late fee. */
export function LoanScheduleChart({ loan, rows }: { loan: LoanDto; rows: readonly AmortizationRowDto[] }) {
  const { t, money, date } = useI18n();
  const ccy = loan.currency;
  const { byYear, bars } = scheduleBars(rows);
  const withFee = bars.some((b) => b.lateFee > 0n);
  const series: ColumnSeries[] = [
    { label: t('account.loan.principal'), color: PRINCIPAL },
    { label: t('account.loan.interest'), color: INTEREST },
    ...(withFee ? [{ label: t('account.loan.late_fee'), color: LATE_FEE }] : []),
  ];
  const paid = rows.filter((r) => r.transactionId !== null).length;
  let lastYear = '';
  const columns: Column[] = bars.map((b) => {
    const year = b.date.slice(0, 4);
    // On a payment-by-payment chart, a year's first payment carries the year.
    const axisLabel = byYear || year !== lastYear ? year : '';
    lastYear = year;
    const lines: TooltipLine[] = [
      { label: t('account.loan.payment'), value: money(b.payment, ccy) },
      { label: t('account.loan.interest'), value: money(b.interest, ccy), series: 1 },
      { label: t('account.loan.principal'), value: money(b.principal, ccy), series: 0 },
      ...(b.escrow > 0n ? [{ label: t('account.loan.escrow'), value: money(b.escrow, ccy) }] : []),
      ...(b.lateFee > 0n
        ? [{ label: t('account.loan.late_fee'), value: money(b.lateFee, ccy), series: 2 }]
        : []),
      { label: t('account.loan.owed_after'), value: money(b.owedAfter, ccy) },
    ];
    const when =
      b.year !== null ? t('account.loan.chart_year', { year: b.year, count: b.count }) : date(b.date);
    return {
      key: b.key,
      values: withFee ? [b.principal, b.interest, b.lateFee] : [b.principal, b.interest],
      faded: !b.recorded,
      axisLabel,
      title: `${when} · ${t(b.recorded ? 'account.loan.paid' : 'account.loan.to_come')}`,
      lines,
    };
  });
  return (
    <StackedColumns
      series={series}
      columns={columns}
      currency={ccy}
      title={t('account.loan.chart_title', { name: loan.name, paid, left: rows.length - paid })}
      marker={{ index: todayIndex(bars), label: t('account.loan.today') }}
      caption={[
        byYear ? t('account.loan.chart_by_year', { count: SCHEDULE_BARS_BY_YEAR_ABOVE }) : null,
        bars.some((b) => !b.recorded) ? t('account.loan.chart_faded') : null,
      ]
        .filter(Boolean)
        .join(' ')}
    />
  );
}

/**
 * What's owed over time, continued along the schedule to payoff: the history solid, the projection dashed from today's
 * balance, ending at "Paid off Sep 2031".
 */
export function LoanOwedChart({
  loan,
  rows,
  history,
  today,
  name,
}: {
  loan: LoanDto;
  rows: readonly AmortizationRowDto[];
  history: readonly { date: string; balance: string }[];
  today: string;
  name: string;
}) {
  const { t, locale } = useI18n();
  const projection = payoffProjection(loan, rows, today);
  const payoff = projection[projection.length - 1]?.date ?? null;
  const when = payoff ? monthYear(locale, payoff) : null;
  return (
    <div className="w-full" data-testid="loan-owed-chart">
      <ProjectedLine
        actual={history.map((p) => ({ date: p.date, value: BigInt(p.balance) }))}
        projected={projection.map((p) => ({ date: p.date, value: p.owed }))}
        currency={loan.currency}
        title={
          when
            ? t('account.history.title_payoff', { name, date: when })
            : t('account.history.title_owed', { name })
        }
        endLabel={when ? t('account.history.paid_off_on', { date: when }) : null}
        marker={{ date: today, label: t('account.loan.today') }}
        projectedLabel={t('account.history.projected')}
      />
      <p className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
        {history.length > 1 && (
          <span className="inline-flex items-center gap-1.5">
            <LineKey />
            {t('account.history.legend_actual')}
          </span>
        )}
        {projection.length > 1 && (
          <span className="inline-flex items-center gap-1.5">
            <LineKey dashed />
            {t('account.history.legend_projected')}
          </span>
        )}
      </p>
    </div>
  );
}

function LineKey({ dashed = false }: { dashed?: boolean }) {
  return (
    <svg width="18" height="6" aria-hidden className="shrink-0">
      <line
        x1="1"
        x2="17"
        y1="3"
        y2="3"
        stroke="var(--chart-1)"
        strokeWidth="2"
        strokeLinecap="round"
        strokeDasharray={dashed ? '4 3' : undefined}
      />
    </svg>
  );
}

/** "Principal paid $X of $Y" and "Interest paid $X of about $Z total", each with a slim bar. */
export function PaidSoFar({ loan }: { loan: LoanDto }) {
  const { t, money } = useI18n();
  const ccy = loan.currency;
  const f = paidSoFar(loan);
  const rows = [
    {
      key: 'principal',
      text: t('account.loan.principal_paid_of', {
        paid: money(f.principalPaid, ccy),
        total: money(f.principal, ccy),
      }),
      percent: sharePercent(f.principalPaid, f.principal),
      color: PRINCIPAL,
    },
    {
      key: 'interest',
      text: t('account.loan.interest_paid_of', {
        paid: money(f.interestPaid, ccy),
        total: money(f.interestTotal, ccy),
      }),
      percent: sharePercent(f.interestPaid, f.interestTotal),
      color: INTEREST,
    },
  ];
  return (
    <section className="card space-y-3" data-testid="loan-paid-so-far" aria-labelledby="loan-paid-so-far">
      <h2 id="loan-paid-so-far" className="text-sm font-semibold">
        {t('account.loan.paid_so_far')}
      </h2>
      {rows.map((r) => (
        <div key={r.key} data-testid={`loan-paid-${r.key}`}>
          <p className="text-sm">{r.text}</p>
          <div
            className="mt-1 h-2 w-full overflow-hidden rounded-full bg-sunken"
            role="progressbar"
            aria-label={r.text}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.min(100, r.percent)}
          >
            <div
              className="h-full rounded-full"
              style={{ width: `${Math.min(100, Math.max(0, r.percent))}%`, background: r.color }}
            />
          </div>
        </div>
      ))}
      {loan.paymentsBefore > 0 && (
        <p className="text-xs text-muted" data-testid="loan-paid-before-tracking">
          {t('account.loan.interest_before_tracking')}
        </p>
      )}
    </section>
  );
}
