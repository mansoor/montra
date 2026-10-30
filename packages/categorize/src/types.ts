/**
 * Categorization pipeline contract (04-domain-logic §5, §6, §10; ADR-0012). Pure logic: no I/O. The API loads
 * rules, history and candidates, calls `runPipeline`, and persists the decisions.
 */
import type { CalendarDate } from '@montra/domain';

export type Step = 'receipt' | 'rule' | 'transfer' | 'history' | 'file' | 'merchant' | 'ai' | 'user' | 'none';

// ----- Rules (04 §6) — same shapes as @montra/schemas RuleConditions / RuleActions ------------------------

export type RuleField =
  | 'payee'
  | 'description'
  | 'raw_description'
  | 'amount'
  | 'account'
  | 'entity'
  | 'date_dow'
  | 'item_text';
export type RuleOp = 'equals' | 'contains' | 'starts_with' | 'regex' | 'between' | 'gt' | 'lt' | 'in';
export interface RuleCondition {
  field: RuleField;
  op: RuleOp;
  value: string | string[];
  ci?: boolean;
}
export interface RuleConditions {
  all: Array<RuleCondition | { any: RuleCondition[] }>;
}
export interface RuleActions {
  categoryId?: string | null;
  entityId?: string | null;
  memberId?: string | null;
  tags?: string[];
  renamePayee?: string | null;
  markReviewed?: boolean;
}
export interface RuleRecord {
  id: string;
  name: string;
  entityId: string | null;
  priority: number;
  conditions: RuleConditions;
  actions: RuleActions;
  enabled: boolean;
  createdAt: string;
}

/** What a rule is matched against. Amounts are signed minor units from the account's view. */
export interface Subject {
  payee: string | null;
  payeeKey: string | null;
  description: string;
  rawDescription: string | null;
  amountMinor: bigint;
  /** Minor-unit exponent of the currency (2 for USD), to read decimal amounts in conditions. */
  exponent: number;
  accountId: string;
  entityId: string;
  date: CalendarDate;
  itemText?: string;
}

// ----- Inputs to the pipeline ------------------------------------------------------------------------------

export interface PipelineItem extends Subject {
  id: string;
  currency: string;
  accountType: string;
  entityType: 'personal' | 'business' | 'rental';
  /** The account's default member (FAM-04) — the prior for member prediction. */
  defaultMemberId: string | null;
  /** Category named by the file itself (app exports), resolved to an id by the caller. */
  fileCategoryId?: string | null;
  fileCategoryName?: string | null;
  /** Reference-merchant match from payee normalization (Phase 2). */
  merchant?: { id: string; name: string; categoryId: string | null } | null;
}

export interface HistoryEntry {
  amountBand: number;
  categoryId: string;
  memberId: string | null;
  count: number;
}

/** Another account's transaction that could be the other side of a transfer (step 3). */
export interface TransferCandidate {
  transactionId: string | null;
  accountId: string;
  accountName: string;
  accountLast4: string | null;
  /** The transfer category / clearing account the caller posts to when the pair is confirmed. */
  amountMinor: bigint;
  date: CalendarDate;
}

export interface AiSuggestion {
  categoryId: string | null;
  memberId: string | null;
  tags: string[];
  confidence: number;
  explanation: string;
}

export interface PipelineDeps {
  rules: readonly CompiledRule[];
  /** History for a payee key (all bands); the pipeline picks the band. */
  history: (payeeKey: string) => readonly HistoryEntry[];
  /** Transfer candidates near an item (caller pre-filters by date ±3 days and opposite sign). */
  transferCandidates: (item: PipelineItem) => readonly TransferCandidate[];
  /** Step 5. Called once with every item still open after step 4; returns suggestions by item id. */
  ai?: (open: readonly PipelineItem[]) => Promise<ReadonlyMap<string, AiSuggestion>>;
  /** Review threshold on calibrated confidence (default 0.80). */
  threshold: number;
  /** The category an entity's category id belongs to, to fill `entityId` on decisions. */
  entityOfCategory: (categoryId: string) => string | null;
}

export interface Decision {
  id: string;
  step: Step;
  categoryId: string | null;
  entityId: string | null;
  memberId: string | null;
  tags: string[];
  renamePayee: string | null;
  /** Step 3: the other side of a likely transfer. */
  transfer: TransferCandidate | null;
  confidence: number;
  explanation: string;
  ruleId: string | null;
  /** All rules that matched (for hit counts). */
  matchedRuleIds: string[];
  /** confidence ≥ threshold, or a rule with markReviewed. */
  autoApply: boolean;
}

/** A rule compiled once (regexes built with RE2 semantics, amounts parsed). Opaque to callers. */
export interface CompiledRule {
  readonly record: RuleRecord;
  matches(subject: Subject): boolean;
}

// ----- Learning (AI-05) -----------------------------------------------------------------------------------

export interface CorrectionRecord {
  payeeKey: string;
  payee: string | null;
  field: 'category' | 'member' | 'entity';
  toValue: string | null;
}

export interface RuleProposal {
  payeeKey: string;
  name: string;
  conditions: RuleConditions;
  actions: RuleActions;
  evidence: number;
}

// ----- Recurring and anomalies (AI-08, AI-09; 04 §10) ------------------------------------------------------

export interface HistoryTxn {
  id: string;
  date: CalendarDate;
  amountMinor: bigint;
  accountId: string;
}

export interface PayeeSeries {
  payeeKey: string;
  payee: string;
  accountId: string;
  entityId: string;
  categoryId: string | null;
  txns: readonly HistoryTxn[];
}

export type Cadence = 'weekly' | 'biweekly' | 'semimonthly' | 'monthly' | 'quarterly' | 'yearly';

export interface RecurringProposal {
  payeeKey: string;
  payee: string;
  accountId: string;
  entityId: string;
  categoryId: string | null;
  cadence: Cadence;
  /** 'fixed' when max/min ≤ 1.02. */
  amountKind: 'fixed' | 'variable';
  /** Typical (median) amount and band, signed minor units. */
  amountMinor: bigint;
  minMinor: bigint;
  maxMinor: bigint;
  lastDate: CalendarDate;
  nextDate: CalendarDate;
  firstSeen: CalendarDate;
  occurrences: number;
  /** First seen within 45 days of `today`. */
  isNew: boolean;
  /** Last amount > 5% above the previous stable amount. */
  priceIncrease: { fromMinor: bigint; toMinor: bigint; percent: number } | null;
}

export type AnomalyKind = 'unusual_amount' | 'duplicate_charge' | 'new_subscription' | 'price_increase';

export interface Anomaly {
  kind: AnomalyKind;
  transactionId: string;
  payeeKey: string;
  /** Stable key so re-running detection doesn't duplicate flags. */
  dedupeKey: string;
  /** Plain-language line; numbers are computed here, never by a model (AIA-05). */
  message: string;
  data: Record<string, string | number | null>;
}
