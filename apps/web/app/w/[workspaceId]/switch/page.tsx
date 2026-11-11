import Link from 'next/link';
import { load } from '@/lib/server-api';
import { getI18n } from '@/lib/i18n-server';
import { PageHeader } from '@/components/ui/page-header';
import { SwitchWizard } from '@/components/switch/switch-wizard';

export const dynamic = 'force-dynamic';

/**
 * Switching from another app (IMP-13, ADR-0029): export instructions per app, one upload, a plan for the export's
 * accounts and categories, then one import per account. For a fresh start only: otherwise it offers a new workspace.
 */
export default async function SwitchPage({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params;
  const [[eligibility, workspace, accounts, categories], { t }] = await Promise.all([
    load((api) =>
      Promise.all([
        api.getMigrationEligibility(workspaceId),
        api.getWorkspace(workspaceId),
        api.listAccounts(workspaceId),
        api.listCategories(workspaceId),
      ]),
    ),
    getI18n(),
  ]);
  const base = `/w/${workspaceId}`;
  const personal = workspace.entities.find((e) => e.type === 'personal') ?? workspace.entities[0];

  return (
    <div className="space-y-6">
      <PageHeader title={t('switch.title')} subtitle={t('switch.subtitle')} />
      {eligibility.eligible ? (
        <SwitchWizard
          workspaceId={workspaceId}
          base={base}
          accounts={accounts.map((a) => ({ id: a.id, name: a.name }))}
          categories={categories
            .filter((c) => c.entityId === personal?.id)
            .map((c) => ({ id: c.id, name: c.name, group: c.group, type: c.type }))}
        />
      ) : (
        <section className="card space-y-3" data-testid="switch-not-fresh">
          <h2 className="font-semibold">{t('switch.not_fresh_title')}</h2>
          <p className="text-sm">{t('switch.not_fresh', { count: eligibility.transactions })}</p>
          <Link href="/welcome?switch=1" className="btn-primary inline-flex">
            {t('switch.new_workspace')}
          </Link>
          <p className="text-sm text-muted">
            {t('switch.statements_instead')}{' '}
            <Link href={`${base}/import`} className="underline">
              {t('switch.open_import')}
            </Link>
          </p>
        </section>
      )}
    </div>
  );
}
