import Link from 'next/link';
import type { ReactNode } from 'react';
import { load } from '@/lib/server-api';
import { getI18n } from '@/lib/i18n-server';
import { BusinessTabs } from '@/components/business/business-tabs';
import { PageHeader } from '@/components/ui/page-header';

/** One business: its name, a switcher when there are several, and its sections. */
export default async function BusinessLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ workspaceId: string; entityId: string }>;
}) {
  const { workspaceId, entityId } = await params;
  const [businesses, { t }] = await Promise.all([load((api) => api.listBusinesses(workspaceId)), getI18n()]);
  const current = businesses.find((b) => b.entityId === entityId);
  const root = `/w/${workspaceId}/business`;
  return (
    <div className="space-y-5">
      <PageHeader
        title={current?.name ?? t('nav.business')}
        actions={
          businesses.length > 1 ? (
            <nav aria-label={t('business.switch')} className="segmented segmented-md">
              {businesses.map((b) => (
                <Link
                  key={b.entityId}
                  href={`${root}/${b.entityId}`}
                  aria-current={b.entityId === entityId ? 'page' : undefined}
                >
                  {b.name}
                </Link>
              ))}
            </nav>
          ) : undefined
        }
      />
      <BusinessTabs base={`${root}/${entityId}`} />
      {children}
    </div>
  );
}
