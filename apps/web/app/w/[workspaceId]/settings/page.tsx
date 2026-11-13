import { BillingPanel, SupportAccessPanel } from '@/components/settings/billing-support';
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
import { PlanningSettings } from '@/components/settings/planning-settings';
import { NotificationSettings } from '@/components/settings/notification-settings';
import { PrivacyPanel, SecurityActivity } from '@/components/settings/privacy-security';
import { StorageSettings } from '@/components/settings/storage-settings';
import { CategorySettings } from '@/components/settings/category-settings';
import { SETTINGS_TABS, settingsGroupOf, settingsTabOf } from '@/lib/settings-sections';
import { isAdminRole } from '@/lib/settings';
import {
  BackupPanel,
  DeleteAccountPanel,
  RestorePanel,
  StorageMeter,
} from '@/components/settings/data-settings';

export const metadata: Metadata = { title: 'Settings' };
export const dynamic = 'force-dynamic';

export default async function SettingsPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  const { workspaceId } = await params;
  const workspace = await load((api) => api.getWorkspace(workspaceId));
  const tab = settingsTabOf((await searchParams).tab, workspace.role);
  const group = settingsGroupOf(tab);
  const base = `/w/${workspaceId}/settings`;
  // Owners and admins manage the workspace (AUTH-14).
  const isOwner = isAdminRole(workspace.role);
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
    const [members, accounts, logins, invites] = await load((api) =>
      Promise.all([
        api.listFamilyMembers(workspaceId),
        api.listAccounts(workspaceId, { include: 'all' }),
        api.listMembers(workspaceId),
        isOwner ? api.listInvites(workspaceId) : Promise.resolve([]),
      ]),
    );
    body = (
      <FamilySettings
        workspace={workspace}
        members={members}
        accounts={accounts}
        logins={logins}
        invites={invites}
      />
    );
  } else if (tab === 'accounts') {
    const accounts = await load((api) => api.listAccounts(workspaceId, { include: 'all' }));
    body = <AccountSettings workspace={workspace} accounts={accounts} today={todayIn(workspace.timeZone)} />;
  } else if (tab === 'categories') {
    const entities = await load((api) => api.listEntities(workspaceId));
    const has = (type: string) => entities.some((e) => e.type === type);
    const [categories, groups, business, rental] = await load((api) =>
      Promise.all([
        api.listCategories(workspaceId, undefined, { includeArchived: true }),
        api.listCategoryGroups(workspaceId),
        has('business') ? api.listTaxLines(workspaceId, 'schedule_c') : Promise.resolve([]),
        has('rental') ? api.listTaxLines(workspaceId, 'schedule_e') : Promise.resolve([]),
      ]),
    );
    body = (
      <CategorySettings
        workspaceId={workspaceId}
        entities={entities}
        categories={categories}
        groups={groups}
        taxLines={{ business, rental }}
      />
    );
  } else if (tab === 'ai') {
    const settings = await load((api) => api.getAiSettings(workspaceId));
    body = <AiSettings workspaceId={workspaceId} initial={settings} isOwner={isOwner} />;
  } else if (tab === 'planning') {
    const [settings, categories] = await load((api) =>
      Promise.all([api.getPlanningSettings(workspaceId), api.listCategories(workspaceId)]),
    );
    body = (
      <PlanningSettings
        workspaceId={workspaceId}
        initial={settings}
        categories={categories}
        currency={workspace.baseCurrency}
      />
    );
  } else if (tab === 'ai-activity') {
    body = <AiActivity workspaceId={workspaceId} />;
  } else if (tab === 'notifications') {
    const prefs = await load((api) => api.getNotificationPrefs());
    const baseCurrency = workspace.entities[0]?.functionalCurrency ?? 'USD';
    body = <NotificationSettings initial={prefs} currency={baseCurrency} />;
  } else if (tab === 'security') {
    const events = await load((api) => api.getSecurityActivity());
    body = <SecurityActivity events={events} />;
  } else if (tab === 'data') {
    const [usage, jobs, schedule, restores, deletion, destination] = await load((api) =>
      Promise.all([
        api.getStorageUsage(workspaceId),
        api.listBackups(workspaceId),
        api.getBackupSchedule(workspaceId),
        api.listRestores(),
        api.getDeletionStatus(),
        isOwner ? api.getStorageDestination(workspaceId) : Promise.resolve(null),
      ]),
    );
    body = (
      <div className="space-y-5">
        <StorageMeter usage={usage} />
        <BackupPanel workspace={workspace} jobs={jobs} schedule={schedule} destination={destination} />
        <RestorePanel workspace={workspace} restores={restores} />
        <section className="card flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm">{t('data.trash_hint')}</p>
          <Link className="btn-secondary" href={`/w/${workspaceId}/trash`}>
            {t('data.open_trash')}
          </Link>
        </section>
        <DeleteAccountPanel status={deletion} />
      </div>
    );
  } else if (tab === 'storage') {
    const [destination, failed] = isOwner
      ? await load((api) =>
          Promise.all([api.getStorageDestination(workspaceId), api.listStorageItems(workspaceId, 'failed')]),
        )
      : [null, []];
    body = <StorageSettings workspace={workspace} destination={destination} failed={failed} />;
  } else if (tab === 'billing') {
    body = (
      <BillingPanel workspaceId={workspaceId} billing={await load((api) => api.getBilling(workspaceId))} />
    );
  } else if (tab === 'support') {
    body = (
      <SupportAccessPanel
        workspaceId={workspaceId}
        grants={await load((api) => api.listSupportGrants(workspaceId))}
        canManage={isOwner}
      />
    );
  } else if (tab === 'privacy') {
    const settings = await load((api) => api.getAiSettings(workspaceId));
    body = <PrivacyPanel disclosures={settings.disclosures} currentMode={settings.mode} />;
  } else {
    const [members, invites, family, me] = await load((api) =>
      Promise.all([
        api.listMembers(workspaceId),
        isOwner ? api.listInvites(workspaceId) : Promise.resolve([]),
        api.listFamilyMembers(workspaceId),
        api.getMe(),
      ]),
    );
    body = (
      <SharingSettings
        workspace={workspace}
        members={members}
        invites={invites}
        family={family}
        currentUserId={me.id}
      />
    );
  }

  return (
    <div className="space-y-5">
      <header>
        <h1 className="page-title">
          {t('nav.settings')}
          <span className="text-muted"> · {t(group.label)}</span>
        </h1>
      </header>
      {/* The group's sections as tabs; the groups themselves are menu items under Settings in the sidebar. */}
      <nav aria-label={t('settings.sections')} className="settings-tabs">
        {group.tabs.map((k) => (
          <Link
            key={k}
            href={`${base}?tab=${k}`}
            aria-current={tab === k ? 'page' : undefined}
            className="settings-tab"
          >
            {t(SETTINGS_TABS[k])}
          </Link>
        ))}
      </nav>
      <div className="min-w-0">{body}</div>
    </div>
  );
}
