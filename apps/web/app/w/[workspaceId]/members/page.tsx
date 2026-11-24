import type { Metadata } from 'next';
import Link from 'next/link';
import { startOfMonth, todayIn } from '@montra/domain';
import type { EducationSummaryDto, MemberTotalsDto, PayslipSummaryDto } from '@montra/api-client';
import { load } from '@/lib/server-api';
import { getI18n } from '@/lib/i18n-server';
import { educationView } from '@/lib/education';
import { drillHref } from '@/lib/planning';
import { Disclaimer } from '@/components/ai/shared';
import { LineChart, ProgressBar } from '@/components/charts/line-chart';
import { DateText } from '@/components/i18n';
import { Money } from '@/components/money';
import { EmptyState, LinkTabs, PageHeader, StatTile } from '@/components/ui/page-header';

export const metadata: Metadata = { title: 'By member' };
export const dynamic = 'force-dynamic';

const RANGES = ['month', 'ytd', 'last_year'] as const;
type Range = (typeof RANGES)[number];

/**
 * Income and spending by member, with Household as its own group (FAM-08, RPT-01), every total drilling down to
 * its transactions (FAM-09), withholding for the members whose payslips this login may read (PAY-06), and education
 * expenses and 529 withdrawals per student for the tax year (FAM-10).
 */
export default async function MembersReportPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<{ range?: string }>;
}) {
  const { workspaceId } = await params;
  const sp = await searchParams;
  const range: Range = (RANGES as readonly string[]).includes(sp.range ?? '') ? (sp.range as Range) : 'month';
  const workspace = await load((api) => api.getWorkspace(workspaceId));
  const today = todayIn(workspace.timeZone);
  const year = Number(today.slice(0, 4));
  const bounds: Record<Range, { from: string; to: string }> = {
    month: { from: startOfMonth(today), to: today },
    ytd: { from: `${year}-01-01`, to: today },
    last_year: { from: `${year - 1}-01-01`, to: `${year - 1}-12-31` },
  };
  const { from, to } = bounds[range];
  const taxYear = range === 'last_year' ? year - 1 : year;
  const [report, employers, education] = await load((api) =>
    Promise.all([
      api.getMemberReport(workspaceId, { from, to }),
      api.listEmployers(workspaceId),
      api.getEducationSummary(workspaceId, { year: taxYear }),
    ]),
  );
  // Employers are as private as payslips, so those this login can see are the summaries it may read.
  const earners = [...new Set(employers.map((e) => e.memberId))];
  const summaries = await load((api) =>
    Promise.all(
      earners.map((m) =>
        api.getPayslipSummary(workspaceId, m, range === 'last_year' ? { year: year - 1 } : {}),
      ),
    ),
  );
  const { t } = await getI18n();
  const base = `/w/${workspaceId}`;
  const ccy = report.currency;
  const drill = (m: MemberTotalsDto, categoryIds?: string[]) =>
    drillHref(base, {
      memberId: m.memberId ?? 'household',
      from,
      to,
      ...(categoryIds ? { categoryIds } : {}),
    });
  const months = report.members[0]?.months.map((p) => p.month) ?? [];
  const hasActivity = report.members.some((m) => BigInt(m.income) !== 0n || BigInt(m.spending) !== 0n);

  return (
    <div className="space-y-5">
      <PageHeader
        title={t('nav.by_member')}
        subtitle={
          <>
            <DateText date={from} /> – <DateText date={to} />
          </>
        }
      />
      <LinkTabs
        label={t('members_report.range')}
        current={range}
        tabs={RANGES.map((k) => ({
          key: k,
          href: `${base}/members${k === 'month' ? '' : `?range=${k}`}`,
          label: t(`members_report.range_${k}`),
        }))}
      />
      {!hasActivity ? (
        <EmptyState title={t('members_report.empty')} />
      ) : (
        <>
          {months.length > 1 && (
            <section className="card" aria-label={t('members_report.over_time')}>
              <h2 className="mb-2 text-base font-semibold">{t('members_report.over_time')}</h2>
              <LineChart
                title={t('members_report.over_time')}
                series={report.members.map((m) => ({
                  label: m.name,
                  values: m.months.map((p) => p.spending),
                }))}
                labels={months}
                currency={ccy}
              />
            </section>
          )}
          <div className="grid gap-4 lg:grid-cols-2">
            {report.members.map((m) => (
              <section
                key={m.memberId ?? 'household'}
                className="card space-y-3"
                aria-label={m.name}
                data-testid="member-card"
              >
                <h2 className="text-base font-semibold">{m.name}</h2>
                <div className="grid gap-2 sm:grid-cols-2">
                  <StatTile
                    label={t('members_report.income')}
                    value={<Money amount={m.income} currency={ccy} />}
                    href={drill(m)}
                  />
                  <StatTile
                    label={t('members_report.spending')}
                    value={<Money amount={m.spending} currency={ccy} />}
                    hint={t('members_report.share', { share: m.spendingShare })}
                    href={drill(m)}
                  />
                </div>
                <ProgressBar
                  percent={m.spendingShare}
                  label={t('members_report.share_of', { name: m.name })}
                />
                {m.categories.length > 0 && (
                  <ul className="divide-y divide-line text-sm">
                    {m.categories.map((c) => (
                      <li key={c.categoryId} className="flex justify-between gap-3 py-1.5">
                        <Link href={drill(m, [c.categoryId])} className="underline">
                          {c.name}
                        </Link>
                        <Money amount={c.amount} currency={ccy} />
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            ))}
          </div>
        </>
      )}
      {summaries.map((s) => (
        <Withholding key={s.memberId} summary={s} t={t} />
      ))}
      <Education summary={education} base={base} t={t} />
      <p className="text-xs text-muted">{t('members_report.privacy')}</p>
    </div>
  );
}

/** PAY-06: gross against net, taxes, retirement and the effective rate, against the same span last year. */
function Withholding({
  summary: s,
  t,
}: {
  summary: PayslipSummaryDto;
  t: (key: string, values?: Record<string, string | number>) => string;
}) {
  const rate = (bps: number | null) => (bps === null ? '—' : `${(bps / 100).toFixed(2)}%`);
  const rows = [
    ['members_report.gross', s.ytd.gross, s.priorYear.gross],
    ['members_report.net', s.ytd.net, s.priorYear.net],
    ['members_report.taxes', s.ytd.taxes, s.priorYear.taxes],
    ['members_report.retirement', s.ytd.retirement, s.priorYear.retirement],
    ['members_report.employer', s.ytd.employer, s.priorYear.employer],
  ] as const;
  return (
    <section
      className="card space-y-3"
      aria-label={t('members_report.withholding_for', { name: s.name })}
      data-testid="payslip-summary"
    >
      <h2 className="text-base font-semibold">{t('members_report.withholding_for', { name: s.name })}</h2>
      <table className="tbl text-sm">
        <thead>
          <tr>
            <th className="py-1" />
            <th className="py-1 text-right">{t('members_report.ytd', { year: s.year })}</th>
            <th className="py-1 text-right">{t('members_report.same_span', { year: s.year - 1 })}</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {rows.map(([label, now, before]) => (
            <tr key={label}>
              <th scope="row" className="py-1.5 text-left font-normal">
                {t(label)}
              </th>
              <td className="py-1.5 text-right">
                <Money amount={now} currency={s.currency} />
              </td>
              <td className="py-1.5 text-right">
                <Money amount={before} currency={s.currency} />
              </td>
            </tr>
          ))}
          <tr>
            <th scope="row" className="py-1.5 text-left font-normal">
              {t('members_report.effective_rate')}
            </th>
            <td className="num py-1.5 text-right">{rate(s.ytd.effectiveRateBps)}</td>
            <td className="num py-1.5 text-right">{rate(s.priorYear.effectiveRateBps)}</td>
          </tr>
        </tbody>
      </table>
      {s.byTax.length > 0 && (
        <ul className="text-sm text-muted">
          {s.byTax.map((x) => (
            <li key={x.code} className="flex justify-between gap-3">
              <span>{x.label}</span>
              <Money amount={x.amount} currency={s.currency} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * FAM-10: education expenses by kind and 529 withdrawals per student for the tax year, with notes on what may matter
 * for the education credits or a 529 withdrawal. Informational only: nothing is worked out or decided.
 */
function Education({
  summary,
  base,
  t,
}: {
  summary: EducationSummaryDto;
  base: string;
  t: (key: string, values?: Record<string, string | number>) => string;
}) {
  const view = educationView(summary);
  const categoriesLink = `${base}/settings?tab=categories`;
  if (view.needsCategories && !summary.has529)
    return (
      <p className="text-sm text-muted" data-testid="education-hint">
        {t('education.hint')}{' '}
        <Link href={categoriesLink} className="underline">
          {t('education.mark_link')}
        </Link>
      </p>
    );
  const title = t('education.title', { year: summary.year });
  return (
    <section className="card space-y-3" aria-label={title} data-testid="education-summary">
      <h2 className="text-base font-semibold">{title}</h2>
      <p className="text-sm text-muted">{t('education.intro')}</p>
      {view.needsCategories && (
        <p className="text-sm">
          {t('education.no_categories')}{' '}
          <Link href={categoriesLink} className="underline">
            {t('education.mark_link')}
          </Link>
        </p>
      )}
      {view.students.length === 0 ? (
        <p className="text-sm text-muted">{t('education.empty', { year: summary.year })}</p>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {view.students.map((s) => (
            <div key={s.key} className="space-y-2" data-testid="education-student">
              <h3 className="text-sm font-semibold">
                {s.memberId === null ? t('education.no_member') : s.name}
                {s.isDependent && <span className="ml-2 text-xs text-muted">{t('education.dependent')}</span>}
              </h3>
              <table className="tbl text-sm">
                <tbody className="divide-y divide-line">
                  {s.expenses.map((e) => (
                    <tr key={e.type}>
                      <th scope="row" className="py-1.5 text-left font-normal">
                        {t(`education.type_${e.type}`)}
                      </th>
                      <td className="py-1.5 text-right">
                        <Money amount={e.amount} currency={summary.currency} />
                      </td>
                    </tr>
                  ))}
                  <tr>
                    <th scope="row" className="py-1.5 text-left font-semibold">
                      {t('education.expense_total')}
                    </th>
                    <td className="py-1.5 text-right font-semibold">
                      <Money amount={s.expenseTotal} currency={summary.currency} />
                    </td>
                  </tr>
                  {s.plans.map((p) => (
                    <tr key={p.accountId}>
                      <th scope="row" className="py-1.5 text-left font-normal">
                        {t('education.withdrawn_from', { name: p.name })}
                      </th>
                      <td className="py-1.5 text-right">
                        <Money amount={p.amount} currency={summary.currency} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {s.notes.length > 0 && (
                <ul className="list-disc space-y-1 pl-5 text-sm text-muted">
                  {s.notes.map((n) => (
                    <li key={n}>{t(`education.note_${n}`)}</li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </div>
      )}
      <Disclaimer kind="tax" />
    </section>
  );
}
