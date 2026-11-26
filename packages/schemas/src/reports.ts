/** Reports, search and ask-your-data (RPT-01..06, RCP-09; ADR-0019, ADR-0058). */
import { z } from 'zod';
import { BankAccountKind } from './accounts.js';
import { MinorDto } from './budgets.js';
import { CalendarDateDto, CurrencyCodeDto, Id } from './common.js';
import { DrillDto } from './flow.js';

export const REPORT_TYPES = [
  'spending',
  'income-expense',
  'budget-actual',
  'cash-flow',
  'net-worth',
  'pnl',
  'schedule-c',
  'schedule-e',
  'general-ledger',
  'trial-balance',
  'balance-sheet',
  'by-member',
  'items',
] as const;
export const ReportType = z.enum(REPORT_TYPES);
export type ReportType = z.infer<typeof ReportType>;

/** How `spending` and `items` are grouped. */
export const ReportGroupBy = z.enum(['category', 'payee', 'tag', 'store', 'item']);
export type ReportGroupBy = z.infer<typeof ReportGroupBy>;

const commaList = z
  .union([z.string(), z.array(z.string())])
  .transform((v) => (Array.isArray(v) ? v : v.split(',').filter(Boolean)));

/** RPT-02: the same filters on every report. A report ignores the ones that mean nothing to it, and says which it used. */
export const ReportFilters = z.object({
  from: CalendarDateDto.optional(),
  to: CalendarDateDto.optional(),
  entityId: Id.optional(),
  accountIds: commaList.pipe(z.array(Id).max(100)).optional(),
  categoryIds: commaList.pipe(z.array(Id).max(200)).optional(),
  tags: commaList.pipe(z.array(z.string().min(1).max(100)).max(50)).optional(),
  propertyId: Id.optional(),
  memberId: z.union([Id, z.literal('household')]).optional(),
  groupBy: ReportGroupBy.optional(),
});
export type ReportFilters = z.output<typeof ReportFilters>;

export const ReportColumnKind = z.enum(['text', 'money', 'percent', 'date', 'number']);

export const ReportColumnDto = z.object({
  /** Also the message key: `reports.col.<key>`. */
  key: z.string(),
  kind: ReportColumnKind,
});
export type ReportColumnDto = z.infer<typeof ReportColumnDto>;

export const ReportRowDto = z.object({
  key: z.string(),
  /** Text, or a minor-unit string for money. Null shows as a dash. */
  cells: z.record(z.string(), z.string().nullable()),
  /** RPT-03: the transactions behind this row. */
  drill: DrillDto.nullable(),
  /** A heading or subtotal, drawn stronger. */
  emphasis: z.boolean(),
});
export type ReportRowDto = z.infer<typeof ReportRowDto>;

export const ReportDto = z.object({
  type: ReportType,
  from: CalendarDateDto,
  to: CalendarDateDto,
  currency: CurrencyCodeDto,
  columns: z.array(ReportColumnDto),
  rows: z.array(ReportRowDto),
  totals: z.record(z.string(), z.string().nullable()).nullable(),
  chart: z
    .object({
      kind: z.enum(['bar', 'line']),
      /** Column key for the labels. */
      x: z.string(),
      /** Column keys for the values. */
      y: z.array(z.string()),
    })
    .nullable(),
  /** Message keys for things the reader should know, such as `converted` or `truncated`. */
  notes: z.array(z.string()),
  /** The filters this report paid attention to, so the screen offers only those. */
  uses: z.array(z.string()),
});
export type ReportDto = z.infer<typeof ReportDto>;

export const ReportExportFormat = z.enum(['pdf', 'csv', 'xlsx']);
export type ReportExportFormat = z.infer<typeof ReportExportFormat>;

export const SavedReportDto = z.object({
  id: Id,
  name: z.string(),
  type: ReportType,
  filters: z.record(z.string(), z.unknown()),
  version: z.number().int(),
});
export type SavedReportDto = z.infer<typeof SavedReportDto>;

export const CreateSavedReportRequest = z.object({
  name: z.string().trim().min(1).max(200),
  type: ReportType,
  filters: z.record(z.string(), z.unknown()).default({}),
});
export type CreateSavedReportRequest = z.output<typeof CreateSavedReportRequest>;

// ----- Search (RPT-05) -----------------------------------------------------------------------------------

export const SearchTransactionDto = z.object({
  id: Id,
  date: CalendarDateDto,
  payee: z.string().nullable(),
  description: z.string(),
  amount: MinorDto.nullable(),
  currency: CurrencyCodeDto.nullable(),
  /** Why it matched, for the user: a note's text is shown here since it isn't in the list otherwise. */
  matchedNote: z.string().nullable(),
});

export const SearchResultsDto = z.object({
  query: z.string(),
  transactions: z.array(SearchTransactionDto),
  /** More matched than are shown. */
  moreTransactions: z.boolean(),
  payees: z.array(z.object({ name: z.string(), count: z.number().int(), lastDate: CalendarDateDto })),
  receipts: z.array(
    z.object({
      id: Id,
      merchant: z.string().nullable(),
      date: CalendarDateDto.nullable(),
      total: MinorDto.nullable(),
      currency: CurrencyCodeDto.nullable(),
      /** The words around the match in the receipt's text. */
      snippet: z.string().nullable(),
    }),
  ),
});
export type SearchResultsDto = z.infer<typeof SearchResultsDto>;

// ----- Ask-your-data (RPT-06) ------------------------------------------------------------------------------

export const AskRequest = z.object({
  question: z.string().trim().min(3).max(500),
  /** The account picked when several fit the question (ADR-0058); the question is asked again about it. */
  accountId: Id.optional(),
});
export type AskRequest = z.output<typeof AskRequest>;

/** What a question about one account asks (ADR-0058). `owed` and `balance` are answered alike, in the account's own words. */
export const ASK_ACCOUNT_TOPICS = ['payoff', 'owed', 'balance', 'next_payment', 'interest_paid'] as const;
export const AskAccountTopic = z.enum(ASK_ACCOUNT_TOPICS);
export type AskAccountTopic = z.infer<typeof AskAccountTopic>;

/**
 * answered: the figures for the topic. choose: several accounts fit the phrase equally, so `choices` lists them. no_match:
 * none fits. needs_tracking: a loan kept as just its balance, so only what's owed is known. not_applicable: the topic isn't
 * one this kind of account has, so only its balance is given. paid_off: a tracked loan with nothing left to pay.
 */
export const ASK_ACCOUNT_OUTCOMES = [
  'answered',
  'choose',
  'no_match',
  'needs_tracking',
  'not_applicable',
  'paid_off',
] as const;
export const AskAccountOutcome = z.enum(ASK_ACCOUNT_OUTCOMES);
export type AskAccountOutcome = z.infer<typeof AskAccountOutcome>;

export const AskAccountRef = z.object({ id: Id, name: z.string(), kind: BankAccountKind });
export type AskAccountRef = z.infer<typeof AskAccountRef>;

/** An answer about one account. Every figure comes from the code the account page uses (ADR-0058 §3). */
export const AskAccountDto = z.object({
  /** The account as the question named it. It's the asker's words, never an account name the AI was shown. */
  phrase: z.string(),
  topic: AskAccountTopic,
  outcome: AskAccountOutcome,
  /** The account answered about; null on choose and no_match. */
  account: AskAccountRef.nullable(),
  /** On choose: the accounts that fit equally well, by name. */
  choices: z.array(AskAccountRef),
  currency: CurrencyCodeDto.nullable(),
  /** What's owed on a debt, held in a bank or cash account, or worth for an investment or asset. */
  balance: MinorDto.nullable(),
  /** A tracked loan's last scheduled payment. */
  payoffDate: CalendarDateDto.nullable(),
  /** A tracked loan's payments still to make. */
  paymentsLeft: z.number().int().nullable(),
  interestRemaining: MinorDto.nullable(),
  /** A tracked loan's next unrecorded payment and its split. */
  next: z
    .object({
      date: CalendarDateDto,
      total: MinorDto,
      principal: MinorDto,
      interest: MinorDto,
      escrow: MinorDto,
    })
    .nullable(),
  /** Interest paid on a tracked loan since tracking began, from its recorded payments. */
  interestPaid: MinorDto.nullable(),
  /** Interest paid within each period the question named, by the recorded payments' schedule dates. */
  interestPeriods: z.array(
    z.object({ label: z.string(), from: CalendarDateDto, to: CalendarDateDto, amount: MinorDto }),
  ),
  /** Payments already in the balance when tracking began: their interest isn't known, so it isn't counted. */
  paymentsBefore: z.number().int().nullable(),
});
export type AskAccountDto = z.infer<typeof AskAccountDto>;

export const AskAnswerDto = z.object({
  question: z.string(),
  /** An amount over periods, or one account (ADR-0058). Older servers leave it out, which means amount. */
  kind: z.enum(['amount', 'account']).optional(),
  /** Set when kind is account; the amount fields are then empty. */
  account: AskAccountDto.optional(),
  /** False when the question couldn't be turned into something the books can answer. */
  understood: z.boolean(),
  metric: z.enum(['spending', 'income', 'net']).nullable(),
  /** What it was narrowed to, so the reader can check the question was understood. */
  categories: z.array(z.string()),
  payee: z.string().nullable(),
  currency: CurrencyCodeDto.nullable(),
  /** One number per period, each straight from a query, never from the model (AIA-05). */
  periods: z.array(
    z.object({
      label: z.string(),
      from: CalendarDateDto,
      to: CalendarDateDto,
      amount: MinorDto,
      drill: DrillDto,
    }),
  ),
  transactions: z.array(SearchTransactionDto),
});
export type AskAnswerDto = z.infer<typeof AskAnswerDto>;
