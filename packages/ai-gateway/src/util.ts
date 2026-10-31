import { createHash } from 'node:crypto';

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** Stable JSON (object keys sorted, bigint as string) for hashing inputs. */
export function stableJson(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) => {
    if (typeof v === 'bigint') return v.toString();
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
      );
    }
    return v;
  });
}

/** Runs `fn` over `items` with at most `limit` in flight; results keep input order. */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, i: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return out;
}

export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

/** Three decimals, for confidences (not money). */
export function round3(n: number): number {
  return Number(n.toFixed(3));
}

export function oneLine(text: string, max = 140): string {
  const s = text.replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** Extracts a JSON object from model text: plain JSON, a fenced block, or the outermost {...}. */
export function parseJsonLoose(text: string): unknown {
  const t = text.trim();
  try {
    return JSON.parse(t);
  } catch {
    const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(t);
    if (fenced) {
      try {
        return JSON.parse(fenced[1]!);
      } catch {
        /* fall through */
      }
    }
    const start = t.indexOf('{');
    const end = t.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(t.slice(start, end + 1));
    throw new SyntaxError('No JSON object in model output');
  }
}
