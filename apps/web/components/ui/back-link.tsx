'use client';

import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { backHref, rememberUrl } from '@/lib/back-links';

const storage = () => {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
};

/** Notes every page's full URL as it's shown, so back links can return to it. Mounted once, in the root layout. */
export function RememberUrl() {
  const pathname = usePathname();
  const search = useSearchParams().toString();
  useEffect(() => {
    const store = storage();
    if (store && pathname) rememberUrl(store, pathname, search);
  }, [pathname, search]);
  return null;
}

/** For code that goes back to a list after an action (a delete, say): the list as it was left. */
export function listHref(href: string): string {
  const store = typeof window === 'undefined' ? null : storage();
  return store ? backHref(store, href) : href;
}

/**
 * A "← List" link that returns to the list with the filter or tab it was left on (lib/back-links.ts). It renders
 * `href` first, the same on the server and the client, then switches to the remembered URL once mounted.
 */
export function BackLink({
  href,
  className,
  children,
}: {
  href: string;
  className?: string;
  children: ReactNode;
}) {
  const [to, setTo] = useState(href);
  useEffect(() => {
    const store = storage();
    setTo(store ? backHref(store, href) : href);
  }, [href]);
  return (
    <Link href={to} className={className}>
      {children}
    </Link>
  );
}
