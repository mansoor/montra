'use client';

import { useRouter } from 'next/navigation';
import { useTransition } from 'react';

/**
 * The period Home's numbers are for, as a dropdown in the page subtitle (FLOW-01). Each option is a link to Home for
 * that period (the current one has no `?period=`), so picking one only changes the URL.
 */
export function PeriodSelect({
  label,
  options,
  value,
}: {
  label: string;
  options: { href: string; label: string }[];
  value: string;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <span className="relative -ml-1.5 inline-flex items-center">
      <select
        aria-label={label}
        data-testid="home-period-select"
        className="min-h-8 cursor-pointer appearance-none rounded-[var(--radius-m)] bg-transparent py-1 pr-7 pl-1.5 text-sm text-ink-soft hover:bg-canvas hover:text-ink aria-busy:opacity-60"
        aria-busy={pending || undefined}
        value={value}
        onChange={(e) => {
          const href = e.target.value;
          start(() => router.push(href));
        }}
      >
        {options.map((o) => (
          <option key={o.href} value={o.href}>
            {o.label}
          </option>
        ))}
      </select>
      <svg
        aria-hidden="true"
        viewBox="0 0 16 16"
        className="pointer-events-none absolute right-1.5 size-4 text-ink-soft"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M4 6l4 4 4-4" />
      </svg>
    </span>
  );
}
