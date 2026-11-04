import { z } from 'zod';
import { CalendarDateDto, CurrencyCodeDto, Id } from './common.js';
import { MinorDto } from './budgets.js';

// ----- Recommendations (REC-01..08; design 04 §12, ADR-0015) -----------------------------------------------
// Computed in code; AI only words them (AIA-05). Nothing applies without the user's confirmation.

export const RECOMMENDATION_TYPES = [
  'REC-01',
  'REC-02',
  'REC-03',
  'REC-04',
  'REC-05',
  'REC-06',
  'REC-07',
  'REC-08',
  'REC-09',
  'BIZ-09',
  'BIZ-11',
] as const;
export const RecommendationType = z.enum(RECOMMENDATION_TYPES);
export type RecommendationType = z.infer<typeof RecommendationType>;

export const RecommendationStatus = z.enum(['open', 'accepted', 'edited', 'dismissed', 'expired']);
export type RecommendationStatus = z.infer<typeof RecommendationStatus>;

/** What accepting a recommendation does. Each one maps to an ordinary budget write. */
export const ProposedActionDto = z.discriminatedUnion('kind', [
  /** Set a category's assigned amount for the period (REC-01 cuts, REC-05 realistic amount, REC-08). */
  z.object({ kind: z.literal('assign'), categoryId: Id, from: MinorDto, to: MinorDto }),
  /** BUD-10 move; null = left to assign (REC-02 sources, REC-03 surplus allocation). */
  z.object({ kind: z.literal('move'), from: Id.nullable(), to: Id.nullable(), amount: MinorDto }),
  /** Advice only: spend at most this per day for the rest of the period (REC-02). */
  z.object({ kind: z.literal('reduce_daily'), categoryId: Id, perDay: MinorDto, days: z.number().int() }),
  /** Review or cancel a subscription (REC-06). */
  z.object({ kind: z.literal('review_subscription'), recurringItemId: Id }),
  /** Fund a goal (REC-03). */
  z.object({ kind: z.literal('fund_goal'), goalId: Id, amount: MinorDto }),
  /** Move money between accounts: tax savings (REC-09). */
  z.object({ kind: z.literal('transfer'), fromAccountId: Id, toAccountId: Id, amount: MinorDto }),
]);
export type ProposedActionDto = z.infer<typeof ProposedActionDto>;

/** The engine's numbers, per type; the AI wording may only restate these. */
export const RecommendationPayloadDto = z.object({
  currency: CurrencyCodeDto,
  /** Headline numbers, e.g. { deficit: "-25000" } or { overspend: "4100", daysLeft: "9" }. */
  figures: z.record(z.string(), z.string()),
  /** Categories, bills or subscriptions the recommendation is about. */
  subjects: z.array(z.object({ id: Id, name: z.string(), amount: MinorDto.nullable() })),
  actions: z.array(ProposedActionDto),
  /** REC-07 monthly review: totals, top leaks and next month's draft. */
  review: z
    .object({
      income: MinorDto,
      spent: MinorDto,
      saved: MinorDto,
      wentWell: z.array(z.string()),
      leaks: z.array(z.object({ categoryId: Id, name: z.string(), overBy: MinorDto })),
      nextMonth: z.array(z.object({ categoryId: Id, name: z.string(), suggested: MinorDto })),
    })
    .nullable(),
});
export type RecommendationPayloadDto = z.infer<typeof RecommendationPayloadDto>;

export const RecommendationDto = z.object({
  id: Id,
  type: RecommendationType,
  entityId: Id,
  budgetId: Id.nullable(),
  periodStart: CalendarDateDto,
  status: RecommendationStatus,
  /** Template title from the type and figures (always present). */
  title: z.string(),
  /** AI wording; null when AI is off or failed (the title and figures stand alone). */
  wording: z.string().nullable(),
  payload: RecommendationPayloadDto,
  createdAt: z.string(),
  resolvedAt: z.string().nullable(),
});
export type RecommendationDto = z.infer<typeof RecommendationDto>;

/** POST /recommendations/{id}/accept — optionally with edited actions (status `edited`). */
export const AcceptRecommendationRequest = z.object({
  actions: z.array(ProposedActionDto).max(50).optional(),
  /** The budget's version when actions write to it. */
  version: z.number().int().positive().optional(),
});
export type AcceptRecommendationRequest = z.output<typeof AcceptRecommendationRequest>;
