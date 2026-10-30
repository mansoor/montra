/**
 * The AI gateway contract (06-ai-gateway.md, ADR-0007, ADR-0012). Features call task functions, never providers.
 * A task never throws to the feature: it returns `ok: false` with a reason and the caller degrades
 * (review queue, manual mapping, template text).
 */
import type { ColumnMapping } from '@montra/importers';

export type AiMode = 'builtin' | 'byok' | 'local' | 'off';
export type ProviderId = 'anthropic' | 'openai_compatible' | 'null' | 'fake';
export type TaskName =
  | 'categorize'
  | 'normalize_payees'
  | 'map_columns'
  | 'parse_quick_add'
  | 'extract_statement_table'
  | 'propose_categories';
/** Routing groups (AIA-02): small = cheap classifier work, vision = documents, large = summaries and Q&A. */
export type ModelGroup = 'small' | 'vision' | 'large';
export type Effort = 'low' | 'medium' | 'high';
export type FailureReason = 'off' | 'budget' | 'invalid_output' | 'provider_error' | 'refused' | 'pending_local';

export interface AiMeta {
  task: TaskName;
  provider: ProviderId;
  model: string;
  promptVersion: string;
  inputHash: string;
  latencyMs: number;
  tokensIn: number;
  tokensOut: number;
  costMicroUsd: bigint;
  /** Items answered from the cache (no provider call). */
  cachedItems: number;
  /** True when the failover provider answered (OPS-07). */
  failedOver: boolean;
}

export type TaskResult<T> =
  | { ok: true; value: T; meta: AiMeta }
  | { ok: false; reason: FailureReason; detail?: string; meta?: AiMeta };

// ----- Providers ------------------------------------------------------------------------------------------

export interface ProviderConfig {
  id: ProviderId;
  /** BYOK key or Montra's key (builtin). Never logged. */
  apiKey?: string;
  /** OpenAI-compatible base URL (…/v1) for local mode; optional base URL override for Anthropic. */
  baseUrl?: string;
  /** Model override per group; defaults come from the routing table. */
  models?: Partial<Record<ModelGroup, string>>;
}

export interface CompletionRequest {
  model: string;
  effort: Effort;
  /** Stable instructions — first in the prompt, cached (06 §3). */
  system: string;
  /** Stable per-workspace context (e.g. the category list) — after the system prompt, before the cache breakpoint. */
  context?: string;
  /** Volatile input (row data). */
  input: string;
  /** JSON schema of the expected output object (generated from the task's Zod schema). */
  schema: Record<string, unknown>;
  maxTokens: number;
  signal?: AbortSignal;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export type CompletionResponse =
  | { ok: true; json: unknown; usage: Usage; model: string }
  | { ok: false; reason: 'refused' | 'invalid_output' | 'provider_error'; detail: string; usage?: Usage };

export interface ProviderAdapter {
  readonly id: ProviderId;
  complete(req: CompletionRequest): Promise<CompletionResponse>;
}

// ----- Persistence the caller provides (the API backs it with app.ai_cache / ai_event / ai_usage) ----------

export interface AiEventRecord {
  task: TaskName;
  provider: ProviderId;
  model: string;
  promptVersion: string;
  inputHash: string;
  outcome: 'ok' | 'cached' | 'off' | 'budget' | 'invalid_output' | 'provider_error' | 'refused';
  output: unknown;
  confidence: number | null;
  items: number;
  latencyMs: number | null;
  tokensIn: number | null;
  tokensOut: number | null;
  costMicroUsd: bigint;
  subject?: { type: string; id: string };
}

export interface GatewayStore {
  cacheGet(task: TaskName, keyHash: string): Promise<unknown | null>;
  cachePut(task: TaskName, keyHash: string, output: unknown, model: string, ttlDays: number): Promise<void>;
  recordEvent(e: AiEventRecord): Promise<void>;
  /** Adds to this month's spend (kept apart from the deletable audit log). */
  addUsage(costMicroUsd: bigint, calls: number): Promise<void>;
  /** Local mode on the hosted service: park the minimized request for a client on the user's network. */
  parkLocal?(task: TaskName, input: unknown): Promise<void>;
}

export interface AiContext {
  workspaceId: string;
  mode: AiMode;
  provider: ProviderConfig;
  /** OPS-07: tried when the primary fails with provider_error. */
  failover?: ProviderConfig;
  /** Monthly budget in USD (null = unlimited) and the spend so far this month. */
  budget: { monthlyUsd: number | null; spentMicroUsd: bigint };
  store: GatewayStore;
  /** Names to replace with stable pseudonyms before sending (family members, tenants) — AIA-03. */
  pseudonyms?: ReadonlyArray<{ name: string; token: string }>;
  /** Hosted service + local mode: the endpoint is unreachable from the server, so park instead of calling. */
  parkLocal?: boolean;
  subject?: { type: string; id: string };
  signal?: AbortSignal;
}

// ----- Task inputs and outputs -----------------------------------------------------------------------------

export interface CategoryOption {
  id: string;
  name: string;
  group: string | null;
  kind: 'income' | 'expense';
  entityId: string;
  entityType: 'personal' | 'business' | 'rental';
}

export interface MemberOption {
  id: string;
  /** Real name; the minimizer swaps it for a pseudonym before sending. */
  name: string;
  relationship: string | null;
}

export interface CategorizeItem {
  id: string;
  payee: string | null;
  description: string;
  /** Signed minor units from the account's view (negative = money out). */
  amountMinor: bigint;
  currency: string;
  date: string;
  /** Account kind (checking, savings, credit_card, …) — never its name or number. */
  accountType: string;
  entityType: 'personal' | 'business' | 'rental';
}

export interface CategorizeOutput {
  id: string;
  categoryId: string | null;
  memberId: string | null;
  tags: string[];
  /** Calibrated (06 §6). */
  confidence: number;
  rawConfidence: number;
  /** One line, e.g. "AI: 'Blue Bottle' is a coffee shop → Dining out". */
  explanation: string;
  /** Clean merchant name and MCC when the model knows the merchant (AI-07). */
  merchant: { name: string; mcc: string | null } | null;
}

export interface PayeeNormalization {
  raw: string;
  name: string;
  kind: 'merchant' | 'person' | 'employer' | 'transfer' | 'unknown';
  mcc: string | null;
  confidence: number;
}

export interface GridSample {
  fileType: 'csv' | 'xlsx' | 'xls' | 'pdf';
  /** First ~30 rows as text cells (already redacted: long digit runs masked). */
  rows: string[][];
  locale: string;
  accountType: 'asset' | 'liability';
}

export interface ColumnMappingProposal {
  mapping: ColumnMapping;
  confidence: number;
}

export interface QuickAddContext {
  today: string;
  currency: string;
  accounts: ReadonlyArray<{ id: string; label: string; kind: string }>;
  categories: readonly CategoryOption[];
  members: readonly MemberOption[];
}

export interface TransactionDraft {
  date: string | null;
  /** Positive decimal string. */
  amount: string | null;
  direction: 'out' | 'in';
  payee: string | null;
  accountId: string | null;
  categoryId: string | null;
  memberId: string | null;
  memo: string | null;
  tags: string[];
  confidence: number;
}

export interface StatementText {
  /** Text table per page from OCR or the PDF text layer, redacted (account numbers, names, addresses masked). */
  pages: string[];
  currency: string;
}

export interface StatementTable {
  rows: Array<{ date: string; description: string; amount: string; balance: string | null }>;
  opening: string | null;
  closing: string | null;
  periodStart: string | null;
  periodEnd: string | null;
}

export interface CategoryProposalInput {
  entityType: 'personal' | 'business' | 'rental';
  existing: string[];
  payees: Array<{ payee: string; rows: number; totalMinor: bigint }>;
}

export interface CategoryProposalOutput {
  categories: Array<{ name: string; group: string; kind: 'income' | 'expense' }>;
  assignments: Array<{ payee: string; category: string }>;
}

export interface AiGateway {
  categorize(
    items: readonly CategorizeItem[],
    options: { categories: readonly CategoryOption[]; members: readonly MemberOption[] },
    ctx: AiContext,
  ): Promise<TaskResult<CategorizeOutput[]>>;
  normalizePayees(raw: readonly string[], ctx: AiContext): Promise<TaskResult<PayeeNormalization[]>>;
  mapColumns(sample: GridSample, ctx: AiContext): Promise<TaskResult<ColumnMappingProposal>>;
  parseQuickAdd(text: string, qctx: QuickAddContext, ctx: AiContext): Promise<TaskResult<TransactionDraft>>;
  extractStatementTable(doc: StatementText, ctx: AiContext): Promise<TaskResult<StatementTable>>;
  proposeCategories(input: CategoryProposalInput, ctx: AiContext): Promise<TaskResult<CategoryProposalOutput>>;
  /** Cheap round-trip for the settings page "Test connection" button. */
  ping(ctx: AiContext): Promise<TaskResult<{ model: string }>>;
}
