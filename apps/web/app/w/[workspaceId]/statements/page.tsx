import type { Metadata } from 'next';
import Link from 'next/link';
import { load, serverApi } from '@/lib/server-api';
import { getI18n } from '@/lib/i18n-server';
import { ImportHistory } from '@/components/imports/import-history';
import { StatementsInbox } from '@/components/imports/statements-inbox';
import { pendingStatements } from '@/lib/intakes';

export const metadata: Metadata = { title: 'Statements' };
export const dynamic = 'force-dynamic';

/**
 * Statements (ADR-0051): drop any statement, or a photo of one, without picking the account. Montra finds the account
 * for you to confirm, learns it after a few, and imports clean ones itself. The import history is here too.
 */
export default async function StatementsPage({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params;
  const [[workspace, accounts, batches], { t }] = await Promise.all([
    load((api) =>
      Promise.all([
        api.getWorkspace(workspaceId),
        api.listAccounts(workspaceId),
        api.listImports(workspaceId),
      ]),
    ),
    getI18n(),
  ]);
  const open = accounts.filter((a) => !a.archived);
  const base = `/w/${workspaceId}`;
  const importer = ['owner', 'admin', 'partner', 'accountant'].includes(workspace.role);
  // Statements uploaded earlier that are still being read or waiting for an account: in review (`open`, any age) and
  // still being read or imported (`recent`).
  const pending = importer
    ? pendingStatements(
        ...(await load((api) =>
          Promise.all([
            api.listIntakes(workspaceId, { status: 'open', kind: 'statement' }),
            api.listIntakes(workspaceId, { status: 'recent', kind: 'statement' }),
          ]),
        )),
      )
    : [];
  // ADR-0055 §6: accounts a bank feed imports into, so a statement for one says it will meet the feed's rows.
  const feedLinks = importer ? await (await serverApi()).bankFeedLinks(workspaceId).catch(() => []) : [];

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="page-title">{t('statements.title')}</h1>
        <p className="text-sm text-muted">{t('statements.intro')}</p>
      </div>
      {importer &&
        (open.length === 0 ? (
          <p className="card text-sm text-muted">
            {t('imports.upload.no_accounts')}{' '}
            <Link className="underline" href={`${base}/accounts/new`}>
              {t('nav.add_account')}
            </Link>
          </p>
        ) : (
          <StatementsInbox
            workspaceId={workspaceId}
            role={workspace.role}
            accounts={open}
            pending={pending}
            feedLinks={feedLinks}
          />
        ))}
      <section className="space-y-3" aria-labelledby="statement-history">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="statement-history" className="text-base font-semibold">
            {t('imports.history.title')}
          </h2>
          {importer && (
            <Link href={`${base}/import`} className="text-sm font-medium text-brand-600 underline">
              {t('statements.by_account')}
            </Link>
          )}
        </div>
        <ImportHistory
          workspaceId={workspaceId}
          batches={batches}
          accounts={accounts}
          title={t('imports.history.title')}
          role={workspace.role}
        />
      </section>
    </div>
  );
}
