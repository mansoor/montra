'use client';

import { useRouter } from 'next/navigation';
import type { SankeyDto } from '@montra/api-client';
import { drillHref } from '@/lib/planning';
import { useI18n } from '../i18n';

type Node = SankeyDto['nodes'][number];

const W = 960;
const NODE_W = 12;
const GAP = 10;
const COLS = 4;

/** Column of a node: income → entity → groups (and savings, debt, unspent) → categories. */
const column = (n: Node) =>
  n.kind === 'income' || n.kind === 'deficit' ? 0 : n.kind === 'entity' ? 1 : n.kind === 'category' ? 3 : 2;

const colour = (n: Node, i: number) =>
  n.kind === 'income'
    ? 'var(--good)'
    : n.kind === 'deficit'
      ? 'var(--bad)'
      : n.kind === 'entity'
        ? 'var(--accent)'
        : n.kind === 'savings' || n.kind === 'unspent'
          ? 'var(--chart-3)'
          : n.kind === 'debt'
            ? 'var(--chart-5)'
            : `var(--chart-${(i % 8) + 1})`;

/**
 * Money flow (FLOW-02): a dependency-free Sankey. Node height is proportional to the money through it; links
 * are bands between nodes. Clicking a node opens the transactions behind it.
 */
export function Sankey({ data, base }: { data: SankeyDto; base: string }) {
  const { money, t } = useI18n();
  const router = useRouter();
  const value = (n: Node) => Number(BigInt(n.value));
  const cols: Node[][] = Array.from({ length: COLS }, () => []);
  for (const n of data.nodes) if (value(n) > 0) cols[column(n)]!.push(n);
  for (const c of cols) c.sort((a, b) => value(b) - value(a));
  const totals = cols.map((c) => c.reduce((s, n) => s + value(n), 0));
  const maxTotal = Math.max(1, ...totals);
  const maxCount = Math.max(1, ...cols.map((c) => c.length));
  const H = Math.max(320, maxCount * 34);
  const scale = (H - GAP * (maxCount + 1)) / maxTotal;

  // Positions.
  const pos = new Map<string, { x: number; y: number; h: number; inY: number; outY: number }>();
  cols.forEach((c, ci) => {
    const x = 8 + (ci * (W - 16 - NODE_W - 180)) / (COLS - 1);
    let y = GAP;
    for (const n of c) {
      const h = Math.max(2, value(n) * scale);
      pos.set(n.id, { x, y, h, inY: y, outY: y });
      y += h + GAP;
    }
  });
  const nodeIndex = new Map(data.nodes.map((n, i) => [n.id, i]));
  const links = data.links
    .filter((l) => pos.has(l.source) && pos.has(l.target))
    .sort((a, b) => pos.get(a.target)!.y - pos.get(b.target)!.y);
  if (cols.every((c) => c.length === 0)) return <p className="text-sm text-muted">{t('flow.empty')}</p>;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={t('flow.sankey_label')} className="h-auto w-full">
      {links.map((l, i) => {
        const s = pos.get(l.source)!;
        const d = pos.get(l.target)!;
        const w = Math.max(1, Number(BigInt(l.value)) * scale);
        const x0 = s.x + NODE_W;
        const x1 = d.x;
        const y0 = s.outY + w / 2;
        const y1 = d.inY + w / 2;
        s.outY += w;
        d.inY += w;
        const mx = (x0 + x1) / 2;
        const src = data.nodes[nodeIndex.get(l.source)!]!;
        return (
          <path
            key={i}
            d={`M${x0},${y0} C${mx},${y0} ${mx},${y1} ${x1},${y1}`}
            fill="none"
            stroke={colour(src, nodeIndex.get(l.source)!)}
            strokeOpacity="0.25"
            strokeWidth={w}
          >
            <title>{money(BigInt(l.value), data.currency)}</title>
          </path>
        );
      })}
      {data.nodes.map((n, i) => {
        const p = pos.get(n.id);
        if (!p) return null;
        const clickable = n.drill !== null;
        const label = `${n.label} · ${money(BigInt(n.value), data.currency)}`;
        return (
          <g
            key={n.id}
            role={clickable ? 'link' : undefined}
            tabIndex={clickable ? 0 : undefined}
            aria-label={label}
            className={clickable ? 'cursor-pointer' : undefined}
            onClick={clickable ? () => router.push(drillHref(base, n.drill)) : undefined}
            onKeyDown={
              clickable
                ? (e) => {
                    if (e.key === 'Enter') router.push(drillHref(base, n.drill));
                  }
                : undefined
            }
          >
            <rect x={p.x} y={p.y} width={NODE_W} height={p.h} rx="3" fill={colour(n, i)} />
            <text x={p.x + NODE_W + 6} y={p.y + Math.min(p.h / 2, 14) + 4} fontSize="12" fill="var(--ink)">
              {n.label}
              <tspan fill="var(--ink-muted)"> {money(BigInt(n.value), data.currency)}</tspan>
            </text>
          </g>
        );
      })}
    </svg>
  );
}
