'use client';

import { useId, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { niceTicks } from '@/lib/loan-charts';
import { useI18n } from '../i18n';

export interface ColumnSeries {
  label: string;
  /** A chart token, such as `var(--chart-3)`. */
  color: string;
}

export interface TooltipLine {
  label: string;
  value: string;
  /** Keys the line to a series with a short stroke of its colour. */
  series?: number;
}

export interface Column {
  key: string;
  /** Minor units, one per series, stacked bottom up. */
  values: readonly bigint[];
  /** Drawn lighter: still to come. */
  faded: boolean;
  /** Under the axis; blank for none. Labels too close to the last one shown give way. */
  axisLabel: string;
  title: string;
  lines: readonly TooltipLine[];
}

const W = 900;
const H = 240;
const PAD = { l: 68, r: 12, t: 22, b: 26 };
/** Bars are never thicker than this, and touching marks keep a gap of the surface between them. */
const MAX_BAR = 24;
const GAP = 2;
const RADIUS = 4;
/** The least room between two axis labels, in viewBox units. */
const LABEL_ROOM = 56;

/** A column whose data end is rounded and whose foot stays square on the baseline. */
function topRounded(x: number, y: number, w: number, h: number): string {
  const r = Math.min(RADIUS, w / 2, h);
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

/**
 * Stacked columns, one per period, dependency-free like the other charts here. Each column is its own hover target
 * (its full band, not just the painted part); the arrow keys move between columns when the chart has focus, and the
 * readout is announced. Amounts are numbers for drawing only; every label comes from exact minor units.
 */
export function StackedColumns({
  series,
  columns,
  currency,
  title,
  marker,
  caption,
}: {
  series: readonly ColumnSeries[];
  columns: readonly Column[];
  currency: string;
  /** The chart's accessible name: what it shows, in words. */
  title: string;
  /** A labelled line before column `index`, such as "Today". */
  marker?: { index: number; label: string } | null;
  caption?: string;
}) {
  const { money, t } = useI18n();
  const [active, setActive] = useState<number | null>(null);
  const readout = useId();
  if (columns.length === 0) return null;
  const totals = columns.map((c) => c.values.reduce((s, v) => s + (v > 0n ? v : 0n), 0n));
  const ticks = niceTicks(Number(totals.reduce((m, v) => (v > m ? v : m), 0n)));
  const top = ticks[ticks.length - 1]!;
  const plotW = W - PAD.l - PAD.r;
  const plotH = H - PAD.t - PAD.b;
  const band = plotW / columns.length;
  const barW = Math.max(1, Math.min(MAX_BAR, band - GAP));
  const x = (i: number) => PAD.l + i * band + (band - barW) / 2;
  const y = (v: number) => PAD.t + (1 - v / top) * plotH;
  let lastLabel = -Infinity;
  const shown = columns.map((c, i) => {
    const at = PAD.l + i * band + band / 2;
    if (!c.axisLabel || at - lastLabel < LABEL_ROOM || at > W - PAD.r - LABEL_ROOM / 2) return false;
    lastLabel = at;
    return true;
  });
  const current = active === null ? null : columns[active];

  const pick = (e: PointerEvent<SVGSVGElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    const vx = ((e.clientX - box.left) / box.width) * W;
    const i = Math.floor((vx - PAD.l) / band);
    setActive(i >= 0 && i < columns.length ? i : null);
  };
  const keys = (e: KeyboardEvent<HTMLDivElement>) => {
    const last = columns.length - 1;
    const from = active ?? -1;
    const to =
      e.key === 'ArrowRight'
        ? Math.min(last, from + 1)
        : e.key === 'ArrowLeft'
          ? Math.max(0, from < 0 ? last : from - 1)
          : e.key === 'Home'
            ? 0
            : e.key === 'End'
              ? last
              : e.key === 'Escape'
                ? null
                : undefined;
    if (to === undefined) return;
    e.preventDefault();
    setActive(to);
  };

  return (
    <figure className="w-full">
      <div
        className="relative rounded-[var(--radius-s)]"
        tabIndex={0}
        role="group"
        aria-label={`${title} ${t('charts.keys_hint')}`}
        aria-describedby={readout}
        onKeyDown={keys}
        onBlur={() => setActive(null)}
      >
        <svg
          viewBox={`0 0 ${W} ${H}`}
          role="img"
          aria-label={title}
          className="h-auto w-full touch-pan-y"
          onPointerMove={pick}
          onPointerDown={pick}
          onPointerLeave={() => setActive(null)}
        >
          {ticks.map((v) => (
            <g key={v}>
              <line x1={PAD.l} x2={W - PAD.r} y1={y(v)} y2={y(v)} stroke="var(--border)" />
              <text x={PAD.l - 6} y={y(v) + 4} textAnchor="end" fontSize="10" fill="var(--ink-muted)">
                {money(BigInt(Math.trunc(v)), currency)}
              </text>
            </g>
          ))}
          {active !== null && (
            <rect
              x={PAD.l + active * band}
              y={PAD.t}
              width={band}
              height={plotH}
              fill="var(--sunken)"
              data-testid="chart-active-band"
            />
          )}
          {columns.map((c, i) => {
            let base = 0;
            const parts = c.values.map((v, s) => ({ v: Number(v > 0n ? v : 0n), s })).filter((p) => p.v > 0);
            return (
              <g key={c.key} opacity={c.faded && active !== i ? 0.45 : 1} data-faded={c.faded || undefined}>
                {parts.map((p, pi) => {
                  const y0 = y(base);
                  base += p.v;
                  const y1 = y(base);
                  const lastPart = pi === parts.length - 1;
                  // The surface gap sits on top of every segment but the last.
                  const h = Math.max(0, y0 - y1 - (lastPart ? 0 : GAP));
                  const yTop = lastPart ? y1 : y1 + GAP;
                  return lastPart ? (
                    <path key={p.s} d={topRounded(x(i), yTop, barW, h)} fill={series[p.s]!.color} />
                  ) : (
                    <rect key={p.s} x={x(i)} y={yTop} width={barW} height={h} fill={series[p.s]!.color} />
                  );
                })}
              </g>
            );
          })}
          <line x1={PAD.l} x2={W - PAD.r} y1={y(0)} y2={y(0)} stroke="var(--border-strong)" />
          {marker && (
            <g data-testid="chart-marker">
              <line
                x1={PAD.l + marker.index * band}
                x2={PAD.l + marker.index * band}
                y1={PAD.t - 4}
                y2={y(0)}
                stroke="var(--ink-soft)"
              />
              <text
                x={PAD.l + marker.index * band}
                y={PAD.t - 8}
                textAnchor={marker.index === 0 ? 'start' : marker.index === columns.length ? 'end' : 'middle'}
                fontSize="10"
                fill="var(--ink-soft)"
              >
                {marker.label}
              </text>
            </g>
          )}
          {columns.map((c, i) =>
            shown[i] ? (
              <text
                key={c.key}
                x={PAD.l + i * band + band / 2}
                y={H - 8}
                textAnchor="middle"
                fontSize="10"
                fill="var(--ink-muted)"
              >
                {c.axisLabel}
              </text>
            ) : null,
          )}
        </svg>
        <div
          id={readout}
          aria-live="polite"
          className={
            current
              ? 'pointer-events-none absolute top-0 z-10 w-max max-w-[16rem] rounded-[var(--radius-s)] border border-line bg-surface p-2 text-xs shadow-md'
              : 'sr-only'
          }
          style={
            current && active !== null
              ? active / columns.length > 0.5
                ? { right: `${100 - ((PAD.l + active * band) / W) * 100 + 1}%` }
                : { left: `${((PAD.l + (active + 1) * band) / W) * 100 + 1}%` }
              : undefined
          }
          data-testid="chart-tooltip"
        >
          {current && (
            <>
              <p className="mb-1 font-semibold text-ink">{current.title}</p>
              <dl className="space-y-0.5">
                {current.lines.map((l) => (
                  <div key={l.label} className="flex items-center gap-2">
                    {l.series !== undefined ? (
                      <span
                        aria-hidden
                        className="inline-block h-0.5 w-3 rounded-full"
                        style={{ background: series[l.series]!.color }}
                      />
                    ) : (
                      <span aria-hidden className="inline-block w-3" />
                    )}
                    {/* Values lead, labels follow. */}
                    <dt className="order-last text-muted">{l.label}</dt>
                    <dd className="font-semibold tabular-nums text-ink">{l.value}</dd>
                  </div>
                ))}
              </dl>
            </>
          )}
        </div>
      </div>
      <figcaption className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
        {series.map((s) => (
          <span key={s.label} className="inline-flex items-center gap-1.5">
            <span aria-hidden className="inline-block size-2.5 rounded-sm" style={{ background: s.color }} />
            {s.label}
          </span>
        ))}
        {caption && <span>{caption}</span>}
      </figcaption>
    </figure>
  );
}
