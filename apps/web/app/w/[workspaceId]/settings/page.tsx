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
import { AiSettings } from '@/components/ai/ai-settings';
import { AiActivity } from '@/components/ai/ai-activity';
import { ThemeChoiceControl } from '@/components/theme-choice';

export const metadata: Metadata = { title: 'Settings' };
export const dynamic = 'force-dynamic';

const TABS = {
  profile: 'settings.tab.profile',
  appearance: 'settings.tab.appearance',
  entities: 'settings.tab.entities',
  family: 'settings.tab.family',
  accounts: 'settings.tab.accounts',
  sharing: 'settings.tab.sharing',
  ai: 'settings.tab.ai',
  'ai-activity': 'settings.tab.ai_activity',
} as const;
type Tab = keyof typeof TABS;

/** Sections grouped like the rest of the app: you, the workspace, AI. */
const GROUPS: { label: string; tabs: Tab[] }[] = [
  { label: 'settings.group.you', tabs: ['profile', 'appearance'] },
  { label: 'settings.group.workspace', tabs: ['entities', 'family', 'accounts', 'sharing'] },
  { label: 'settings.group.ai', tabs: ['ai', 'ai-activity'] },
];

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
  } else if (tab === 'appearance') {
    body = (
      <section className="card max-w-xl space-y-3">
        <h2 className="text-base font-semibold">{t('settings.appearance.theme')}</h2>
        <p className="text-sm text-muted">{t('settings.appearance.theme_hint')}</p>
        <ThemeChoiceControl />
      </section>
    );
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
  } else if (tab === 'ai') {
    const settings = await load((api) => api.getAiSettings(workspaceId));
    body = <AiSettings workspaceId={workspaceId} initial={settings} isOwner={isOwner} />;
  } else if (tab === 'ai-activity') {
    body = <AiActivity workspaceId={workspaceId} />;
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
    <div className="space-y-5">
      <header>
        <h1 className="page-title">{t('nav.settings')}</h1>
      </header>
      <div className="grid gap-6 lg:grid-cols-[220px_minmax(0,1fr)]">
        <nav aria-label={t('settings.sections')} className="lg:sticky lg:top-20 lg:self-start">
          <div className="tabs lg:hidden">
            {GROUPS.flatMap((g) => g.tabs).map((k) => (
              <Link
                key={k}
                href={`${base}?tab=${k}`}
                aria-current={tab === k ? 'page' : undefined}
                className="tab"
              >
                {t(TABS[k])}
              </Link>
            ))}
          </div>
          <div className="hidden space-y-5 lg:block">
            {GROUPS.map((g) => (
              <div key={g.label}>
                <div className="section-h mb-1.5 px-3">{t(g.label)}</div>
                <ul className="space-y-0.5">
                  {g.tabs.map((k) => (
                    <li key={k}>
                      <Link
                        href={`${base}?tab=${k}`}
                        aria-current={tab === k ? 'page' : undefined}
                        className="subnav-link"
                      >
                        {t(TABS[k])}
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </nav>
        <div className="min-w-0">{body}</div>
      </div>
    </div>
  );
}
