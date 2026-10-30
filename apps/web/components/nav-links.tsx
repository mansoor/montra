'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';

export function NavLinks({
  links,
  label,
}: {
  links: { href: string; label: string; exact?: boolean; badge?: ReactNode }[];
  label: string;
}) {
  const pathname = usePathname();
  return (
    <nav aria-label={label}>
      <ul className="flex flex-wrap gap-1">
        {links.map((l) => {
          const active = l.exact ? pathname === l.href : pathname.startsWith(l.href);
          return (
            <li key={l.href}>
              <Link
                href={l.href}
                aria-current={active ? 'page' : undefined}
                className={`rounded-md px-2 py-1 text-sm ${active ? 'bg-brand-50 font-medium text-brand-700' : 'text-muted hover:text-ink'}`}
              >
                {l.label}
                {l.badge}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
