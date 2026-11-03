/** AI wording for planning text (REC-01..08, BUD-02; AIA-05): code computes, AI only words. */
import type { Trx } from '@montra/db';
import { formatMoney, money } from '@montra/domain';
import type { SummaryInput } from '@montra/ai-gateway';
import type { AiService } from '../ai/ai.service.js';
import type { Ctx } from './data.js';

export interface WordingRequest {
  kind: SummaryInput['kind'];
  title: string;
  /** Raw figures: money in minor units (listed in `money`), other values as display strings. */
  figures: Record<string, string>;
  money: readonly string[];
  names: readonly string[];
}

/** Formats the money figures in the workspace's currency. */
export function formatFigures(
  currency: string,
  req: Pick<WordingRequest, 'figures' | 'money'>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.figures)) {
    out[k] = req.money.includes(k) ? formatMoney(money(BigInt(v), currency)) : v;
  }
  return out;
}

/** The AI's wording, or null when AI is off, unavailable or answered with numbers it wasn't given. */
export async function wordSummary(
  ai: AiService,
  trx: Trx,
  ctx: Ctx,
  currency: string,
  req: WordingRequest,
): Promise<string | null> {
  const runtime = await ai.runtime(trx, ctx, { type: 'planning', id: ctx.workspaceId });
  if (!runtime.available) return null;
  const res = await ai.gateway.wordSummary(
    { kind: req.kind, title: req.title, figures: formatFigures(currency, req), names: req.names },
    { ...runtime.ctx, parkLocal: false },
  );
  return res.ok ? res.value : null;
}
