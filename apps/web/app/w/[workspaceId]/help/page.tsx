import type { Metadata } from 'next';
import { getI18n } from '@/lib/i18n-server';
import { load } from '@/lib/server-api';
import { ContactForm, HelpSearch, StartTourButton } from '@/components/help';
import { PageHeader } from '@/components/ui/page-header';

export const metadata: Metadata = { title: 'Help' };

/** OPS-09: articles, a tour, and a way to reach someone. */
export default async function HelpPage({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params;
  const { t } = await getI18n();
  const requests = await load((api) => api.listSupportRequests());
  return (
    <div className="space-y-6">
      <PageHeader title={t('help.title')} actions={<StartTourButton workspaceId={workspaceId} />} />
      <HelpSearch />
      <h2 className="text-base font-semibold">{t('help.contact')}</h2>
      <ContactForm workspaceId={workspaceId} />
      {requests.length > 0 && (
        <section className="card max-w-xl" aria-label={t('help.your_requests')}>
          <h2 className="mb-2 text-base font-semibold">{t('help.your_requests')}</h2>
          <ul className="divide-y divide-line">
            {requests.map((r) => (
              <li
                key={r.id}
                className="flex justify-between gap-2 py-2 text-sm"
                data-testid="support-request"
              >
                <span>{r.subject}</span>
                <span className="text-muted">{t(`help.status_${r.status}`)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
