import type { Metadata } from 'next';
import Link from 'next/link';
import { REPORT_TYPES } from '@montra/schemas';
import { load } from '@/lib/server-api';
import { getI18n } from '@/lib/i18n-server';
import { savedToParams } from '@/lib/reports';
import { DeleteSavedReport } from '@/components/reports/report-controls';
import { PageHeader } from '@/components/ui/page-header';

export const metadata: Metadata = { title: 'Reports' };
export const dynamic = 'force-dynamic';

/** The catalogue, and reports saved with their filters (RPT-01, RPT-02). */
export default async function ReportsPage({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params;
  const saved = await load((api) => api.listSavedReports(workspaceId));
  const { t } = await getI18n();
  const here = `/w/${workspaceId}/reports`;
  return (
    <div className="space-y-5">
      <PageHeader title={t('nav.reports')} subtitle={t('reports.subtitle')} />
      {saved.length > 0 && (
        <section className="card" aria-labelledby="saved-title">
          <h2 id="saved-title" className="mb-2 text-base font-semibold">
            {t('reports.saved_title')}
          </h2>
          <ul className="divide-y divide-line">
            {saved.map((s) => (
              <li
                key={s.id}
                className="flex items-center justify-between gap-2 py-2"
                data-testid="saved-report"
              >
                <Link
                  className="text-sm underline"
                  href={`${here}/${s.type}?${savedToParams(s.filters).toString()}`}
                >
                  {s.name}
                </Link>
                <span className="flex items-center gap-3 text-xs text-muted">
                  {t(`reports.type.${s.type}`)}
                  <DeleteSavedReport workspaceId={workspaceId} id={s.id} name={s.name} />
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
      <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" aria-label={t('reports.catalogue')}>
        {REPORT_TYPES.map((type) => (
          <li key={type}>
            <Link
              href={`${here}/${type}`}
              className="card block h-full hover:border-brand-600"
              data-testid="report-card"
            >
              <span className="block font-medium">{t(`reports.type.${type}`)}</span>
              <span className="mt-1 block text-sm text-muted">{t(`reports.about.${type}`)}</span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
