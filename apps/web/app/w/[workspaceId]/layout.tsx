import Link from 'next/link';
import type { ReactNode } from 'react';
import { load } from '@/lib/server-api';
import { NavLinks } from '@/components/nav-links';

export const dynamic = 'force-dynamic';

export default async function WorkspaceLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  const workspace = await load((api) => api.getWorkspace(workspaceId));
  const base = `/w/${workspace.id}`;
  return (
    <div className="min-h-screen">
      <header className="border-b border-line bg-surface">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
          <Link href={base} className="text-lg font-semibold">
            Montra
          </Link>
          <span className="text-sm text-muted" aria-label="Workspace">
            {workspace.name}
          </span>
          <NavLinks
            links={[
              { href: base, label: 'Home', exact: true },
              { href: `${base}/transactions`, label: 'Transactions' },
              { href: `${base}/accounts/new`, label: 'Add account' },
            ]}
          />
          <form action="/sign-out" method="post" className="ml-auto">
            <button type="submit" className="btn-secondary">
              Sign out
            </button>
          </form>
        </div>
      </header>
      <main id="main" className="mx-auto max-w-5xl px-4 py-6">
        {children}
      </main>
    </div>
  );
}
