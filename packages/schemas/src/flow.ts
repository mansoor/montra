import { z } from 'zod';
import { CalendarDateDto, CurrencyCodeDto, Id } from './common.js';
import { MinorDto, PaceDto } from './budgets.js';

// ----- Money flow (FLOW-01..07, FAM-09, UP-14; design 04 §11, ADR-0015) -------------------------------------
// Every number links to the transactions behind it: `drill` is a transactions-list filter (exit criterion).

/** A transactions-list filter that reproduces a number (GET /transactions query parameters). */
export const DrillDto = z.object({
  entityId: Id.optional(),
  memberId: z.union([Id, z.literal('household')]).optional(),
  propertyId: Id.optional(),
  categoryIds: z.array(Id).optional(),
  accountIds: z.array(Id).optional(),
  /** The search syntax (RPT-05): a payee or tag behind a report's row. */
  q: z.string().optional(),
  from: CalendarDateDto.optional(),
  to: CalendarDateDto.optional(),
});
export type DrillDto = z.infer<typeof DrillDto>;

export const CALENDAR_ITEM_KINDS = [
  'bill',
  'payday',
  'scheduled',
  'goal_due',
  'card_due',
  'invoice',
  'tax_due',
  'rent',
  'mortgage',
  'lease_end',
  'reminder',
] as const;

/** FLOW-05 / UP-14: an upcoming bill, payday or due date. */
export const CalendarItemDto = z.object({
  date: CalendarDateDto,
  kind: z.enum(CALENDAR_ITEM_KINDS),
  name: z.string(),
  /** Signed: income positive, bills negative. Variable bills show their average. */
  amount: MinorDto,
  currency: CurrencyCodeDto,
  variable: z.boolean(),
  /** recurring_item, expected_income or goal id. */
  sourceId: Id,
  accountId: Id.nullable(),
  status: z.enum(['upcoming', 'paid', 'overdue']),
  /** UP-14/REC-06: the last amount rose more than 5% over the previous stable amount. */
  priceChange: z.object({ previous: MinorDto, current: MinorDto, percent: z.number() }).nullable(),
});
export type CalendarItemDto = z.infer<typeof CalendarItemDto>;

export const CalendarDto = z.object({
  from: CalendarDateDto,
  to: CalendarDateDto,
  items: z.array(CalendarItemDto),
});
export type CalendarDto = z.infer<typeof CalendarDto>;

export const NetWorthPointDto = z.object({
  date: CalendarDateDto,
  assets: MinorDto,
  liabilities: MinorDto,
  netWorth: MinorDto,
});

/** FLOW-07: assets minus liabilities, in the workspace base currency. */
export const NetWorthDto = z.object({
  date: CalendarDateDto,
  currency: CurrencyCodeDto,
  assets: MinorDto,
  liabilities: MinorDto,
  netWorth: MinorDto,
  accounts: z.array(
    z.object({
      accountId: Id,
      entityId: Id,
      name: z.string(),
      kind: z.enum(['asset', 'liability']),
      /** Account currency. */
      balance: MinorDto,
      accountCurrency: CurrencyCodeDto,
      /** Converted to the base currency at the date's rate. */
      value: MinorDto,
    }),
  ),
  /** FLOW-07: your share of each property's value, in the base currency. In `assets`, from its purchase date. */
  properties: z.array(z.object({ propertyId: Id, entityId: Id, name: z.string(), value: MinorDto })),
  /** Month ends (and today) for the trend chart. */
  trend: z.array(NetWorthPointDto),
});
export type NetWorthDto = z.infer<typeof NetWorthDto>;

/** GET /dashboard?entityId&memberId — the home numbers in one round trip (FLOW-01, FAM-09). */
export const DashboardDto = z.object({
  entityId: Id.nullable(),
  memberId: Id.nullable(),
  currency: CurrencyCodeDto,
  period: z.object({ start: CalendarDateDto, end: CalendarDateDto }),
  budgetId: Id.nullable(),
  income: z.object({ amount: MinorDto, drill: DrillDto }),
  spent: z.object({ amount: MinorDto, drill: DrillDto }),
  /** Σ available of the spending categories; null without a budget. */
  leftToSpend: MinorDto.nullable(),
  leftToAssign: MinorDto.nullable(),
  /** The categories furthest over pace (FLOW-04), at most 5. */
  pace: z.array(
    z.object({
      categoryId: Id,
      name: z.string(),
      assigned: MinorDto,
      activity: MinorDto,
      pace: PaceDto,
      drill: DrillDto,
    }),
  ),
  /** Next 14 days. */
  upcoming: z.array(CalendarItemDto),
  netWorth: z.object({ current: MinorDto, trend: z.array(NetWorthPointDto) }),
  lowBalance: z.array(
    z.object({ accountId: Id, name: z.string(), date: CalendarDateDto, balance: MinorDto }),
  ),
  openRecommendations: z.number().int(),
});
export type DashboardDto = z.infer<typeof DashboardDto>;

/** The periods the Home charts offer, in months (the current month is the last). */
export const CHART_MONTHS = [3, 6, 12, 24] as const;
export const DashboardChartsQuery = z.object({
  entityId: Id.optional(),
  memberId: Id.optional(),
  months: z.coerce
    .number()
    .int()
    .refine((n) => (CHART_MONTHS as readonly number[]).includes(n), 'months must be 3, 6, 12 or 24')
    .default(6),
});
export type DashboardChartsQuery = z.output<typeof DashboardChartsQuery>;

const InsightRow = z.object({ categoryId: Id, name: z.string(), drill: DrillDto });

/**
 * GET /dashboard/charts?months&entityId&memberId — what the Home charts show, worked out on the server so web and phone
 * agree (FLOW-01, FAM-09). Spending and income count the way the dashboard tiles do.
 */
export const DashboardChartsDto = z.object({
  entityId: Id,
  memberId: Id.nullable(),
  currency: CurrencyCodeDto,
  months: z.number().int(),
  /** One per calendar month, oldest first; the last is the current month so far. */
  monthly: z.array(
    z.object({
      start: CalendarDateDto,
      end: CalendarDateDto,
      income: MinorDto,
      spending: MinorDto,
      /** income − spending. */
      net: MinorDto,
      /** At the month's end (today for the current month), in the base currency. */
      netWorth: MinorDto,
    }),
  ),
  /**
   * The budget so far this period: the categories furthest from where the budget expects them today, at most 5.
   * Paced (day-to-day) categories compare with the budget pro rata; others only count once they're over.
   * Null without a budget.
   */
  budget: z
    .object({
      budgetId: Id,
      period: z.object({ start: CalendarDateDto, end: CalendarDateDto }),
      rows: z.array(
        InsightRow.extend({
          assigned: MinorDto,
          spent: MinorDto,
          expected: MinorDto,
          /** spent − expected: positive is over, negative is under. */
          difference: MinorDto,
        }),
      ),
    })
    .nullable(),
  /** Where the money went this month: the top 5 spending categories and the month's total. */
  topSpending: z.object({
    period: z.object({ start: CalendarDateDto, end: CalendarDateDto }),
    total: MinorDto,
    rows: z.array(InsightRow.extend({ amount: MinorDto })),
  }),
  /** Last full month against the three before it: the 5 biggest changes, either way. */
  changes: z.object({
    period: z.object({ start: CalendarDateDto, end: CalendarDateDto }),
    rows: z.array(
      InsightRow.extend({
        amount: MinorDto,
        /** The average of the three months before. */
        usual: MinorDto,
        /** amount − usual. */
        difference: MinorDto,
      }),
    ),
  }),
});
export type DashboardChartsDto = z.infer<typeof DashboardChartsDto>;

export const SANKEY_NODE_KINDS = [
  'income',
  'entity',
  'group',
  'category',
  'savings',
  'debt',
  'transfer',
  'unspent',
  'deficit',
] as const;

/** FLOW-02: income sources → entity → category groups → categories, plus savings/debt (FLOW-06 transfers apart). */
export const SankeyDto = z.object({
  from: CalendarDateDto,
  to: CalendarDateDto,
  currency: CurrencyCodeDto,
  nodes: z.array(
    z.object({
      id: z.string(),
      kind: z.enum(SANKEY_NODE_KINDS),
      label: z.string(),
      value: MinorDto,
      drill: DrillDto.nullable(),
    }),
  ),
  links: z.array(z.object({ source: z.string(), target: z.string(), value: MinorDto })),
});
export type SankeyDto = z.infer<typeof SankeyDto>;

/** A forecast driver: one item moving an account's balance on a date. */
export const ForecastItemDto = z.object({
  date: CalendarDateDto,
  kind: z.enum(['recurring', 'income', 'card_payment', 'burn', 'invoice', 'bill', 'rent', 'mortgage']),
  name: z.string(),
  amount: MinorDto,
  sourceId: Id.nullable(),
});
export type ForecastItemDto = z.infer<typeof ForecastItemDto>;

/** GET /flow/forecast?days=30|60|90 (FLOW-03): daily balances per cash and card account. */
export const ForecastDto = z.object({
  from: CalendarDateDto,
  days: z.number().int(),
  accounts: z.array(
    z.object({
      accountId: Id,
      name: z.string(),
      kind: z.enum(['cash', 'card']),
      currency: CurrencyCodeDto,
      threshold: MinorDto,
      start: MinorDto,
      /** One balance per day, from `from` (end of day). */
      balances: z.array(MinorDto),
      items: z.array(ForecastItemDto),
      /** The first day below the threshold, and the items that drive it. */
      lowBalance: z
        .object({ date: CalendarDateDto, balance: MinorDto, drivers: z.array(ForecastItemDto) })
        .nullable(),
    }),
  ),
});
export type ForecastDto = z.infer<typeof ForecastDto>;
