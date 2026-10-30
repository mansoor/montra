import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { todayIn } from '@montra/domain';
import { load } from '@/lib/server-api';
import { getI18n } from '@/lib/i18n-server';
import { ProfileSettings } from '@/components/settings/profile-settings';
import { EntitySettings } from '@/components/settings/entity-settings';
import { FamilySettings } from '@/components/settings/family-settings';
import { AccountSettings } from '@/components/settings/account-settings';
import { SharingSettings } from '@/components/settings/sharing-settings';

export const metadata: Metadata = { title: 'Settings' };
export const dynamic = 'force-dynamic';

const TABS = {
  profile: 'settings.tab.profile',
  entities: 'settings.tab.entities',
  family: 'settings.tab.family',
  accounts: 'settings.tab.accounts',
  sharing: 'settings.tab.sharing',
} as const;
type Tab = keyof typeof TABS;

export default async function SettingsPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  const { workspaceId } = await params;
  const raw = (await searchParams).tab;
  const tab: Tab = raw && raw in TABS ? (raw as Tab) : 'profile';
  const workspace = await load((api) => api.getWorkspace(workspaceId));
  const base = `/w/${workspaceId}/settings`;
  const isOwner = workspace.role === 'owner';
  const { t } = await getI18n();

  let body: ReactNode;
  if (tab === 'profile') {
    const me = await load((api) => api.getMe());
    body = <ProfileSettings me={me} />;
  } else if (tab === 'entities') {
    const entities = await load((api) => api.listEntities(workspaceId));
    const history = await load((api) =>
      Promise.all(
        entities.map((e) => api.periodLockHistory(workspaceId, e.id).then((h) => [e.id, h] as const)),
      ),
    );
    body = (
      <EntitySettings
        workspaceId={workspaceId}
        entities={entities}
        history={Object.fromEntries(history)}
        isOwner={isOwner}
        today={todayIn(workspace.timeZone)}
      />
    );
  } else if (tab === 'family') {
    const [members, accounts] = await load((api) =>
      Promise.all([api.listFamilyMembers(workspaceId), api.listAccounts(workspaceId, { include: 'all' })]),
    );
    body = <FamilySettings workspaceId={workspaceId} members={members} accounts={accounts} />;
  } else if (tab === 'accounts') {
    const accounts = await load((api) => api.listAccounts(workspaceId, { include: 'all' }));
    body = <AccountSettings workspace={workspace} accounts={accounts} today={todayIn(workspace.timeZone)} />;
  } else {
    const [members, invites] = await load((api) =>
      Promise.all([
        api.listMembers(workspaceId),
        isOwner ? api.listInvites(workspaceId) : Promise.resolve([]),
      ]),
    );
    body = <SharingSettings workspace={workspace} members={members} invites={invites} isOwner={isOwner} />;
  }

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">{t('nav.settings')}</h1>
      <nav aria-label={t('settings.sections')}>
        <ul className="flex flex-wrap gap-1 border-b border-line pb-2">
          {(Object.keys(TABS) as Tab[]).map((k) => (
            <li key={k}>
              <Link
                href={`${base}?tab=${k}`}
                aria-current={tab === k ? 'page' : undefined}
                className={`rounded-md px-3 py-1.5 text-sm ${tab === k ? 'bg-brand-600 text-white' : 'hover:bg-brand-50'}`}
              >
                {t(TABS[k])}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      {body}
    </div>
  );
}
