import type { Metadata } from 'next';
import { load } from '@/lib/server-api';
import { getI18n } from '@/lib/i18n-server';
import { PartyManager } from '@/components/business/party-manager';
import { LinkTabs } from '@/components/ui/page-header';

export const metadata: Metadata = { title: 'Customers and vendors' };
export const dynamic = 'force-dynamic';

/** Customers and vendors (BIZ-04). */
export default async function PartiesPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string; entityId: string }>;
  searchParams: Promise<{ kind?: string }>;
}) {
  const { workspaceId, entityId } = await params;
  const { kind: rawKind } = await searchParams;
  const kind = rawKind === 'vendor' ? 'vendor' : 'customer';
  const [business, parties] = await load((api) =>
    Promise.all([api.getBusiness(workspaceId, entityId), api.listParties(workspaceId, { entityId, kind })]),
  );
  const { t } = await getI18n();
  const base = `/w/${workspaceId}/business/${entityId}/parties`;
  return (
    <div className="space-y-4">
      <LinkTabs
        label={t('business.tab_parties')}
        current={kind}
        tabs={[
          { key: 'customer', href: base, label: t('parties.customers') },
          { key: 'vendor', href: `${base}?kind=vendor`, label: t('parties.vendors') },
        ]}
      />
      <PartyManager
        key={kind}
        workspaceId={workspaceId}
        entityId={entityId}
        currency={business.currency}
        kind={kind}
        parties={parties}
      />
    </div>
  );
}
