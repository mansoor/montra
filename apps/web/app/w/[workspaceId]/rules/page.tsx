import type { Metadata } from 'next';
import { load } from '@/lib/server-api';
import { getI18n } from '@/lib/i18n-server';
import { RulesManager } from '@/components/rules/rules-manager';

export const metadata: Metadata = { title: 'Rules' };
export const dynamic = 'force-dynamic';

export default async function RulesPage({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params;
  const [workspace, rules, suggestions, accounts, categories, members] = await load((api) =>
    Promise.all([
      api.getWorkspace(workspaceId),
      api.listRules(workspaceId),
      api.listRuleSuggestions(workspaceId),
      api.listAccounts(workspaceId),
      api.listCategories(workspaceId),
      api.listFamilyMembers(workspaceId),
    ]),
  );
  const { t } = await getI18n();
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold">{t('rules.title')}</h1>
        <p className="text-sm text-muted">{t('rules.intro')}</p>
      </div>
      <RulesManager
        workspace={workspace}
        initialRules={rules}
        suggestions={suggestions}
        accounts={accounts}
        categories={categories}
        members={members}
      />
    </div>
  );
}
