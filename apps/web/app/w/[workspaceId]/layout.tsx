import type { ReactNode } from 'react';
import { load } from '@/lib/server-api';
import { getI18n } from '@/lib/i18n-server';
import { API_URL } from '@/lib/session';
import { Realtime } from '@/components/realtime';
import { I18nProvider } from '@/components/i18n';
import { GlobalShortcuts, ReviewCountBadge } from '@/components/review/review-badge';
import { LocalAiRunner } from '@/components/ai/local-ai-runner';
import { AppShell, type NavGroup } from '@/components/shell/app-shell';
import { GlobalSearchBox, NotificationBell } from '@/components/shell/header-tools';

export const dynamic = 'force-dynamic';

/** Browser WebSocket endpoint: NEXT_PUBLIC_API_WS_URL, else derived from the API URL at runtime. */
const wsUrl = () => process.env.NEXT_PUBLIC_API_WS_URL ?? `${API_URL.replace(/^http/, 'ws')}/v1/ws`;

export default async function WorkspaceLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  const [workspace, { me, t }] = await Promise.all([load((api) => api.getWorkspace(workspaceId)), getI18n()]);
  const base = `/w/${workspace.id}`;
  const groups: NavGroup[] = [
    { items: [{ href: base, label: t('nav.home'), icon: 'home', exact: true }] },
    {
      label: t('nav.group.plan'),
      items: [
        { href: `${base}/budget`, label: t('nav.budget'), icon: 'budget' },
        { href: `${base}/goals`, label: t('nav.goals'), icon: 'goals' },
        { href: `${base}/cash-flow`, label: t('nav.cash_flow'), icon: 'flow' },
        { href: `${base}/calendar`, label: t('nav.calendar'), icon: 'calendar' },
        { href: `${base}/suggestions`, label: t('nav.suggestions'), icon: 'recommendations' },
      ],
    },
    {
      label: t('nav.group.money'),
      items: [
        { href: `${base}/transactions`, label: t('nav.transactions'), icon: 'transactions' },
        {
          href: `${base}/review`,
          label: t('nav.review'),
          icon: 'review',
          badge: <ReviewCountBadge workspaceId={workspace.id} />,
        },
        { href: `${base}/receipts`, label: t('nav.receipts'), icon: 'receipts' },
        { href: `${base}/payslips`, label: t('nav.payslips'), icon: 'payslips' },
        { href: `${base}/upcoming`, label: t('nav.upcoming'), icon: 'upcoming' },
        { href: `${base}/recurring`, label: t('nav.recurring'), icon: 'recurring' },
        { href: `${base}/accounts/new`, label: t('nav.add_account'), icon: 'add' },
      ],
    },
    {
      label: t('nav.group.books'),
      items: [
        // BIZ-01: only with a business this login can see.
        ...(workspace.entities.some((e) => e.type === 'business')
          ? [{ href: `${base}/business`, label: t('nav.business'), icon: 'business' as const }]
          : []),
        // RNT-01: likewise for a rental portfolio.
        ...(workspace.entities.some((e) => e.type === 'rental')
          ? [{ href: `${base}/rentals`, label: t('nav.rentals'), icon: 'rentals' as const }]
          : []),
        { href: `${base}/reports`, label: t('nav.reports'), icon: 'reports' },
        { href: `${base}/ask`, label: t('nav.ask'), icon: 'ask' },
        { href: `${base}/journal`, label: t('nav.journal'), icon: 'journal' },
        { href: `${base}/imports`, label: t('nav.imports'), icon: 'imports' },
        { href: `${base}/rules`, label: t('nav.rules'), icon: 'rules' },
        { href: `${base}/members`, label: t('nav.by_member'), icon: 'members' },
        { href: `${base}/insights`, label: t('nav.insights'), icon: 'insights' },
      ],
    },
  ];
  return (
    <I18nProvider locale={me.locale} dateFormat={me.dateFormat}>
      <AppShell
        workspaceName={workspace.name}
        homeHref={base}
        navLabel={t('shell.nav')}
        groups={groups}
        settingsHref={`${base}/settings`}
        userName={me.displayName}
        userEmail={me.email}
        status={<Realtime workspaceId={workspace.id} wsUrl={wsUrl()} />}
        tools={
          <>
            <GlobalSearchBox workspaceId={workspace.id} />
            <NotificationBell workspaceId={workspace.id} />
          </>
        }
      >
        <GlobalShortcuts workspaceId={workspace.id} />
        <LocalAiRunner workspaceId={workspace.id} />
        {children}
      </AppShell>
    </I18nProvider>
  );
}
