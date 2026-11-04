'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import {
  ArrowLeftRight,
  BookOpen,
  CalendarClock,
  CalendarDays,
  ChartColumn,
  ChevronsLeft,
  ChevronsRight,
  CircleUserRound,
  FileText,
  FileUp,
  Flag,
  Home,
  Inbox,
  Lightbulb,
  ListChecks,
  LogOut,
  Menu,
  PiggyBank,
  Plus,
  Receipt,
  Repeat,
  Settings,
  ShieldCheck,
  Sparkles,
  Users,
  Wand2,
  Waves,
  X,
} from 'lucide-react';
import { ThemeChoiceControl } from '../theme-choice';
import { useI18n } from '../i18n';

/** Icons by name: server components pass names, not components, across the client boundary. */
const ICONS = {
  home: Home,
  transactions: ArrowLeftRight,
  review: ListChecks,
  receipts: Receipt,
  payslips: FileText,
  members: Users,
  upcoming: CalendarClock,
  recurring: Repeat,
  journal: BookOpen,
  imports: FileUp,
  rules: Wand2,
  insights: Lightbulb,
  add: Plus,
  settings: Settings,
  budget: PiggyBank,
  flow: Waves,
  goals: Flag,
  reports: ChartColumn,
  recommendations: Sparkles,
  calendar: CalendarDays,
  inbox: Inbox,
} as const;
export type IconName = keyof typeof ICONS;

export interface NavItem {
  href: string;
  label: string;
  icon: IconName;
  exact?: boolean;
  badge?: ReactNode;
}

export interface NavGroup {
  /** Omitted for the first, unlabeled group. */
  label?: string;
  items: NavItem[];
}

const COLLAPSED_KEY = 'montra.sidebar.collapsed';

/**
 * The workspace frame: a left sidebar (grouped sections, collapsible to an icon rail, a drawer on small
 * screens) and a slim top bar with live status, theme and the account menu. The nav keeps the accessible name
 * "Main" and plain link names, which the e2e tests and screen readers rely on.
 */
export function AppShell({
  workspaceName,
  homeHref,
  navLabel,
  groups,
  settingsHref,
  userName,
  userEmail,
  status,
  children,
}: {
  workspaceName: string;
  homeHref: string;
  navLabel: string;
  groups: NavGroup[];
  settingsHref: string;
  userName: string;
  userEmail: string;
  /** Live-update indicator (realtime). */
  status: ReactNode;
  children: ReactNode;
}) {
  const { t } = useI18n();
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);
  const [drawer, setDrawer] = useState(false);

  useEffect(() => {
    try {
      setCollapsed(localStorage.getItem(COLLAPSED_KEY) === '1');
    } catch {
      // Storage unavailable: start expanded.
    }
  }, []);
  // Navigating closes the drawer.
  useEffect(() => setDrawer(false), [pathname]);

  const toggle = () => {
    setCollapsed((c) => {
      try {
        localStorage.setItem(COLLAPSED_KEY, c ? '0' : '1');
      } catch {
        // ignore
      }
      return !c;
    });
  };

  const isActive = (i: Pick<NavItem, 'href' | 'exact'>) =>
    i.exact ? pathname === i.href : pathname === i.href || pathname.startsWith(`${i.href}/`);

  const sidebar = (rail: boolean) => (
    <div className="flex h-full flex-col">
      <Link
        href={homeHref}
        className={`flex items-center gap-3 px-4 pt-4 pb-3 ${rail ? 'justify-center px-0' : ''}`}
        aria-label={`Montra · ${workspaceName}`}
      >
        <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-[var(--radius-m)] bg-brand-600 text-on-brand">
          <ShieldCheck aria-hidden size={20} strokeWidth={1.8} />
        </span>
        {!rail && (
          <span className="min-w-0">
            <span className="block font-display text-[17px] leading-tight font-semibold">Montra</span>
            <span className="block truncate text-xs text-muted" aria-label={t('shell.workspace')}>
              {workspaceName}
            </span>
          </span>
        )}
      </Link>
      <nav aria-label={navLabel} className="flex-1 overflow-y-auto px-3 pb-3">
        {groups.map((g, gi) => (
          <div key={g.label ?? gi} className={gi > 0 ? 'mt-4' : 'mt-1'}>
            {g.label &&
              (rail ? (
                <div className="mx-2 mb-2 border-t border-line" aria-hidden />
              ) : (
                <div className="section-h mb-1 px-3">{g.label}</div>
              ))}
            <ul className="flex flex-col gap-0.5">
              {g.items.map((i) => (
                <li key={i.href}>
                  <SideLink item={i} active={isActive(i)} rail={rail} />
                </li>
              ))}
            </ul>
          </div>
        ))}
        <ul className="mt-4 flex flex-col gap-0.5 border-t border-line pt-3">
          <li>
            <SideLink
              item={{ href: settingsHref, label: t('nav.settings'), icon: 'settings' }}
              active={isActive({ href: settingsHref })}
              rail={rail}
            />
          </li>
        </ul>
      </nav>
    </div>
  );

  return (
    <div
      className="min-h-screen lg:grid lg:grid-cols-[var(--side-w)_minmax(0,1fr)]"
      style={{ ['--side-w' as string]: collapsed ? '72px' : '236px' }}
    >
      {/* Desktop sidebar */}
      <aside className="sticky top-0 hidden h-dvh border-r border-line bg-surface lg:block">
        <div className="flex h-full flex-col">
          <div className="min-h-0 flex-1">{sidebar(collapsed)}</div>
          <div className={`border-t border-line p-3 ${collapsed ? 'flex justify-center' : ''}`}>
            <button
              type="button"
              className="btn-ghost w-full justify-start"
              onClick={toggle}
              aria-expanded={!collapsed}
            >
              {collapsed ? (
                <ChevronsRight aria-hidden size={18} strokeWidth={1.8} />
              ) : (
                <ChevronsLeft aria-hidden size={18} strokeWidth={1.8} />
              )}
              <span className={collapsed ? 'sr-only' : undefined}>
                {collapsed ? t('shell.expand') : t('shell.collapse')}
              </span>
            </button>
          </div>
        </div>
      </aside>

      {/* Mobile drawer (its nav is only rendered while open, so there is one "Main" nav at a time) */}
      {drawer && (
        <div className="fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal="true" aria-label={navLabel}>
          <button
            type="button"
            className="absolute inset-0 bg-[var(--scrim)]"
            aria-label={t('shell.close_menu')}
            onClick={() => setDrawer(false)}
          />
          <aside className="absolute inset-y-0 left-0 w-72 max-w-[85vw] border-r border-line bg-surface shadow-xl">
            <button
              type="button"
              className="icon-btn absolute top-3 right-3"
              aria-label={t('shell.close_menu')}
              onClick={() => setDrawer(false)}
            >
              <X aria-hidden size={18} />
            </button>
            {sidebar(false)}
          </aside>
        </div>
      )}

      <div className="flex min-w-0 flex-col">
        <header className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b border-line bg-canvas/95 px-4 backdrop-blur lg:px-6">
          <button
            type="button"
            className="icon-btn lg:hidden"
            aria-label={t('shell.open_menu')}
            aria-expanded={drawer}
            onClick={() => setDrawer(true)}
          >
            <Menu aria-hidden size={20} strokeWidth={1.8} />
          </button>
          <span className="truncate font-display text-base font-semibold lg:hidden">Montra</span>
          <div className="ml-auto flex items-center gap-3">
            {status}
            <ThemeChoiceControl compact />
            <AccountMenu name={userName} email={userEmail} />
          </div>
        </header>
        <main id="main" className="min-w-0 flex-1 px-4 py-6 lg:px-8">
          <div className="mx-auto w-full max-w-[1200px]">{children}</div>
        </main>
      </div>
    </div>
  );
}

function SideLink({ item, active, rail }: { item: NavItem; active: boolean; rail: boolean }) {
  const Icon = ICONS[item.icon];
  return (
    <Link
      href={item.href}
      aria-current={active ? 'page' : undefined}
      title={rail ? item.label : undefined}
      className={`flex min-h-9 items-center gap-3 rounded-[var(--radius-m)] px-3 py-1.5 text-sm font-medium transition-colors ${
        rail ? 'justify-center px-0' : ''
      } ${active ? 'bg-brand-100 font-bold text-brand-600' : 'text-ink-soft hover:bg-canvas hover:text-ink'}`}
    >
      <Icon aria-hidden size={18} strokeWidth={1.8} className="shrink-0" />
      <span className={rail ? 'sr-only' : 'truncate'}>{item.label}</span>
      {!rail && item.badge}
    </Link>
  );
}

function AccountMenu({ name, email }: { name: string; email: string }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  useEffect(() => setOpen(false), [pathname]);
  return (
    <div className="relative">
      <button
        type="button"
        className="btn-ghost px-2"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <CircleUserRound aria-hidden size={20} strokeWidth={1.8} />
        <span className="hidden max-w-40 truncate sm:inline">{name || email}</span>
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 z-50 mt-2 w-64 rounded-[var(--radius-m)] border border-line bg-raised p-2 shadow-[0_8px_24px_var(--scrim)]"
        >
          <div className="px-2 py-1.5">
            <div className="truncate text-sm font-semibold">{name || email}</div>
            {name && <div className="truncate text-xs text-muted">{email}</div>}
          </div>
          <div className="my-1 border-t border-line" />
          <div className="px-2 py-1.5">
            <div className="mb-1.5 text-xs font-semibold text-muted">{t('theme.label')}</div>
            <ThemeChoiceControl />
          </div>
          <div className="my-1 border-t border-line" />
          <Link role="menuitem" href="/settings/security" className="btn-ghost w-full justify-start">
            <ShieldCheck aria-hidden size={16} strokeWidth={1.8} />
            {t('security.title')}
          </Link>
          <form action="/sign-out" method="post">
            <button role="menuitem" type="submit" className="btn-ghost w-full justify-start">
              <LogOut aria-hidden size={16} strokeWidth={1.8} />
              {t('shell.sign_out')}
            </button>
          </form>
        </div>
      )}
    </div>
  );
}
