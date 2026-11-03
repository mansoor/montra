import Link from 'next/link';
import type { ReactNode } from 'react';

/** The same header on every screen: title, optional subtitle and back link, actions on the right. */
export function PageHeader({
  title,
  subtitle,
  actions,
  back,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  back?: { href: string; label: string };
}) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        {back && (
          <Link href={back.href} className="mb-1 inline-block text-sm text-muted hover:text-ink">
            ← {back.label}
          </Link>
        )}
        <h1 className="page-title">{title}</h1>
        {subtitle && <p className="page-subtitle">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}

/** Underline tabs that are links (each tab its own URL). */
export function LinkTabs({
  label,
  tabs,
  current,
}: {
  label: string;
  tabs: { key: string; href: string; label: string }[];
  current: string;
}) {
  return (
    <nav aria-label={label} className="tabs">
      {tabs.map((t) => (
        <Link key={t.key} href={t.href} aria-current={t.key === current ? 'page' : undefined} className="tab">
          {t.label}
        </Link>
      ))}
    </nav>
  );
}

/** A headline number with a label, an optional hint and an optional link to the transactions behind it. */
export function StatTile({
  label,
  value,
  hint,
  href,
  tone,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  href?: string;
  tone?: 'good' | 'bad' | 'warn';
}) {
  const body = (
    <>
      <div className="text-xs font-semibold text-muted">{label}</div>
      <div
        className={`mt-1 font-display text-2xl font-semibold ${tone === 'bad' ? 'text-bad' : tone === 'warn' ? 'text-warn' : tone === 'good' ? 'text-good' : ''}`}
      >
        {value}
      </div>
      {hint && <div className="mt-0.5 text-xs text-muted">{hint}</div>}
    </>
  );
  return href ? (
    <Link href={href} className="card block transition-colors hover:border-line-strong hover:bg-canvas">
      {body}
    </Link>
  ) : (
    <div className="card">{body}</div>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="card py-10 text-center">
      <p className="font-semibold">{title}</p>
      {children && <div className="mt-2 text-sm text-muted">{children}</div>}
    </div>
  );
}
