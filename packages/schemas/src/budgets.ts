import { z } from 'zod';
import { CalendarDateDto, CurrencyCodeDto, Id } from './common.js';
import { Cadence } from './ledger.js';

// ----- Budgets, goals and expected income (BUD-01..10, FAM-06/07, UP-11; design 04 §8, ADR-0015) ----------
// Budget amounts are in the entity's functional currency; the DTO carries it once at the top.

/** Minor units as an integer string. */
export const MinorDto = z.string().regex(/^-?\d{1,19}$/, 'Amount must be an integer number of minor units');
const PositiveMinor = MinorDto.refine((s) => BigInt(s) > 0n, 'Amount must be positive');
const NonNegativeMinor = MinorDto.refine((s) => BigInt(s) >= 0n, 'Amount must not be negative');
/** The budget's version, from the last read (optimistic concurrency for periods, lines and moves). */
const Version = z.number().int().positive();

export const BUDGET_METHODS = ['zero_based', 'category_limits', 'light'] as const;
export const BudgetMethod = z.enum(BUDGET_METHODS);
export type BudgetMethod = z.infer<typeof BudgetMethod>;

export const BUDGET_PERIOD_TYPES = ['monthly', 'weekly', 'biweekly'] as const;
export const BudgetPeriodType = z.enum(BUDGET_PERIOD_TYPES);
export type BudgetPeriodType = z.infer<typeof BudgetPeriodType>;

export const ROLLOVER_MODES = ['carry_surplus', 'carry_deficit', 'carry_both', 'reset'] as const;
export const RolloverMode = z.enum(ROLLOVER_MODES);
export type RolloverMode = z.infer<typeof RolloverMode>;

export const CATEGORY_GROUP_KINDS = [
  'income',
  'fixed',
  'daily',
  'fun',
  'savings',
  'debt',
  'business',
  'rental',
  'system',
] as const;
export const CategoryGroupKind = z.enum(CATEGORY_GROUP_KINDS);
export type CategoryGroupKind = z.infer<typeof CategoryGroupKind>;

export const CreateBudgetRequest = z
  .object({
    entityId: Id,
    /** FAM-06: a member budget filters the same activity to that member. */
    memberId: Id.nullable().default(null),
    name: z.string().trim().min(1).max(200),
    method: BudgetMethod.default('zero_based'),
    periodType: BudgetPeriodType.default('monthly'),
    /** Weekly/biweekly: the first day of a period (usually a payday). */
    anchorDate: CalendarDateDto.nullable().default(null),
    /** UP-11 light mode: "pay yourself first" savings per period. */
    savingsTarget: NonNegativeMinor.nullable().default(null),
  })
  .refine((b) => b.periodType === 'monthly' || b.anchorDate !== null, {
    message: 'Weekly and biweekly budgets need an anchor date',
    path: ['anchorDate'],
  });
export type CreateBudgetRequest = z.output<typeof CreateBudgetRequest>;

export const UpdateBudgetRequest = z
  .object({
    name: z.string().trim().min(1).max(200),
    method: BudgetMethod,
    savingsTarget: NonNegativeMinor.nullable(),
    archived: z.boolean(),
  })
  .partial()
  .extend({ version: Version });
export type UpdateBudgetRequest = z.output<typeof UpdateBudgetRequest>;

export const BudgetDto = z.object({
  id: Id,
  entityId: Id,
  memberId: Id.nullable(),
  name: z.string(),
  method: BudgetMethod,
  periodType: BudgetPeriodType,
  anchorDate: CalendarDateDto.nullable(),
  savingsTarget: MinorDto.nullable(),
  currency: CurrencyCodeDto,
  archived: z.boolean(),
  version: z.number().int(),
});
export type BudgetDto = z.infer<typeof BudgetDto>;

/** FLOW-04 spending pace for one category in the current period. */
export const PaceDto = z.object({
  /** assigned × elapsed ÷ period days (or the category's day-of-month pattern). */
  expectedByToday: MinorDto,
  /** Activity extrapolated to the period end. */
  projected: MinorDto,
  /** `over`: activity ≥ 110% of expected and projected ≥ 110% of assigned (REC-02). */
  status: z.enum(['under', 'on_track', 'over']),
});
export type PaceDto = z.infer<typeof PaceDto>;

export const BudgetLineDto = z.object({
  categoryId: Id,
  name: z.string(),
  assigned: MinorDto,
  carriedIn: MinorDto,
  /** Spending positive; refunds reduce it. Savings/debt categories count contributions (04 §8). */
  activity: MinorDto,
  /** Net moves into the category this period (BUD-10). */
  moved: MinorDto,
  /** carriedIn + assigned + moved − activity. */
  available: MinorDto,
  rolloverMode: RolloverMode,
  pace: PaceDto.nullable(),
  /** BUD-07: the sinking fund or goal funded by this category, with this period's contribution. */
  goal: z.object({ goalId: Id, monthlyNeeded: MinorDto }).nullable(),
});
export type BudgetLineDto = z.infer<typeof BudgetLineDto>;

export const BudgetGroupDto = z.object({
  id: Id,
  name: z.string(),
  kind: CategoryGroupKind,
  assigned: MinorDto,
  activity: MinorDto,
  available: MinorDto,
  lines: z.array(BudgetLineDto),
});
export type BudgetGroupDto = z.infer<typeof BudgetGroupDto>;

/** BUD-01 50/30/20 view: needs (fixed, daily), wants (fun) and savings (savings, debt) by group kind. */
export const FiftyThirtyTwentyDto = z.object({
  base: MinorDto,
  needs: z.object({ amount: MinorDto, percent: z.number() }),
  wants: z.object({ amount: MinorDto, percent: z.number() }),
  savings: z.object({ amount: MinorDto, percent: z.number() }),
});

export const BudgetPeriodDto = z.object({
  budget: BudgetDto,
  start: CalendarDateDto,
  end: CalendarDateDto,
  status: z.enum(['open', 'closed']),
  /** Today falls inside the period (pace applies). */
  current: z.boolean(),
  income: z.object({
    /** Entered for the period, or derived from expected income (BUD-03). */
    expected: MinorDto,
    /** Net deposits to income categories so far. */
    actual: MinorDto,
    /** Expected, with each income item replaced by its actual deposit once it arrives (04 §8). */
    budgeted: MinorDto,
    /** Expected income items for the period and whether they have arrived. */
    items: z.array(
      z.object({
        expectedIncomeId: Id,
        name: z.string(),
        date: CalendarDateDto,
        expected: MinorDto,
        actual: MinorDto.nullable(),
      }),
    ),
  }),
  carriedUnassigned: MinorDto,
  assigned: MinorDto,
  activity: MinorDto,
  available: MinorDto,
  /** budgeted income + carried unassigned − Σ assigned. Negative = over-assigned (REC-01). */
  leftToAssign: MinorDto,
  groups: z.array(BudgetGroupDto),
  /** Spending in categories without a budget line (shown so nothing is hidden). */
  unbudgeted: z.array(z.object({ categoryId: Id, name: z.string(), activity: MinorDto })),
  /** UP-11 light mode. */
  light: z
    .object({
      savingsTarget: MinorDto,
      saved: MinorDto,
      everythingElse: z.object({ available: MinorDto, activity: MinorDto, budget: MinorDto }),
    })
    .nullable(),
  fiftyThirtyTwenty: FiftyThirtyTwentyDto,
});
export type BudgetPeriodDto = z.infer<typeof BudgetPeriodDto>;

/** PUT /budgets/{id}/periods/{start}/lines/{categoryId} */
export const AssignRequest = z.object({
  assigned: NonNegativeMinor,
  rolloverMode: RolloverMode.optional(),
  version: Version,
});
export type AssignRequest = z.output<typeof AssignRequest>;

/** POST /budgets/{id}/periods/{start}/moves — null = "left to assign" (BUD-10). */
export const MoveRequest = z
  .object({
    from: Id.nullable(),
    to: Id.nullable(),
    amount: PositiveMinor,
    note: z.string().trim().max(500).optional(),
    version: Version,
  })
  .refine((m) => m.from !== m.to, { message: 'Move between two different categories', path: ['to'] });
export type MoveRequest = z.output<typeof MoveRequest>;

export const BudgetMoveDto = z.object({
  id: Id,
  from: Id.nullable(),
  to: Id.nullable(),
  amount: MinorDto,
  note: z.string().nullable(),
  movedBy: Id.nullable(),
  movedAt: z.string(),
});
export type BudgetMoveDto = z.infer<typeof BudgetMoveDto>;

/** POST /budgets/{id}/periods/{start}/copy (BUD-09). Lines already set are kept unless `overwrite`. */
export const CopyBudgetRequest = z.object({
  from: z.enum(['last', 'avg3']),
  overwrite: z.boolean().default(false),
  version: Version,
});
export type CopyBudgetRequest = z.output<typeof CopyBudgetRequest>;

/** PATCH /budgets/{id}/periods/{start}: the period's expected income override. */
export const UpdateBudgetPeriodRequest = z.object({
  expectedIncome: NonNegativeMinor.nullable(),
  version: Version,
});
export type UpdateBudgetPeriodRequest = z.output<typeof UpdateBudgetPeriodRequest>;

/** POST /budgets/draft (BUD-02): numbers from history; AI only writes the explanation. */
export const DraftBudgetRequest = z.object({
  entityId: Id,
  months: z.number().int().min(1).max(3).default(3),
});
export type DraftBudgetRequest = z.output<typeof DraftBudgetRequest>;

export const DraftBudgetLineDto = z.object({
  categoryId: Id,
  name: z.string(),
  groupKind: CategoryGroupKind,
  /** Median of the last 1–3 months, or the recurring bill amount when there is no history. */
  suggested: MinorDto,
  history: z.array(MinorDto),
  fixed: z.boolean(),
  source: z.enum(['history', 'recurring']),
});
export type DraftBudgetLineDto = z.infer<typeof DraftBudgetLineDto>;

export const DraftBudgetDto = z.object({
  entityId: Id,
  currency: CurrencyCodeDto,
  months: z.array(CalendarDateDto),
  expectedIncome: MinorDto,
  lines: z.array(DraftBudgetLineDto),
  /** AI explanation; null when AI is off or failed (the numbers stand on their own). */
  explanation: z.string().nullable(),
});
export type DraftBudgetDto = z.infer<typeof DraftBudgetDto>;

/** GET/PATCH /planning/settings: inputs to the recommendation rules (workspace.priorities). */
export const PlanningSettingsDto = z.object({
  /** REC-01: category id → 1 (cut first) … 5 (protect). Unlisted categories are 3. */
  categoryPriorities: z.record(z.string(), z.number().int().min(1).max(5)),
  /** REC-03: debts at or above this APR (basis points) count as high-interest. */
  highInterestBps: z.number().int().min(0).max(10_000),
});
export type PlanningSettingsDto = z.infer<typeof PlanningSettingsDto>;
export const UpdatePlanningSettingsRequest = PlanningSettingsDto.partial();
export type UpdatePlanningSettingsRequest = z.output<typeof UpdatePlanningSettingsRequest>;

// ----- Goals and sinking funds (BUD-07, BUD-08, FAM-07) ----------------------------------------------------

export const GOAL_TYPES = ['emergency_fund', 'debt_payoff', 'savings', 'sinking_fund'] as const;
export const GoalType = z.enum(GOAL_TYPES);
export type GoalType = z.infer<typeof GoalType>;

const GoalFields = z.object({
  entityId: Id,
  memberId: Id.nullable().default(null),
  name: z.string().trim().min(1).max(200),
  type: GoalType,
  target: PositiveMinor.nullable().default(null),
  dueDate: CalendarDateDto.nullable().default(null),
  /** The budget category that funds it (savings or debt group). */
  categoryId: Id.nullable().default(null),
  strategy: z.enum(['snowball', 'avalanche']).nullable().default(null),
  /** Savings accounts (progress = their balance) or debts (payoff plan). */
  linkedAccountIds: z.array(Id).max(20).default([]),
  /** Debt payoff: paid on top of the minimums each month. */
  extraPayment: NonNegativeMinor.nullable().default(null),
});

export const CreateGoalRequest = GoalFields.refine(
  (g) => g.type !== 'sinking_fund' || (g.target !== null && g.dueDate !== null),
  { message: 'A sinking fund needs a target and a due date', path: ['dueDate'] },
).refine((g) => g.type !== 'debt_payoff' || g.strategy !== null, {
  message: 'Choose snowball or avalanche',
  path: ['strategy'],
});
export type CreateGoalRequest = z.output<typeof CreateGoalRequest>;

export const UpdateGoalRequest = GoalFields.omit({ entityId: true, type: true })
  .partial()
  .extend({ archived: z.boolean().optional(), version: z.number().int().positive() });
export type UpdateGoalRequest = z.output<typeof UpdateGoalRequest>;

export const DebtPayoffDto = z.object({
  strategy: z.enum(['snowball', 'avalanche']),
  monthlyPayment: MinorDto,
  /** Null when the payments never cover the interest. */
  payoffDate: CalendarDateDto.nullable(),
  months: z.number().int().nullable(),
  totalInterest: MinorDto.nullable(),
  debts: z.array(
    z.object({
      accountId: Id,
      name: z.string(),
      balance: MinorDto,
      rateBps: z.number().int(),
      minPayment: MinorDto,
      payoffDate: CalendarDateDto.nullable(),
      interest: MinorDto.nullable(),
    }),
  ),
  /** The same debts paid with the other strategy, for comparison. */
  alternative: z.object({ payoffDate: CalendarDateDto.nullable(), totalInterest: MinorDto.nullable() }),
});
export type DebtPayoffDto = z.infer<typeof DebtPayoffDto>;

export const GoalDto = z.object({
  id: Id,
  entityId: Id,
  memberId: Id.nullable(),
  name: z.string(),
  type: GoalType,
  target: MinorDto.nullable(),
  dueDate: CalendarDateDto.nullable(),
  categoryId: Id.nullable(),
  strategy: z.enum(['snowball', 'avalanche']).nullable(),
  linkedAccountIds: z.array(Id),
  extraPayment: MinorDto.nullable(),
  currency: CurrencyCodeDto,
  progress: z.object({
    /** Saved so far (linked balances or the category's available), or debt paid down. */
    saved: MinorDto,
    /** 0–100, null without a target. */
    percent: z.number().nullable(),
    /** BUD-07: ceil((target − saved) / months remaining). */
    monthlyNeeded: MinorDto.nullable(),
    /** Average contribution over the last 3 months. */
    monthlyAverage: MinorDto,
    /** Linear projection (BUD-08); null when nothing is being added. */
    projectedCompletion: CalendarDateDto.nullable(),
    onTrack: z.boolean().nullable(),
  }),
  payoff: DebtPayoffDto.nullable(),
  archived: z.boolean(),
  version: z.number().int(),
});
export type GoalDto = z.infer<typeof GoalDto>;

// ----- Expected income (BUD-03, REC-03/04/08) ---------------------------------------------------------------

export const ExpectedIncomeSource = z.enum(['salary', 'business', 'rent', 'other']);

export const CreateExpectedIncomeRequest = z.object({
  entityId: Id,
  memberId: Id.nullable().default(null),
  name: z.string().trim().min(1).max(200),
  sourceType: ExpectedIncomeSource,
  /** Take-home amount per occurrence. */
  amount: PositiveMinor,
  currency: CurrencyCodeDto,
  cadence: Cadence,
  nextDate: CalendarDateDto,
  /** Where it lands (forecast); also used to match the deposit. */
  accountId: Id.nullable().default(null),
  /** The payer as it appears on the deposit (normalized payee key), for matching. */
  payee: z.string().trim().max(200).nullable().default(null),
});
export type CreateExpectedIncomeRequest = z.output<typeof CreateExpectedIncomeRequest>;

export const UpdateExpectedIncomeRequest = CreateExpectedIncomeRequest.omit({ entityId: true })
  .partial()
  .extend({ active: z.boolean().optional(), version: z.number().int().positive() });
export type UpdateExpectedIncomeRequest = z.output<typeof UpdateExpectedIncomeRequest>;

export const ExpectedIncomeDto = z.object({
  id: Id,
  entityId: Id,
  memberId: Id.nullable(),
  name: z.string(),
  sourceType: ExpectedIncomeSource,
  amount: MinorDto,
  currency: CurrencyCodeDto,
  cadence: Cadence,
  nextDate: CalendarDateDto,
  accountId: Id.nullable(),
  payee: z.string().nullable(),
  active: z.boolean(),
  version: z.number().int(),
});
export type ExpectedIncomeDto = z.infer<typeof ExpectedIncomeDto>;
