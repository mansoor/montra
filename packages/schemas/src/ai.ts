import { z } from 'zod';
import { CalendarDateDto, Id, MoneyDto } from './common.js';

// ----- How a category was chosen (AI-03, AI-06) -----------------------------------------------------------

export const CategorizationStep = z.enum([
  'receipt',
  'rule',
  'transfer',
  'history',
  'file',
  'merchant',
  'ai',
  'user',
  'none',
]);
export type CategorizationStep = z.infer<typeof CategorizationStep>;

export const CategorizationDto = z.object({
  step: CategorizationStep,
  /** Calibrated confidence 0..1; 1 for rules and user choices. */
  confidence: z.number(),
  /** One line, e.g. "Matched rule 'Shell → Fuel'" or "Similar to 6 past transactions". */
  explanation: z.string(),
  ruleId: z.string().nullable(),
  /** What the pipeline proposed when it was below the threshold (the review queue shows this). */
  suggested: z
    .object({
      categoryId: z.string().nullable(),
      entityId: z.string().nullable(),
      memberId: z.string().nullable(),
    })
    .nullable(),
});
export type CategorizationDto = z.infer<typeof CategorizationDto>;

export const MerchantDto = z.object({
  name: z.string(),
  mcc: z.string().nullable(),
  logoUrl: z.string().nullable(),
});
export type MerchantDto = z.infer<typeof MerchantDto>;

// ----- AI settings (UP-13, UP-06, AIA-08) ----------------------------------------------------------------

export const AiMode = z.enum(['builtin', 'byok', 'local', 'off']);
export type AiMode = z.infer<typeof AiMode>;
export const AiProvider = z.enum(['anthropic', 'openai_compatible']);
export type AiProvider = z.infer<typeof AiProvider>;

export const AiDisclosureDto = z.object({
  mode: AiMode,
  title: z.string(),
  /** Plain-language bullet points: where data goes, what is sent, retention, training. */
  points: z.array(z.string()),
});
export type AiDisclosureDto = z.infer<typeof AiDisclosureDto>;

export const AiSettingsDto = z.object({
  mode: AiMode,
  /** For byok and local; builtin always uses the hosted provider. */
  provider: AiProvider,
  /** OpenAI-compatible base URL for local mode (Ollama, LM Studio, vLLM), e.g. http://localhost:11434/v1. */
  endpoint: z.string().nullable(),
  /** Optional model override per task group. */
  models: z.object({
    small: z.string().nullable(),
    vision: z.string().nullable(),
    large: z.string().nullable(),
  }),
  hasKey: z.boolean(),
  keyLast4: z.string().nullable(),
  /** Review-queue threshold on calibrated confidence (default 0.80). */
  threshold: z.number(),
  monthlyBudgetUsd: z.number().nullable(),
  /** PAY-09/UP-06: allow statement scans and payslip images to be sent to an LLM. */
  allowDocumentsToLlm: z.boolean(),
  /** OPS-07: fall back to a second provider when the first fails. */
  failover: z.boolean(),
  usage: z.object({
    month: z.string(),
    calls: z.number(),
    spentUsd: z.number(),
    state: z.enum(['ok', 'downgraded', 'exhausted']),
  }),
  disclosures: z.array(AiDisclosureDto),
});
export type AiSettingsDto = z.infer<typeof AiSettingsDto>;

export const UpdateAiSettingsRequest = z
  .object({
    mode: AiMode,
    provider: AiProvider,
    endpoint: z.string().url().max(500).nullable(),
    models: z.object({
      small: z.string().max(100).nullable(),
      vision: z.string().max(100).nullable(),
      large: z.string().max(100).nullable(),
    }),
    /** Write-only. Stored encrypted; never returned. */
    apiKey: z.string().min(8).max(500),
    clearKey: z.boolean(),
    threshold: z.number().min(0.5).max(0.99),
    monthlyBudgetUsd: z.number().min(0).max(10000).nullable(),
    allowDocumentsToLlm: z.boolean(),
    failover: z.boolean(),
  })
  .partial();
export type UpdateAiSettingsRequest = z.output<typeof UpdateAiSettingsRequest>;

export const TestAiProviderResponse = z.object({
  ok: z.boolean(),
  provider: z.string(),
  model: z.string().nullable(),
  latencyMs: z.number().nullable(),
  error: z.string().nullable(),
});
export type TestAiProviderResponse = z.infer<typeof TestAiProviderResponse>;

// ----- AI audit log (AIA-10) ------------------------------------------------------------------------------

export const AiEventDto = z.object({
  id: z.string(),
  task: z.string(),
  provider: z.string(),
  model: z.string(),
  promptVersion: z.string(),
  inputHash: z.string(),
  outcome: z.enum(['ok', 'cached', 'off', 'budget', 'invalid_output', 'provider_error', 'refused']),
  output: z.unknown().nullable(),
  confidence: z.number().nullable(),
  items: z.number(),
  latencyMs: z.number().nullable(),
  tokensIn: z.number().nullable(),
  tokensOut: z.number().nullable(),
  costUsd: z.number(),
  userAction: z.enum(['pending', 'accepted', 'edited', 'rejected']).nullable(),
  subjectType: z.string().nullable(),
  subjectId: z.string().nullable(),
  createdAt: z.string(),
});
export type AiEventDto = z.infer<typeof AiEventDto>;

// ----- Rules (UP-02, 04 §6) -------------------------------------------------------------------------------

export const RuleField = z.enum([
  'payee',
  'description',
  'raw_description',
  'amount',
  'account',
  'entity',
  'date_dow',
  'item_text',
]);
export const RuleOp = z.enum(['equals', 'contains', 'starts_with', 'regex', 'between', 'gt', 'lt', 'in']);

export const RuleCondition = z.object({
  field: RuleField,
  op: RuleOp,
  /** Text for text ops; decimal strings for amount ops ("-200.00"); ids for account/entity `in`; 0-6 for date_dow. */
  value: z.union([z.string().max(200), z.array(z.string().max(200)).max(50)]),
  /** Case-insensitive (default true). */
  ci: z.boolean().optional(),
});
export type RuleCondition = z.infer<typeof RuleCondition>;

export const RuleConditions = z.object({
  all: z
    .array(z.union([RuleCondition, z.object({ any: z.array(RuleCondition).min(1).max(20) })]))
    .min(1)
    .max(20),
});
export type RuleConditions = z.infer<typeof RuleConditions>;

export const RuleActions = z
  .object({
    categoryId: Id.nullable(),
    entityId: Id.nullable(),
    memberId: Id.nullable(),
    tags: z.array(z.string().max(50)).max(10),
    renamePayee: z.string().max(200).nullable(),
    markReviewed: z.boolean(),
  })
  .partial()
  .refine((a) => Object.values(a).some((v) => v !== undefined && v !== null), {
    message: 'A rule needs at least one action',
  });
export type RuleActions = z.output<typeof RuleActions>;

export const CreateRuleRequest = z.object({
  name: z.string().trim().min(1).max(200),
  entityId: Id.nullable().default(null),
  scope: z.enum(['transaction', 'receipt_line']).default('transaction'),
  priority: z.number().int().min(0).max(10000).default(100),
  conditions: RuleConditions,
  actions: RuleActions,
  enabled: z.boolean().default(true),
});
export type CreateRuleRequest = z.output<typeof CreateRuleRequest>;

export const UpdateRuleRequest = z
  .object({
    name: z.string().trim().min(1).max(200),
    entityId: Id.nullable(),
    priority: z.number().int().min(0).max(10000),
    conditions: RuleConditions,
    actions: RuleActions,
    enabled: z.boolean(),
  })
  .partial();
export type UpdateRuleRequest = z.output<typeof UpdateRuleRequest>;

export const RuleDto = z.object({
  id: z.string(),
  name: z.string(),
  entityId: z.string().nullable(),
  scope: z.enum(['transaction', 'receipt_line']),
  priority: z.number(),
  conditions: RuleConditions,
  actions: z.record(z.string(), z.unknown()),
  origin: z.enum(['user', 'ai_suggested', 'correction']),
  enabled: z.boolean(),
  hitCount: z.number(),
  lastHitAt: z.string().nullable(),
  version: z.string(),
  createdAt: z.string(),
});
export type RuleDto = z.infer<typeof RuleDto>;

/** POST /rules/preview — or /rules/:id/preview with an empty body. */
export const RulePreviewRequest = z.object({
  conditions: RuleConditions,
  actions: RuleActions.optional(),
  entityId: Id.nullable().optional(),
});
export type RulePreviewRequest = z.output<typeof RulePreviewRequest>;

export const RulePreviewDto = z.object({
  /** Existing posted transactions the rule matches. */
  matches: z.number(),
  /** Of those, how many the rule would change. */
  changes: z.number(),
  /** Matches skipped because they are in a locked period or reconciled. */
  skippedLocked: z.number(),
  sample: z.array(
    z.object({
      transactionId: z.string(),
      date: z.string(),
      payee: z.string().nullable(),
      amount: MoneyDto.nullable(),
      categoryId: z.string().nullable(),
    }),
  ),
});
export type RulePreviewDto = z.infer<typeof RulePreviewDto>;

export const RuleSuggestionDto = z.object({
  id: z.string(),
  name: z.string(),
  payeeKey: z.string(),
  conditions: RuleConditions,
  actions: z.record(z.string(), z.unknown()),
  /** Identical corrections that triggered the offer. */
  evidence: z.number(),
  /** Existing transactions the rule would change ("apply to N existing"). */
  existingMatches: z.number(),
  createdAt: z.string(),
});
export type RuleSuggestionDto = z.infer<typeof RuleSuggestionDto>;

export const AcceptRuleSuggestionRequest = z.object({ applyToExisting: z.boolean().default(false) });
export type AcceptRuleSuggestionRequest = z.output<typeof AcceptRuleSuggestionRequest>;

// ----- Review queue (AI-03/04, PLT-10) --------------------------------------------------------------------

export const ReviewItemDto = z.object({
  transactionId: z.string(),
  date: z.string(),
  payee: z.string().nullable(),
  description: z.string(),
  amount: MoneyDto.nullable(),
  accountId: z.string().nullable(),
  entityId: z.string(),
  /** Category currently posted (often the entity's uncategorized account). */
  categoryId: z.string().nullable(),
  memberId: z.string().nullable(),
  categorization: CategorizationDto.nullable(),
  merchant: MerchantDto.nullable(),
  version: z.string(),
});
export type ReviewItemDto = z.infer<typeof ReviewItemDto>;

export const ReviewListResponse = z.object({
  items: z.array(ReviewItemDto),
  total: z.number(),
  nextCursor: z.string().nullable(),
});
export type ReviewListResponse = z.infer<typeof ReviewListResponse>;

/** Accept the suggestions as they are: either listed transactions, or everything at or above a confidence. */
export const AcceptReviewRequest = z
  .object({
    transactionIds: z.array(Id).max(1000).optional(),
    minConfidence: z.number().min(0).max(1).optional(),
    entityId: Id.optional(),
  })
  .refine((r) => Boolean(r.transactionIds?.length) !== (r.minConfidence !== undefined), {
    message: 'Give either transactionIds or minConfidence',
    path: ['transactionIds'],
  });
export type AcceptReviewRequest = z.output<typeof AcceptReviewRequest>;

export const AcceptReviewResponse = z.object({ accepted: z.number(), skipped: z.number() });
export type AcceptReviewResponse = z.infer<typeof AcceptReviewResponse>;

/** Choose a different category (and optionally member/entity) — a correction the app learns from (AI-05). */
export const ResolveReviewRequest = z.object({
  categoryId: Id,
  memberId: Id.nullable().optional(),
  version: z.string().optional(),
});
export type ResolveReviewRequest = z.output<typeof ResolveReviewRequest>;

export const ResolveReviewResponse = z.object({
  transactionId: z.string(),
  /** Offered after 2 identical corrections. */
  ruleSuggestion: RuleSuggestionDto.nullable(),
});
export type ResolveReviewResponse = z.infer<typeof ResolveReviewResponse>;

// ----- Suggestions for the editor and natural-language quick add (TXN-06) ---------------------------------

export const SuggestRequest = z.object({
  payee: z.string().trim().max(200),
  description: z.string().max(500).optional(),
  amount: MoneyDto,
  accountId: Id,
  date: CalendarDateDto,
});
export type SuggestRequest = z.output<typeof SuggestRequest>;

export const SuggestionDto = z.object({
  categoryId: z.string().nullable(),
  entityId: z.string().nullable(),
  memberId: z.string().nullable(),
  tags: z.array(z.string()),
  payee: z.string().nullable(),
  confidence: z.number(),
  step: CategorizationStep,
  explanation: z.string(),
});
export type SuggestionDto = z.infer<typeof SuggestionDto>;

export const ParseQuickAddRequest = z.object({
  text: z.string().trim().min(1).max(300),
  /** Client's local date, so "yesterday" means the user's yesterday. */
  today: CalendarDateDto,
});
export type ParseQuickAddRequest = z.output<typeof ParseQuickAddRequest>;

export const QuickAddDraftDto = z.object({
  date: z.string(),
  /** Positive decimal string; `direction` says money in or out. */
  amount: MoneyDto.nullable(),
  direction: z.enum(['out', 'in']),
  payee: z.string().nullable(),
  accountId: z.string().nullable(),
  categoryId: z.string().nullable(),
  memberId: z.string().nullable(),
  memo: z.string().nullable(),
  tags: z.array(z.string()),
  confidence: z.number(),
  source: z.enum(['ai', 'heuristic']),
  /** Which words mapped to which field, for highlighting in the quick-add bar. */
  spans: z.array(
    z.object({
      field: z.enum(['amount', 'date', 'payee', 'account', 'category', 'member', 'memo', 'tag']),
      text: z.string(),
    }),
  ),
});
export type QuickAddDraftDto = z.infer<typeof QuickAddDraftDto>;

// ----- Category proposals from the first import (UP-03) ---------------------------------------------------

export const CategoryProposalDto = z.object({
  name: z.string(),
  group: z.string(),
  kind: z.enum(['income', 'expense']),
  /** Whether a category with this name already exists in the entity. */
  exists: z.boolean(),
  payees: z.array(z.string()),
  rows: z.number(),
});
export type CategoryProposalDto = z.infer<typeof CategoryProposalDto>;

export const CategoryProposalsResponse = z.object({
  source: z.enum(['ai', 'reference']),
  proposals: z.array(CategoryProposalDto),
});
export type CategoryProposalsResponse = z.infer<typeof CategoryProposalsResponse>;

export const AcceptCategoryProposalsRequest = z.object({
  names: z.array(z.string().trim().min(1).max(100)).min(1).max(100),
});
export type AcceptCategoryProposalsRequest = z.output<typeof AcceptCategoryProposalsRequest>;

// ----- Insights: recurring proposals and anomaly flags (AI-08, AI-09) -------------------------------------

export const InsightKind = z.enum([
  'recurring',
  'unusual_amount',
  'duplicate_charge',
  'new_subscription',
  'price_increase',
]);
export const InsightDto = z.object({
  id: z.string(),
  kind: InsightKind,
  entityId: z.string(),
  transactionId: z.string().nullable(),
  payee: z.string().nullable(),
  /** One line for the UI, numbers computed in code (AIA-05). */
  message: z.string(),
  data: z.record(z.string(), z.unknown()),
  status: z.enum(['open', 'dismissed', 'accepted']),
  createdAt: z.string(),
});
export type InsightDto = z.infer<typeof InsightDto>;

/** Accepting a `recurring` insight creates a recurring template; overrides are optional. */
export const AcceptInsightRequest = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  categoryId: Id.optional(),
});
export type AcceptInsightRequest = z.output<typeof AcceptInsightRequest>;

// ----- Local-mode tasks (06 §2): parked for a client on the user's network ---------------------------------

export const AiTaskDto = z.object({
  id: z.string(),
  task: z.string(),
  /** Minimized input; the client sends it to the local endpoint as-is. */
  input: z.unknown(),
  createdAt: z.string(),
});
export type AiTaskDto = z.infer<typeof AiTaskDto>;

export const AiTaskResultRequest = z.object({ output: z.unknown() });
export type AiTaskResultRequest = z.output<typeof AiTaskResultRequest>;

// ----- Disclaimers (AIA-12, NFR-14) -----------------------------------------------------------------------

export const DISCLAIMER_KEYS = ['tax', 'financial'] as const;
