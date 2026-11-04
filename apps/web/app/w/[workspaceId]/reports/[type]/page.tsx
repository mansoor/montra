import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ApiError } from '@montra/api-client';
import { ReportType } from '@montra/schemas';
import { load } from '@/lib/server-api';
import { getI18n } from '@/lib/i18n-server';
import { drillHref } from '@/lib/planning';
import {
  barPercent,
  chartBars,
  chartLines,
  filtersFromParams,
  FILTER_KEYS,
  type FilterValues,
} from '@/lib/reports';
import { LineChart } from '@/components/charts/line-chart';
import { DateText } from '@/components/i18n';
import { Money } from '@/components/money';
import { ReportExport, ReportFilterBar } from '@/components/reports/report-controls';
import { PageHeader } from '@/components/ui/page-header';

export const metadata: Metadata = { title: 'Report' };
export const dynamic = 'force-dynamic';

const SECTIONS = new Set([
  'income',
  'expense',
  'net',
  'assets',
  'liabilities',
  'equity',
  'retained',
  'liabilities_and_equity',
]);
const NEEDS_BOOKS = new Set([
  'pnl',
  'general-ledger',
  'trial-balance',
  'balance-sheet',
  'schedule-c',
  'schedule-e',
]);

/** One report: filters, a chart when it helps, a table whose rows lead to their transactions, and export (RPT-01..04). */
export default async function ReportPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string; type: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const { workspaceId, type: rawType } = await params;
  const parsed = ReportType.safeParse(rawType);
  if (!parsed.success) notFound();
  const type = parsed.data;
  const sp = await searchParams;
  const values: FilterValues = Object.fromEntries(FILTER_KEYS.flatMap((k) => (sp[k] ? [[k, sp[k]]] : [])));
  const { t } = await getI18n();
  const [workspace, accounts, categories, members] = await load((api) =>
    Promise.all([
      api.getWorkspace(workspaceId),
      api.listAccounts(workspaceId),
      api.listCategories(workspaceId),
      api.listFamilyMembers(workspaceId),
    ]),
  );
  const portfolios = workspace.entities.filter((e) => e.type === 'rental');
  const properties = (
    await load((api) => Promise.all(portfolios.map((e) => api.listProperties(workspaceId, e.id))))
  ).flat();
  // These need one set of books; start on the first that fits rather than an empty page.
  const fitting =
    type === 'schedule-c'
      ? workspace.entities.filter((e) => e.type === 'business')
      : type === 'schedule-e'
        ? portfolios
        : workspace.entities;
  if (NEEDS_BOOKS.has(type) && !values.entityId && fitting[0]) values.entityId = fitting[0].id;
  const base = `/w/${workspaceId}`;
  const filters = filtersFromParams({ ...values });
  const report = await load(async (api) => {
    try {
      return await api.getReport(workspaceId, type, filters);
    } catch (err) {
      // A report that doesn't apply to the chosen books, such as Schedule C on personal ones, says so rather than failing.
      if (err instanceof ApiError && err.status === 422) return { unavailable: err.message };
      throw err;
    }
  });
  const title = t(`reports.type.${type}`);
  const back = { href: `${base}/reports`, label: t('nav.reports') };
  if ('unavailable' in report) {
    return (
      <div className="space-y-5">
        <PageHeader title={title} back={back} />
        <p className="card text-sm" role="status">
          {report.unavailable}
        </p>
      </div>
    );
  }
  const ccy = report.currency;
  const bars = report.chart?.kind === 'bar' ? chartBars(report) : [];
  const lines = report.chart?.kind === 'line' ? chartLines(report) : null;
  const largest = bars.reduce((m, b) => (b.value > m ? b.value : m), 0n);
  const cell = (c: (typeof report.columns)[number], v: string | null | undefined) => {
    if (v === null || v === undefined) return c.kind === 'text' ? '' : '—';
    if (c.kind === 'money') return <Money amount={v} currency={ccy} />;
    if (c.kind === 'date') return <DateText date={v as never} />;
    if (c.kind === 'percent') return `${v}%`;
    if (c.kind === 'text' && SECTIONS.has(v)) return t(`reports.section.${v}`);
    return v;
  };
  const align = (kind: string) => (kind === 'text' || kind === 'date' ? '' : 'text-right');
  return (
    <div className="space-y-5">
      <PageHeader
        title={title}
        subtitle={
          <span data-testid="report-period">
            {report.uses.includes('from') ? (
              <>
                <DateText date={report.from} /> – <DateText date={report.to} />
              </>
            ) : (
              <>
                {t('reports.as_of')} <DateText date={report.to} />
              </>
            )}
          </span>
        }
        back={back}
        actions={<ReportExport workspaceId={workspaceId} type={type} values={values} />}
      />
      <ReportFilterBar
        workspace={workspace}
        report={report}
        values={values}
        accounts={accounts}
        categories={categories}
        members={members}
        properties={properties}
      />
      {bars.length > 0 && (
        <section className="card space-y-2" aria-hidden>
          {bars.map((b) => {
            const drill = report.rows.find((r) => r.key === b.key)?.drill;
            const bar = (
              <>
                <span className="truncate">{b.label}</span>
                <span className="h-3 rounded bg-sunken">
                  <span
                    className="block h-3 rounded bg-brand-600"
                    style={{ width: `${barPercent(b.value, largest)}%` }}
                  />
                </span>
              </>
            );
            const row = 'grid grid-cols-[minmax(0,10rem)_1fr] items-center gap-2 text-xs';
            // RPT-03. Out of the tab order: the table below has the same links for keyboards and screen readers.
            return drill ? (
              <Link
                key={b.key}
                href={drillHref(base, drill)}
                tabIndex={-1}
                className={`${row} hover:underline`}
              >
                {bar}
              </Link>
            ) : (
              <div key={b.key} className={row}>
                {bar}
              </div>
            );
          })}
        </section>
      )}
      {lines && lines.labels.length > 1 && (
        <section className="card">
          <LineChart
            title={title}
            labels={lines.labels}
            currency={ccy}
            series={lines.series.map((s) => ({ label: t(`reports.col.${s.key}`), values: s.values }))}
          />
        </section>
      )}
      {report.rows.length === 0 ? (
        <p className="card text-sm text-muted" role="status">
          {t('reports.no_rows')}
        </p>
      ) : (
        <section className="card-flush overflow-x-auto" aria-label={title}>
          <table className="tbl" data-testid="report-table">
            <thead>
              <tr>
                {report.columns.map((c) => (
                  <th key={c.key} className={`px-3 py-2 ${align(c.kind)}`}>
                    {t(`reports.col.${c.key}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {report.rows.map((r) => (
                <tr key={r.key} data-testid="report-row" className={r.emphasis ? 'font-semibold' : undefined}>
                  {report.columns.map((c, i) => (
                    <td key={c.key} className={`px-3 py-2 text-sm ${align(c.kind)}`}>
                      {/* RPT-03: the first cell leads to the transactions behind the row. */}
                      {i === 0 && r.drill ? (
                        <Link className="underline" href={drillHref(base, r.drill)}>
                          {cell(c, r.cells[c.key])}
                        </Link>
                      ) : (
                        cell(c, r.cells[c.key])
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
            {report.totals && (
              <tfoot>
                <tr className="font-semibold" data-testid="report-total">
                  {report.columns.map((c, i) => (
                    <td key={c.key} className={`px-3 py-2 text-sm ${align(c.kind)}`}>
                      {i === 0 && !report.totals![c.key]
                        ? t('reports.total')
                        : cell(c, report.totals![c.key])}
                    </td>
                  ))}
                </tr>
              </tfoot>
            )}
          </table>
        </section>
      )}
      {report.notes.map((n) => (
        <p key={n} className="text-xs text-muted">
          {t(`reports.note.${n}`)}
        </p>
      ))}
    </div>
  );
}
