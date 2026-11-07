'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { PLAN_TYPES, WORKPLACE_PLANS, bpsToPercent, type PlanType } from '@montra/domain';
import type {
  AccountDto,
  AccountValuationDto,
  EmployerDto,
  InvestmentPerformanceDto,
} from '@montra/api-client';
import { browserApi } from '@/lib/browser-api';
import { parseAmountInput } from '@/lib/money';
import { LineChart } from '../charts/line-chart';
import { DateText, useI18n } from '../i18n';
import { Money } from '../money';
import { StatusLine, useAction } from '../use-action';

const RANGES = ['3m', '6m', '1y', 'all'] as const;

/** A signed percentage from basis points: "+7.25%", "−1.10%". */
export function percentOf(bps: number): string {
  const sign = bps > 0 ? '+' : bps < 0 ? '−' : '';
  return `${sign}${bpsToPercent(Math.abs(bps))}%`;
}

/** Gain over time: what changed in value, what was put in, and a chart of both (ADR-0025). */
export function InvestmentPerformance({
  account,
  perf,
  href,
}: {
  account: AccountDto;
  perf: InvestmentPerformanceDto;
  href: (range: (typeof RANGES)[number]) => string;
}) {
  const { t } = useI18n();
  const money = (amount: string) => <Money amount={amount} currency={perf.currency} />;
  const s = perf.summary;
  return (
    <section className="card space-y-4" data-testid="performance" aria-label={t('account.invest.title')}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-semibold">{t('account.invest.title')}</h2>
        <nav aria-label={t('account.history.range')} className="segmented segmented-md">
          {RANGES.map((r) => (
            <Link key={r} href={href(r)} aria-current={perf.range === r ? 'true' : undefined} scroll={false}>
              {t(`account.history.range_${r}`)}
            </Link>
          ))}
        </nav>
      </div>
      {perf.hidden ? (
        <p className="text-sm text-muted">{t('account.invest.hidden')}</p>
      ) : !s ? (
        <p className="text-sm text-muted">{t('account.invest.empty')}</p>
      ) : (
        <>
          <dl className="flex flex-wrap gap-x-8 gap-y-2 text-sm" data-testid="performance-summary">
            <div data-testid="perf-gain">
              <dt className="text-muted">{t('account.invest.gain')}</dt>
              <dd className={`text-lg font-semibold ${BigInt(s.gain) < 0n ? 'text-bad' : ''}`}>
                <Money amount={s.gain} currency={perf.currency} signed />
              </dd>
            </div>
            <div data-testid="perf-return">
              <dt className="text-muted">{t('account.invest.return')}</dt>
              <dd className="text-lg font-semibold">{s.returnBps === null ? '—' : percentOf(s.returnBps)}</dd>
            </div>
            {s.annualizedBps !== null && (
              <div data-testid="perf-annualized">
                <dt className="text-muted">{t('account.invest.annualized')}</dt>
                <dd className="text-lg font-semibold">{percentOf(s.annualizedBps)}</dd>
              </div>
            )}
            <div data-testid="perf-in">
              <dt className="text-muted">{t('account.invest.money_in')}</dt>
              <dd className="font-medium">{money(s.moneyIn)}</dd>
            </div>
            {BigInt(s.moneyOut) > 0n && (
              <div data-testid="perf-out">
                <dt className="text-muted">{t('account.invest.money_out')}</dt>
                <dd className="font-medium">{money(s.moneyOut)}</dd>
              </div>
            )}
            <div data-testid="perf-end">
              <dt className="text-muted">{t('account.invest.value_now')}</dt>
              <dd className="font-medium">{money(s.end)}</dd>
            </div>
          </dl>
          {perf.points.length > 1 && (
            <LineChart
              title={t('account.invest.chart_title', { name: account.name })}
              series={[
                { label: t('account.invest.series_value'), values: perf.points.map((p) => p.value) },
                { label: t('account.invest.series_invested'), values: perf.points.map((p) => p.invested) },
              ]}
              labels={perf.points.map((p) => p.date)}
              currency={perf.currency}
            />
          )}
          <div className="relative overflow-x-auto" data-testid="performance-table">
            <table className="tbl min-w-[36rem] text-sm">
              <caption className="sr-only">
                {t('account.invest.table_caption', { name: account.name })}
              </caption>
              <thead className="border-b border-line text-left text-xs uppercase tracking-wide text-muted">
                <tr>
                  <th scope="col" className="px-4 py-2">
                    {t('account.invest.period')}
                  </th>
                  <th scope="col" className="px-4 py-2 text-right">
                    {t('account.invest.start')}
                  </th>
                  <th scope="col" className="px-4 py-2 text-right">
                    {t('account.invest.money_in')}
                  </th>
                  <th scope="col" className="px-4 py-2 text-right">
                    {t('account.invest.money_out')}
                  </th>
                  <th scope="col" className="px-4 py-2 text-right">
                    {t('account.invest.gain')}
                  </th>
                  <th scope="col" className="px-4 py-2 text-right">
                    {t('account.invest.end')}
                  </th>
                  <th scope="col" className="px-4 py-2 text-right">
                    {t('account.invest.return')}
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {perf.periods.map((p) => (
                  <tr key={p.from} data-testid="performance-row">
                    <td className="whitespace-nowrap px-4 py-2">
                      <DateText date={p.from} /> – <DateText date={p.to} />
                    </td>
                    <td className="px-4 py-2 text-right">{money(p.start)}</td>
                    <td className="px-4 py-2 text-right">{money(p.moneyIn)}</td>
                    <td className="px-4 py-2 text-right">{money(p.moneyOut)}</td>
                    <td className="px-4 py-2 text-right">
                      <Money amount={p.gain} currency={perf.currency} signed />
                    </td>
                    <td className="px-4 py-2 text-right font-medium">{money(p.end)}</td>
                    <td className="px-4 py-2 text-right">
                      {p.returnBps === null ? '—' : percentOf(p.returnBps)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-muted">{t('account.invest.note')}</p>
        </>
      )}
    </section>
  );
}

/** One line of pasted statement values: "2026-09-30, 51,234.50". */
function parseValueLines(
  raw: string,
  currency: string,
  locale: string,
): { ok: true; values: { date: string; value: string }[] } | { ok: false; line: number } {
  const values: { date: string; value: string }[] = [];
  const lines = raw.split(/\r?\n/).map((l) => l.trim());
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (!l) continue;
    const m = /^(\d{4}-\d{2}-\d{2})\s*[,;\t]\s*(.+)$/.exec(l);
    if (!m) return { ok: false, line: i + 1 };
    const parsed = parseAmountInput(m[2]!.replace(/^"|"$/g, ''), currency, locale);
    if (!parsed.ok || parsed.minor < 0n) return { ok: false, line: i + 1 };
    values.push({ date: m[1]!, value: parsed.minor.toString() });
  }
  values.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return { ok: true, values };
}

/** Update the value from a statement, or paste several at once; the latest can be taken back. */
export function ValueUpdates({
  workspaceId,
  account,
  values,
  today,
  hidden,
}: {
  workspaceId: string;
  account: AccountDto;
  values: readonly AccountValuationDto[];
  today: string;
  hidden: boolean;
}) {
  const { t, locale } = useI18n();
  const router = useRouter();
  const { run, busy, message, setMessage } = useAction();
  const [date, setDate] = useState(today);
  const [value, setValue] = useState('');
  const [note, setNote] = useState('');
  const [pasted, setPasted] = useState('');
  const ccy = account.currency;
  if (hidden) return null;
  return (
    <section className="card space-y-3" data-testid="value-updates" aria-label={t('account.value.title')}>
      <h2 className="text-sm font-semibold">{t('account.value.title')}</h2>
      <p className="text-sm text-muted">{t('account.value.help')}</p>
      <form
        className="flex flex-wrap items-end gap-3"
        aria-label={t('account.value.title')}
        onSubmit={(e) => {
          e.preventDefault();
          const parsed = parseAmountInput(value, ccy, locale);
          if (!parsed.ok || parsed.minor < 0n)
            return setMessage({ tone: 'bad', text: t('budget.amount_invalid') });
          void run(
            () =>
              browserApi.addValuations(workspaceId, account.id, {
                values: [
                  {
                    date: date as never,
                    value: parsed.minor.toString(),
                    ...(note.trim() ? { note: note.trim() } : {}),
                  },
                ],
              }),
            t('account.value.saved'),
          ).then((r) => {
            if (r) {
              setValue('');
              setNote('');
              router.refresh();
            }
          });
        }}
      >
        <label>
          <span className="field-label">{t('account.value.date')}</span>
          <input
            type="date"
            className="input"
            value={date}
            max={today}
            onChange={(e) => setDate(e.target.value)}
          />
        </label>
        <label>
          <span className="field-label">{t('account.value.value')}</span>
          <input
            className="input num w-36"
            inputMode="decimal"
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
        </label>
        <label className="min-w-0 flex-1">
          <span className="field-label">{t('account.value.note')}</span>
          <input className="input" maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
        </label>
        <button type="submit" className="btn-primary" disabled={busy}>
          {t('account.value.save')}
        </button>
      </form>
      <details>
        <summary className="cursor-pointer text-sm underline">{t('account.value.paste_title')}</summary>
        <form
          className="mt-2 space-y-2"
          aria-label={t('account.value.paste_title')}
          onSubmit={(e) => {
            e.preventDefault();
            const read = parseValueLines(pasted, ccy, locale);
            if (!read.ok)
              return setMessage({ tone: 'bad', text: t('account.value.paste_bad', { line: read.line }) });
            if (read.values.length === 0) return;
            void run(
              () => browserApi.addValuations(workspaceId, account.id, { values: read.values as never }),
              t('account.value.pasted', { count: read.values.length }),
            ).then((r) => {
              if (r) {
                setPasted('');
                router.refresh();
              }
            });
          }}
        >
          <label className="block">
            <span className="field-label">{t('account.value.paste_label')}</span>
            <textarea
              className="input h-28 font-mono text-sm"
              placeholder={'2026-06-30, 48250.00\n2026-09-30, 51234.50'}
              value={pasted}
              onChange={(e) => setPasted(e.target.value)}
            />
          </label>
          <button type="submit" className="btn-secondary" disabled={busy}>
            {t('account.value.paste_save')}
          </button>
        </form>
      </details>
      <StatusLine message={message} />
      {values.length > 0 && (
        <ul className="divide-y divide-line text-sm" data-testid="value-list">
          {values.slice(0, 8).map((v, i) => (
            <li
              key={v.id}
              className="flex flex-wrap items-baseline justify-between gap-3 py-2"
              data-testid="value-row"
            >
              <span>
                <DateText date={v.date} />
                {v.note ? <span className="text-muted">{` · ${v.note}`}</span> : null}
              </span>
              <span className="flex items-baseline gap-4">
                <span className="text-muted">
                  {t('account.value.change')} <Money amount={v.change} currency={ccy} signed />
                </span>
                <Money amount={v.value} currency={ccy} className="font-medium" />
                {i === 0 && (
                  <button
                    type="button"
                    className="underline"
                    disabled={busy}
                    onClick={() =>
                      void run(
                        () => browserApi.removeValuation(workspaceId, account.id, v.id),
                        t('account.value.removed'),
                      ).then(() => router.refresh())
                    }
                  >
                    {t('account.value.remove')}
                  </button>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** The plan, and which employer's payslips pay into it. */
export function PlanSettings({
  workspaceId,
  account,
  employers,
}: {
  workspaceId: string;
  account: AccountDto;
  employers: readonly EmployerDto[];
}) {
  const { t } = useI18n();
  const router = useRouter();
  const { run, busy, message } = useAction();
  const [plan, setPlan] = useState<PlanType | ''>(account.planType ?? '');
  const [employerId, setEmployerId] = useState(account.employerId ?? '');
  const [contributions, setContributions] = useState(account.employerContributions);
  const workplace = plan !== '' && WORKPLACE_PLANS.has(plan);
  const own = employers.filter((e) => e.entityId === account.entityId);
  return (
    <details className="card" data-testid="plan-settings" open={account.planType === null}>
      <summary className="cursor-pointer text-sm font-semibold">{t('account.plan.settings')}</summary>
      <form
        className="mt-3 space-y-3"
        aria-label={t('account.plan.settings')}
        onSubmit={(e) => {
          e.preventDefault();
          void run(
            () =>
              browserApi.updateAccount(workspaceId, account.id, {
                planType: plan || null,
                employerId: workplace && employerId ? employerId : null,
                employerContributions: workplace && !!employerId && contributions,
              }),
            t('common.saved'),
          ).then((r) => {
            if (r) router.refresh();
          });
        }}
      >
        <PlanFields
          plan={plan}
          onPlan={setPlan}
          employerId={employerId}
          onEmployer={setEmployerId}
          contributions={contributions}
          onContributions={setContributions}
          employers={own}
        />
        <button type="submit" className="btn-secondary" disabled={busy}>
          {t('common.save')}
        </button>
      </form>
      <StatusLine message={message} />
    </details>
  );
}

/** The plan's fields, shared by adding an account and changing one. */
export function PlanFields({
  plan,
  onPlan,
  employerId,
  onEmployer,
  contributions,
  onContributions,
  employers,
}: {
  plan: PlanType | '';
  onPlan: (p: PlanType | '') => void;
  employerId: string;
  onEmployer: (id: string) => void;
  contributions: boolean;
  onContributions: (on: boolean) => void;
  employers: readonly EmployerDto[];
}) {
  const { t } = useI18n();
  const workplace = plan !== '' && WORKPLACE_PLANS.has(plan);
  return (
    <div className="space-y-3" data-testid="plan-fields">
      <div className="grid gap-4 sm:grid-cols-2">
        <label>
          <span className="field-label">{t('account.plan.type')}</span>
          <select className="input" value={plan} onChange={(e) => onPlan(e.target.value as PlanType | '')}>
            <option value="">{t('account.plan.unset')}</option>
            {PLAN_TYPES.map((p) => (
              <option key={p} value={p}>
                {t(`account.plan.${p}`)}
              </option>
            ))}
          </select>
        </label>
        {workplace && (
          <label>
            <span className="field-label">{t('account.plan.employer')}</span>
            <select className="input" value={employerId} onChange={(e) => onEmployer(e.target.value)}>
              <option value="">{t('account.plan.employer_none')}</option>
              {employers.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name}
                </option>
              ))}
            </select>
            <span className="mt-1 block text-xs text-muted">
              {employers.length === 0 ? t('account.plan.no_employers') : t('account.plan.employer_help')}
            </span>
          </label>
        )}
      </div>
      {workplace && employerId && (
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            className="mt-1"
            checked={contributions}
            onChange={(e) => onContributions(e.target.checked)}
          />
          <span>
            {t('account.plan.contributions')}
            <span className="block text-muted">{t('account.plan.contributions_help')}</span>
          </span>
        </label>
      )}
    </div>
  );
}
