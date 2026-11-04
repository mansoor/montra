import type { Metadata } from 'next';
import { getI18n } from '@/lib/i18n-server';
import { AskBox } from '@/components/reports/ask-box';
import { PageHeader } from '@/components/ui/page-header';

export const metadata: Metadata = { title: 'Ask' };

/** Ask-your-data (RPT-06). */
export default async function AskPage({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params;
  const { t } = await getI18n();
  return (
    <div className="space-y-5">
      <PageHeader title={t('ask.title')} subtitle={t('ask.subtitle')} />
      <AskBox workspaceId={workspaceId} />
    </div>
  );
}
