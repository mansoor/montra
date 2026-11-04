import type { Metadata } from 'next';
import { load } from '@/lib/server-api';
import { TenantManager } from '@/components/rentals/lease-forms';

export const metadata: Metadata = { title: 'Tenants' };
export const dynamic = 'force-dynamic';

/** Tenants of a portfolio (RNT-03). */
export default async function TenantsPage({
  params,
}: {
  params: Promise<{ workspaceId: string; entityId: string }>;
}) {
  const { workspaceId, entityId } = await params;
  const tenants = await load((api) => api.listTenants(workspaceId, entityId));
  return <TenantManager workspaceId={workspaceId} entityId={entityId} tenants={tenants} />;
}
