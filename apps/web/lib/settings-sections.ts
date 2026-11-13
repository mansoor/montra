/**
 * Settings sections (`settings?tab=…`) and the groups that appear as menu items under Settings in the sidebar. Each
 * group's page shows its sections as tabs.
 */
export const SETTINGS_TABS = {
  profile: 'settings.tab.profile',
  appearance: 'settings.tab.appearance',
  entities: 'settings.tab.entities',
  family: 'settings.tab.family',
  accounts: 'settings.tab.accounts',
  categories: 'settings.tab.categories',
  sharing: 'settings.tab.sharing',
  planning: 'settings.tab.planning',
  ai: 'settings.tab.ai',
  'ai-activity': 'settings.tab.ai_activity',
  notifications: 'settings.tab.notifications',
  security: 'settings.tab.security',
  data: 'settings.tab.data',
  storage: 'settings.tab.storage',
  privacy: 'settings.tab.privacy',
  billing: 'settings.tab.billing',
  support: 'settings.tab.support',
} as const;
export type SettingsTab = keyof typeof SETTINGS_TABS;

export interface SettingsGroup {
  key: 'you' | 'workspace' | 'ai' | 'data';
  label: string;
  tabs: SettingsTab[];
}

/** Grouped like the rest of the app: you, the workspace, AI, your data. */
export const SETTINGS_GROUPS: SettingsGroup[] = [
  { key: 'you', label: 'settings.group.you', tabs: ['profile', 'appearance', 'notifications', 'security'] },
  {
    key: 'workspace',
    label: 'settings.group.workspace',
    tabs: ['entities', 'family', 'accounts', 'categories', 'sharing', 'planning'],
  },
  { key: 'ai', label: 'settings.group.ai', tabs: ['ai', 'ai-activity'] },
  { key: 'data', label: 'settings.group.data', tabs: ['data', 'storage', 'privacy', 'support', 'billing'] },
];

/** Members (AUTH-17) see only their own settings: the workspace's setup isn't theirs to change. */
export const settingsGroupsFor = (role: string): SettingsGroup[] =>
  role === 'member' ? SETTINGS_GROUPS.filter((g) => g.key === 'you') : SETTINGS_GROUPS;

export const isSettingsTab = (raw: string | null | undefined): raw is SettingsTab =>
  Boolean(raw && Object.prototype.hasOwnProperty.call(SETTINGS_TABS, raw));

/** The tab a settings URL shows: the one asked for (if the role sees it), else Profile. */
export const settingsTabOf = (raw: string | null | undefined, role = 'owner'): SettingsTab =>
  isSettingsTab(raw) && settingsGroupsFor(role).some((g) => g.tabs.includes(raw)) ? raw : 'profile';

export const settingsGroupOf = (tab: SettingsTab): SettingsGroup =>
  SETTINGS_GROUPS.find((g) => g.tabs.includes(tab)) ?? SETTINGS_GROUPS[0]!;
