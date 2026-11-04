import Link from 'next/link';
import type { ReactNode } from 'react';
import { load } from '@/lib/server-api';
import { getI18n } from '@/lib/i18n-server';
import { RentalTabs } from '@/components/rentals/rental-tabs';
import { PageHeader } from '@/components/ui/page-header';

/** One portfolio: its name, a switcher when there are several, and its sections. */
export default async function RentalsLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ workspaceId: string; entityId: string }>;
}) {
  const { workspaceId, entityId } = await params;
  const [workspace, { t }] = await Promise.all([load((api) => api.getWorkspace(workspaceId)), getI18n()]);
  const portfolios = workspace.entities.filter((e) => e.type === 'rental');
  const current = portfolios.find((e) => e.id === entityId);
  const root = `/w/${workspaceId}/rentals`;
  return (
    <div className="space-y-5">
      <PageHeader
        title={current?.name ?? t('nav.rentals')}
        actions={
          portfolios.length > 1 ? (
            <nav aria-label={t('rentals.switch')} className="segmented segmented-md">
              {portfolios.map((e) => (
                <Link
                  key={e.id}
                  href={`${root}/${e.id}`}
                  aria-current={e.id === entityId ? 'page' : undefined}
                >
                  {e.name}
                </Link>
              ))}
            </nav>
          ) : undefined
        }
      />
      <RentalTabs base={`${root}/${entityId}`} />
      {children}
    </div>
  );
}
