'use client';

import { useId, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { calendarDate, diffDays } from '@montra/domain';
import { niceTicks } from '@/lib/loan-charts';
import { useI18n } from '../i18n';

export interface DatedValue {
  date: string;
  /** Minor units. */
  value: bigint;
}

const W = 900;
const H = 240;
const PAD = { l: 68, r: 12, t: 22, b: 26 };
const COLOR = 'var(--chart-1)';

/**
 * A balance over real time: what happened as a solid line, and where it's heading as a dashed one from the same point,
 * with a label at the end (a loan's "Paid off Sep 2031"). The x axis is days, so a projection's monthly points and the
 * history's daily or weekly ones share one scale. The crosshair snaps to the nearest point under the pointer, and the
 * arrow keys step through the points when the chart has focus.
 */
export function ProjectedLine({
  actual,
  projected,
  currency,
  title,
  endLabel,
  marker,
  projectedLabel,
}: {
  actual: readonly DatedValue[];
  projected: readonly DatedValue[];
  currency: string;
  title: string;
  endLabel?: string | null;
  /** A labelled day, such as today. */
  marker?: { date: string; label: string } | null;
  /** Said with a projected point's value in the readout. */
  projectedLabel: string;
}) {
  const { money, date, locale, t } = useI18n();
  const [active, setActive] = useState<number | null>(null);
  const readout = useId();
  const points = [
    ...actual.map((p) => ({ ...p, projected: false })),
    // The projection starts where the history ends, so its first point isn't a second stop for the crosshair.
    ...projected
      .filter((p, i) => !(i === 0 && actual.length > 0 && actual[actual.length - 1]!.date === p.date))
      .map((p) => ({ ...p, projected: true })),
  ];
  if (points.length === 0) return null;
  const day = (d: string) => diffDays(calendarDate(d), calendarDate(points[0]!.date));
  const span = Math.max(1, day(points[points.length - 1]!.date));
  const ticks = niceTicks(Number(points.reduce((m, p) => (p.value > m ? p.value : m), 0n)));
  const top = Math.max(1, ticks[ticks.length - 1]!);
  const x = (d: string) => PAD.l + (day(d) / span) * (W - PAD.l - PAD.r);
  const y = (v: bigint) => PAD.t + (1 - Number(v) / top) * (H - PAD.t - PAD.b);
  const line = (ps: readonly DatedValue[]) => ps.map((p) => `${x(p.date)},${y(p.value)}`).join(' ');
  const monthYear = new Intl.DateTimeFormat(locale, { month: 'short', year: 'numeric', timeZone: 'UTC' });
  const axisDate = (d: string) => monthYear.format(new Date(`${d}T00:00:00Z`));
  const first = points[0]!.date;
  const last = points[points.length - 1]!.date;
  const end = projected[projected.length - 1] ?? actual[actual.length - 1]!;
  const current = active === null ? null : points[active];

  const pick = (e: PointerEvent<SVGSVGElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    const vx = ((e.clientX - box.left) / box.width) * W;
    let best = 0;
    points.forEach((p, i) => {
      if (Math.abs(x(p.date) - vx) < Math.abs(x(points[best]!.date) - vx)) best = i;
    });
    setActive(best);
  };
  const keys = (e: KeyboardEvent<HTMLDivElement>) => {
    const lastIndex = points.length - 1;
    const from = active ?? -1;
    const to =
      e.key === 'ArrowRight'
        ? Math.min(lastIndex, from + 1)
        : e.key === 'ArrowLeft'
          ? Math.max(0, from < 0 ? lastIndex : from - 1)
          : e.key === 'Home'
            ? 0
            : e.key === 'End'
              ? lastIndex
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
              <line x1={PAD.l} x2={W - PAD.r} y1={y(BigInt(v))} y2={y(BigInt(v))} stroke="var(--border)" />
              <text x={PAD.l - 6} y={y(BigInt(v)) + 4} textAnchor="end" fontSize="10" fill="var(--ink-muted)">
                {money(BigInt(Math.trunc(v)), currency)}
              </text>
            </g>
          ))}
          {marker && marker.date >= first && marker.date <= last && (
            <g data-testid="chart-marker">
              <line
                x1={x(marker.date)}
                x2={x(marker.date)}
                y1={PAD.t - 4}
                y2={H - PAD.b}
                stroke="var(--border-strong)"
              />
              <text
                x={x(marker.date)}
                y={PAD.t - 8}
                textAnchor={x(marker.date) < PAD.l + 40 ? 'start' : 'middle'}
                fontSize="10"
                fill="var(--ink-soft)"
              >
                {marker.label}
              </text>
            </g>
          )}
          {actual.length > 1 && (
            <polyline
              fill="none"
              stroke={COLOR}
              strokeWidth="2"
              strokeLinejoin="round"
              strokeLinecap="round"
              points={line(actual)}
              data-testid="chart-actual"
            />
          )}
          {projected.length > 1 && (
            <polyline
              fill="none"
              stroke={COLOR}
              strokeWidth="2"
              strokeDasharray="6 5"
              strokeLinejoin="round"
              strokeLinecap="round"
              points={line(projected)}
              data-testid="chart-projected"
            />
          )}
          {current && (
            <g>
              <line
                x1={x(current.date)}
                x2={x(current.date)}
                y1={PAD.t}
                y2={H - PAD.b}
                stroke="var(--ink-muted)"
              />
              <circle
                cx={x(current.date)}
                cy={y(current.value)}
                r="4"
                fill={COLOR}
                stroke="var(--surface)"
                strokeWidth="2"
              />
            </g>
          )}
          <circle
            cx={x(end.date)}
            cy={y(end.value)}
            r="4"
            fill={COLOR}
            stroke="var(--surface)"
            strokeWidth="2"
          />
          {endLabel && (
            <text
              x={x(end.date) - 8}
              y={y(end.value) - 10}
              textAnchor="end"
              fontSize="11"
              fontWeight="600"
              fill="var(--ink)"
              // A halo of the surface keeps it readable where the line runs under it.
              stroke="var(--surface)"
              strokeWidth="4"
              strokeLinejoin="round"
              paintOrder="stroke"
              data-testid="chart-end-label"
            >
              {endLabel}
            </text>
          )}
          <text x={PAD.l} y={H - 8} textAnchor="start" fontSize="10" fill="var(--ink-muted)">
            {axisDate(first)}
          </text>
          {last !== first && (
            <text x={W - PAD.r} y={H - 8} textAnchor="end" fontSize="10" fill="var(--ink-muted)">
              {axisDate(last)}
            </text>
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
            current
              ? x(current.date) > W / 2
                ? { right: `${100 - (x(current.date) / W) * 100 + 2}%` }
                : { left: `${(x(current.date) / W) * 100 + 2}%` }
              : undefined
          }
          data-testid="chart-tooltip"
        >
          {current && (
            <>
              <p className="font-semibold tabular-nums text-ink">{money(current.value, currency)}</p>
              <p className="text-muted">
                {date(current.date)}
                {current.projected ? ` · ${projectedLabel}` : ''}
              </p>
            </>
          )}
        </div>
      </div>
    </figure>
  );
}
