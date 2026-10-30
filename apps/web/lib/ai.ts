/**
 * AI settings, audit log, natural-language quick add, insights and the local-mode runner (UP-13, UP-06,
 * AIA-08, AIA-10, TXN-06, AI-08/09): pure helpers for the pages. Numbers shown to users are computed here or by
 * the API, never by a model (AIA-05).
 */
import type {
  AiEventDto,
  AiMode,
  AiSettingsDto,
  AiTaskDto,
  InsightDto,
  QuickAddDraftDto,
} from '@montra/schemas';
import type { CreateTransactionInput } from '@montra/api-client';
import { whole } from './review';

export const AI_MODES = ['builtin', 'byok', 'local', 'off'] as const satisfies readonly AiMode[];

export type Tone = 'good' | 'warn' | 'bad' | 'muted';

export const USAGE_TONE: Record<AiSettingsDto['usage']['state'], Tone> = {
  ok: 'good',
  downgraded: 'warn',
  exhausted: 'bad',
};

/** Share of the monthly budget spent, 0..100 (null without a budget). */
export function budgetPercent(s: Pick<AiSettingsDto, 'monthlyBudgetUsd' | 'usage'>): number | null {
  if (s.monthlyBudgetUsd === null || s.monthlyBudgetUsd <= 0) return null;
  return Math.min(100, whole((s.usage.spentUsd / s.monthlyBudgetUsd) * 100));
}

/** USD with cents, or fractions of a cent for tiny per-call costs ("$0.0004"). */
export function formatUsd(usd: number, locale = 'en-US'): string {
  const digits = usd !== 0 && Math.abs(usd) < 0.01 ? 4 : 2;
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(usd);
}

export const OUTCOME_TONE: Record<AiEventDto['outcome'], Tone> = {
  ok: 'good',
  cached: 'good',
  off: 'muted',
  budget: 'warn',
  invalid_output: 'bad',
  provider_error: 'bad',
  refused: 'warn',
};

/** Whether the provider section needs a key (BYOK) or an endpoint (local). */
export const needsKey = (mode: AiMode) => mode === 'byok';
export const needsEndpoint = (mode: AiMode) => mode === 'local';

/** Parses the threshold slider (whole percent) into the API's 0.5..0.99. */
export const thresholdFromPercent = (p: number) => Math.min(0.99, Math.max(0.5, whole(p) / 100));

/** Parses the budget field: blank = no budget. */
export function parseBudget(s: string): { ok: true; value: number | null } | { ok: false } {
  const v = s.trim().replace(/^\$/, '');
  if (!v) return { ok: true, value: null };
  if (!/^\d+(\.\d{1,2})?$/.test(v)) return { ok: false };
  const n = Number(v);
  return n <= 10000 ? { ok: true, value: n } : { ok: false };
}

// ----- Natural-language quick add (TXN-06) -------------------------------------------------------------------

export type SpanField = QuickAddDraftDto['spans'][number]['field'];
export interface Segment {
  text: string;
  field: SpanField | null;
}

/** Splits the typed sentence into plain text and the parts that mapped to a field, in order. */
export function highlightSpans(text: string, spans: QuickAddDraftDto['spans']): Segment[] {
  const marks: { start: number; end: number; field: SpanField }[] = [];
  const lower = text.toLowerCase();
  for (const s of spans) {
    const needle = s.text.toLowerCase();
    if (!needle) continue;
    let from = 0;
    let at = lower.indexOf(needle, from);
    // Skip occurrences already claimed by an earlier span.
    while (at >= 0 && marks.some((m) => at < m.end && at + needle.length > m.start)) {
      from = at + 1;
      at = lower.indexOf(needle, from);
    }
    if (at >= 0) marks.push({ start: at, end: at + needle.length, field: s.field });
  }
  marks.sort((a, b) => a.start - b.start);
  const out: Segment[] = [];
  let pos = 0;
  for (const m of marks) {
    if (m.start > pos) out.push({ text: text.slice(pos, m.start), field: null });
    out.push({ text: text.slice(m.start, m.end), field: m.field });
    pos = m.end;
  }
  if (pos < text.length) out.push({ text: text.slice(pos), field: null });
  return out;
}

/** The create-transaction body for a parsed draft, or the i18n key of what is missing. */
export function draftToTransaction(
  draft: QuickAddDraftDto,
  fallbackAccountId: string | null,
  accountCurrency: (accountId: string) => string | null,
): { ok: true; value: CreateTransactionInput } | { ok: false; error: string } {
  const accountId = draft.accountId ?? fallbackAccountId;
  if (!accountId) return { ok: false, error: 'quick_add.nl.need_account' };
  if (!draft.amount) return { ok: false, error: 'quick_add.nl.need_amount' };
  const raw = BigInt(draft.amount.amount);
  const abs = raw < 0n ? -raw : raw;
  if (abs === 0n) return { ok: false, error: 'money.not_zero' };
  const currency = accountCurrency(accountId) ?? draft.amount.currency;
  return {
    ok: true,
    value: {
      date: draft.date,
      accountId,
      amount: { amount: (draft.direction === 'out' ? -abs : abs).toString(), currency },
      ...(draft.payee ? { payee: draft.payee } : {}),
      ...(draft.categoryId ? { categoryId: draft.categoryId } : {}),
      ...(draft.memberId ? { memberId: draft.memberId } : {}),
      ...(draft.memo ? { memo: draft.memo } : {}),
      ...(draft.tags.length ? { tags: draft.tags } : {}),
    },
  };
}

// ----- Insights (AI-08, AI-09) ---------------------------------------------------------------------------------

export const INSIGHT_KINDS = [
  'recurring',
  'new_subscription',
  'price_increase',
  'unusual_amount',
  'duplicate_charge',
] as const satisfies readonly InsightDto['kind'][];

export function groupInsights(
  list: readonly InsightDto[],
): { kind: InsightDto['kind']; items: InsightDto[] }[] {
  return INSIGHT_KINDS.map((kind) => ({ kind, items: list.filter((i) => i.kind === kind) })).filter(
    (g) => g.items.length > 0,
  );
}

// ----- Local mode runner (06 §2) -------------------------------------------------------------------------------

/**
 * Sends one parked task to the user's OpenAI-compatible endpoint and returns the model's JSON output.
 * `task.input` is already a chat-completions body ({ model, messages, response_format }).
 */
export async function runLocalTask(
  task: AiTaskDto,
  endpoint: string,
  fetchImpl: typeof fetch = fetch,
): Promise<unknown> {
  const url = `${endpoint.replace(/\/+$/, '')}/chat/completions`;
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(task.input),
  });
  if (!res.ok) throw new Error(`Local model answered ${res.status}`);
  const body = (await res.json()) as { choices?: { message?: { content?: unknown } }[] };
  const content = body.choices?.[0]?.message?.content;
  if (typeof content !== 'string') throw new Error('Local model returned no content');
  return parseJsonContent(content);
}

/** Model text → JSON, tolerating a ```json fence around it. */
export function parseJsonContent(content: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(content);
  return JSON.parse((fenced ? fenced[1]! : content).trim());
}
