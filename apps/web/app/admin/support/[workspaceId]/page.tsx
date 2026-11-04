import Link from 'next/link';
import { load } from '@/lib/server-api';
import { getI18n } from '@/lib/i18n-server';

/** OPS-02: only with the owner's say-so, and each visit shows in their activity log. */
export default async function SupportViewPage({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params;
  const view = await load((api) => api.adminSupportView(workspaceId));
  const { t } = await getI18n();
  return (
    <>
      <Link className="text-sm text-muted hover:underline" href="/admin">
        ← {t('admin.title')}
      </Link>
      <h1 className="page-title">{view.workspace.name}</h1>
      <p className="card text-sm" role="note" data-testid="support-view">
        {t('admin.support_note', { date: new Date(view.expiresAt).toLocaleString() })}
      </p>
      <section className="card space-y-1" aria-label={t('admin.books')}>
        <h2 className="text-base font-semibold">{t('admin.books')}</h2>
        {view.entities.map((e) => (
          <p key={e.id} className="text-sm">
            {e.name} · {e.type} · {e.currency}
          </p>
        ))}
      </section>
      <section className="card-flush overflow-x-auto" aria-label={t('admin.tab.imports')}>
        <table className="tbl">
          <thead>
            <tr>
              <th className="px-3 py-2">{t('admin.file_type')}</th>
              <th className="px-3 py-2">{t('admin.status')}</th>
              <th className="px-3 py-2 text-right">{t('admin.rows_read')}</th>
              <th className="px-3 py-2 text-right">{t('admin.rows_added')}</th>
              <th className="px-3 py-2 text-right">{t('admin.rows_failed')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {view.imports.map((b) => (
              <tr key={b.id}>
                <td className="px-3 py-2 text-sm">{b.fileType}</td>
                <td className="px-3 py-2 text-sm">{b.status}</td>
                <td className="px-3 py-2 text-right text-sm">{b.rowsRead}</td>
                <td className="px-3 py-2 text-right text-sm">{b.rowsAdded}</td>
                <td className="px-3 py-2 text-right text-sm">{b.rowsFailed}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <section className="card space-y-1" aria-label={t('admin.tab.ai')}>
        <h2 className="text-base font-semibold">{t('admin.tab.ai')}</h2>
        {view.aiEvents.map((e, i) => (
          <p key={i} className="text-sm">
            {e.task} · {e.model} · {e.outcome}
            {e.userAction && ` · ${e.userAction}`}
          </p>
        ))}
      </section>
    </>
  );
}
