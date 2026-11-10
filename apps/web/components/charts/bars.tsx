'use client';

import Link from 'next/link';
import { barShares, sharePercent } from '@montra/domain';
import { useI18n } from '../i18n';

export interface BarRow {
  key: string;
  label: string;
  amount: string;
  href?: string;
}

/** Amounts that only go one way, largest first: where the money went. With a total, each shows its share. */
export function BarList({
  rows,
  currency,
  total,
  title,
}: {
  rows: readonly BarRow[];
  currency: string;
  total?: string;
  title: string;
}) {
  const { money } = useI18n();
  const widths = barShares(rows.map((r) => BigInt(r.amount)));
  return (
    <ul aria-label={title} className="space-y-2.5">
      {rows.map((r, i) => (
        <li key={r.key}>
          <div className="flex items-baseline justify-between gap-2 text-sm">
            <Name row={r} />
            <span className="shrink-0 tabular-nums">
              {money(BigInt(r.amount), currency)}
              {total !== undefined && (
                <span className="ml-1.5 text-xs text-muted">
                  {sharePercent(BigInt(r.amount), BigInt(total))}%
                </span>
              )}
            </span>
          </div>
          <div className="mt-1 h-2 w-full rounded-full bg-sunken" aria-hidden>
            <div className="h-full rounded-full bg-brand-600" style={{ width: `${widths[i]}%` }} />
          </div>
        </li>
      ))}
    </ul>
  );
}

export interface DeviationRow extends BarRow {
  /** Signed: positive is more spending than expected (over), negative less (under). */
  difference: string;
  /** A line under the name, such as "$200 of $1,000". */
  detail?: string;
}

/**
 * Differences either way from a middle line: over (more spending) to the right in red, under to the left in green.
 * Each row also says it in words, so the colour is never the only cue.
 */
export function DeviationBars({
  rows,
  currency,
  title,
  overKey,
  underKey,
}: {
  rows: readonly DeviationRow[];
  currency: string;
  title: string;
  /** Message keys for a positive and a negative difference, given `{amount}`. Keys, as server pages can't pass functions. */
  overKey: string;
  underKey: string;
}) {
  const { money, t } = useI18n();
  const widths = barShares(rows.map((r) => BigInt(r.difference)));
  return (
    <ul aria-label={title} className="space-y-2.5">
      {rows.map((r, i) => {
        const d = BigInt(r.difference);
        const words =
          d > 0n ? t(overKey, { amount: money(d, currency) }) : t(underKey, { amount: money(-d, currency) });
        return (
          <li key={r.key}>
            <div className="flex items-baseline justify-between gap-2 text-sm">
              <span className="min-w-0">
                <Name row={r} />
                {r.detail && <span className="block text-xs text-muted">{r.detail}</span>}
              </span>
              <span className={`shrink-0 text-sm font-medium ${d > 0n ? 'text-bad' : 'text-good'}`}>
                {words}
              </span>
            </div>
            <div className="mt-1 flex h-2 w-full" aria-hidden>
              <div className="flex w-1/2 justify-end rounded-l-full bg-sunken">
                {d < 0n && (
                  <div className="h-full rounded-l-full bg-good" style={{ width: `${widths[i]}%` }} />
                )}
              </div>
              <div className="w-px bg-ink/40" />
              <div className="flex w-1/2 rounded-r-full bg-sunken">
                {d > 0n && (
                  <div className="h-full rounded-r-full bg-bad" style={{ width: `${widths[i]}%` }} />
                )}
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function Name({ row }: { row: BarRow }) {
  return row.href ? (
    <Link href={row.href} className="truncate font-medium hover:underline">
      {row.label}
    </Link>
  ) : (
    <span className="truncate font-medium">{row.label}</span>
  );
}
