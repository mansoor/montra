import type { Metadata } from 'next';
import Link from 'next/link';
import { load } from '@/lib/server-api';
import { UpcomingList } from '@/components/upcoming-list';

export const metadata: Metadata = { title: 'Upcoming' };
export const dynamic = 'force-dynamic';

/** Scheduled occurrences from recurring templates, waiting for confirmation (TXN-05). */
export default async function UpcomingPage({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params;
  const [scheduled, recurring, accounts] = await load((api) =>
    Promise.all([
      api.listTransactions(workspaceId, { status: 'scheduled', limit: 200 }),
      api.listRecurring(workspaceId),
      api.listAccounts(workspaceId, { include: 'all' }),
    ]),
  );
  const accountName = new Map(accounts.map((a) => [a.id, a.name]));
  const templates = new Map(recurring.map((r) => [r.id, r]));
  const items = [...scheduled]
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
    .map((t) => {
      const template = t.recurringItemId ? templates.get(t.recurringItemId) : undefined;
      return {
        id: t.id,
        date: t.date,
        title: t.payee || template?.name || t.description || 'Scheduled',
        templateName: template?.name ?? null,
        accountName: template ? (accountName.get(template.accountId) ?? '') : '',
        amount: t.amount ?? template?.amount ?? null,
      };
    });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">Upcoming</h1>
        <Link href={`/w/${workspaceId}/recurring`} className="text-sm font-medium text-brand-600 underline">
          Manage recurring
        </Link>
      </div>
      <UpcomingList workspaceId={workspaceId} items={items} />
    </div>
  );
}
