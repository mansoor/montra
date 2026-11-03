'use client';

import { useI18n } from '../i18n';

export interface LineSeries {
  label: string;
  /** Minor units, one per x position. */
  values: readonly string[];
}

const W = 900;
const H = 240;
const PAD = { l: 64, r: 12, t: 12, b: 26 };

/**
 * A small dependency-free line chart for balances over time (forecast, net worth). Amounts are converted to
 * numbers for drawing only; labels are formatted from the exact minor units.
 */
export function LineChart({
  series,
  labels,
  currency,
  threshold,
  title,
}: {
  series: readonly LineSeries[];
  /** One label per x position (dates); only a few are drawn. */
  labels: readonly string[];
  currency: string;
  threshold?: string | null;
  title: string;
}) {
  const { money, date } = useI18n();
  const all = series.flatMap((s) => s.values.map(Number));
  if (threshold != null) all.push(Number(threshold));
  if (all.length === 0) return null;
  let min = Math.min(...all, 0);
  let max = Math.max(...all, 0);
  if (min === max) {
    min -= 1;
    max += 1;
  }
  const n = Math.max(1, labels.length - 1);
  const x = (i: number) => PAD.l + (i / n) * (W - PAD.l - PAD.r);
  const y = (v: number) => PAD.t + (1 - (v - min) / (max - min)) * (H - PAD.t - PAD.b);
  const ticks = [max, (max + min) / 2, min];
  const every = Math.max(1, Math.ceil(labels.length / 6));
  return (
    <figure className="w-full">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={title} className="h-auto w-full">
        {ticks.map((v, i) => (
          <g key={i}>
            <line
              x1={PAD.l}
              x2={W - PAD.r}
              y1={y(v)}
              y2={y(v)}
              stroke="var(--border)"
              strokeDasharray="2 4"
            />
            <text x={PAD.l - 6} y={y(v) + 4} textAnchor="end" fontSize="10" fill="var(--ink-muted)">
              {money(BigInt(Math.trunc(v)), currency)}
            </text>
          </g>
        ))}
        {min < 0 && max > 0 && (
          <line x1={PAD.l} x2={W - PAD.r} y1={y(0)} y2={y(0)} stroke="var(--border-strong)" />
        )}
        {threshold != null && (
          <line
            x1={PAD.l}
            x2={W - PAD.r}
            y1={y(Number(threshold))}
            y2={y(Number(threshold))}
            stroke="var(--bad)"
            strokeDasharray="4 3"
          />
        )}
        {series.map((s, si) => (
          <polyline
            key={s.label}
            fill="none"
            stroke={`var(--chart-${(si % 8) + 1})`}
            strokeWidth="2"
            strokeLinejoin="round"
            points={s.values.map((v, i) => `${x(i)},${y(Number(v))}`).join(' ')}
          />
        ))}
        {labels.map((l, i) =>
          i % every === 0 || i === labels.length - 1 ? (
            <text key={i} x={x(i)} y={H - 8} textAnchor="middle" fontSize="10" fill="var(--ink-muted)">
              {/^\d{4}-\d{2}-\d{2}$/.test(l) ? date(l) : l}
            </text>
          ) : null,
        )}
      </svg>
      {series.length > 1 && (
        <figcaption className="mt-1 flex flex-wrap gap-3 text-xs text-muted">
          {series.map((s, si) => (
            <span key={s.label} className="inline-flex items-center gap-1">
              <span
                className="inline-block size-2 rounded-full"
                style={{ background: `var(--chart-${(si % 8) + 1})` }}
              />
              {s.label}
            </span>
          ))}
        </figcaption>
      )}
    </figure>
  );
}

/** A thin progress bar: spent vs budget, with an optional marker for "where you should be today". */
export function ProgressBar({
  percent,
  marker,
  tone = 'brand',
  label,
}: {
  percent: number;
  marker?: number | null;
  tone?: 'brand' | 'bad' | 'warn' | 'good';
  label: string;
}) {
  const fill = { brand: 'bg-brand-600', bad: 'bg-bad', warn: 'bg-warn', good: 'bg-good' }[tone];
  return (
    <div
      className="relative h-2 w-full overflow-hidden rounded-full bg-sunken"
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.trunc(percent)}
    >
      <div
        className={`h-full rounded-full ${fill}`}
        style={{ width: `${Math.min(100, Math.max(0, percent))}%` }}
      />
      {marker != null && (
        <div
          className="absolute inset-y-0 w-0.5 bg-ink/70"
          style={{ left: `${Math.min(100, Math.max(0, marker))}%` }}
        />
      )}
    </div>
  );
}
