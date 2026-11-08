import { z } from 'zod';
import { ACCOUNT_KINDS, BALANCE_RANGES, PAY_RULES, PLAN_TYPES } from '@montra/domain';
import { CalendarDateDto, CurrencyCodeDto, Id, MoneyDto } from './common.js';

export const BankAccountKind = z.enum(ACCOUNT_KINDS);
export const PlanTypeDto = z.enum(PLAN_TYPES);
export const PayRuleDto = z.enum(PAY_RULES);
const DayOfMonth = z.number().int().min(1).max(31);
export type BankAccountKind = z.infer<typeof BankAccountKind>;

export const CreateAccountRequest = z.object({
  /** Defaults to the Personal entity (ACC-03: each account has a default entity). */
  entityId: Id.optional(),
  name: z.string().trim().min(1).max(200),
  kind: BankAccountKind,
  currency: CurrencyCodeDto.optional(),
  institution: z.string().trim().max(200).optional(),
  last4: z
    .string()
    .regex(/^\d{4}$/)
    .optional(),
  /** Balance on the opening date in natural terms: money held for assets, amount owed for liabilities. */
  openingBalance: MoneyDto.optional(),
  openingDate: CalendarDateDto.optional(),
  defaultMemberId: Id.optional(),
  /** The optional facts its type can hold (ADR-0023). Minor units in the account currency. */
  creditLimit: z
    .string()
    .regex(/^\d{1,19}$/)
    .optional(),
  interestRateBps: z.number().int().min(0).max(10_000).optional(),
  minPayment: z
    .string()
    .regex(/^\d{1,19}$/)
    .optional(),
  lowBalance: z
    .string()
    .regex(/^-?\d{1,19}$/)
    .optional(),
  /** An investment account's plan, and the employer whose payslips pay into it (ADR-0025). */
  planType: PlanTypeDto.optional(),
  employerId: Id.optional(),
  /** Post the employer's contributions here too. */
  employerContributions: z.boolean().optional(),
  /** A card or line of credit's cycle and how it's paid (ADR-0026). */
  statementDay: DayOfMonth.optional(),
  dueDay: DayOfMonth.optional(),
  payFromAccountId: Id.optional(),
  payRule: PayRuleDto.optional(),
  payFixed: z
    .string()
    .regex(/^\d{1,19}$/)
    .optional(),
  /** A home or car: what it cost and when, and the loan against it (ADR-0027). */
  purchasePrice: z
    .string()
    .regex(/^\d{1,19}$/)
    .optional(),
  purchaseDate: CalendarDateDto.optional(),
  loanAccountId: Id.optional(),
  /** When an informal debt is due. */
  dueDate: CalendarDateDto.optional(),
});
export type CreateAccountRequest = z.output<typeof CreateAccountRequest>;

export const AccountDto = z.object({
  id: z.string(),
  entityId: z.string(),
  name: z.string(),
  kind: BankAccountKind,
  type: z.enum(['asset', 'liability']),
  currency: z.string(),
  institution: z.string().nullable(),
  last4: z.string().nullable(),
  /** Natural balance (held for assets, owed for liabilities). */
  balance: MoneyDto,
  archived: z.boolean(),
  /** Hidden from the current user's lists (preference, UP-04). */
  hidden: z.boolean(),
  defaultMemberId: z.string().nullable(),
  /** Set when its payments are tracked (ADR-0024). */
  loanId: z.string().nullable(),
  /** An investment account's plan and payslip link (ADR-0025). */
  planType: PlanTypeDto.nullable(),
  employerId: z.string().nullable(),
  employerContributions: z.boolean(),
  /** A card or line of credit's cycle and how it's paid (ADR-0026). */
  cycle: z.object({
    statementDay: z.number().int().nullable(),
    dueDay: z.number().int().nullable(),
    payFromAccountId: z.string().nullable(),
    payRule: PayRuleDto.nullable(),
    payFixed: z.string().nullable(),
  }),
  /** A home or car's purchase and the loan against it, and when an informal debt is due (ADR-0027). */
  purchasePrice: z.string().nullable(),
  purchaseDate: CalendarDateDto.nullable(),
  loanAccountId: z.string().nullable(),
  dueDate: CalendarDateDto.nullable(),
  /** Planning inputs (Phase 6): debt payoff and forecast warnings. Minor units in the account currency. */
  planning: z.object({
    creditLimit: z.string().nullable(),
    interestRateBps: z.number().int().nullable(),
    minPayment: z.string().nullable(),
    /** FLOW-03: the forecast warns below this balance. */
    lowBalance: z.string(),
  }),
});
export type AccountDto = z.infer<typeof AccountDto>;

export const BalanceRangeDto = z.enum(BALANCE_RANGES);
export type BalanceRangeDto = z.infer<typeof BalanceRangeDto>;

/** An account's balance over time, for its chart (ADR-0023). Only what this user may see. */
export const AccountBalanceHistoryDto = z.object({
  accountId: z.string(),
  currency: z.string(),
  range: BalanceRangeDto,
  /** Natural balance at the end of each date, oldest first: held for assets, owed for liabilities. */
  points: z.array(z.object({ date: CalendarDateDto, balance: z.string() })),
});
export type AccountBalanceHistoryDto = z.infer<typeof AccountBalanceHistoryDto>;

export const AccountValuationDto = z.object({
  id: Id,
  date: CalendarDateDto,
  /** What the account was worth, in its currency. */
  value: z.string(),
  /** The change in market value this posted: the value less what the ledger had that day. */
  change: z.string(),
  note: z.string().nullable(),
});
export type AccountValuationDto = z.infer<typeof AccountValuationDto>;

export const AddValuationsRequest = z.object({
  /** Oldest first. Each is checked against the ledger as it stood that day, after the ones before it. */
  values: z
    .array(
      z.object({
        date: CalendarDateDto,
        value: z.string().regex(/^\d{1,19}$/),
        note: z.string().trim().max(500).optional(),
      }),
    )
    .min(1)
    .max(600),
});
export type AddValuationsRequest = z.output<typeof AddValuationsRequest>;

const PerformanceFigures = {
  start: z.string(),
  end: z.string(),
  moneyIn: z.string(),
  moneyOut: z.string(),
  gain: z.string(),
  /** Basis points; null when nothing was at work, so a percentage would mean nothing. */
  returnBps: z.number().int().nullable(),
};

/** An investment account's gain over a period (ADR-0025). Account-level figures, never advice. */
export const InvestmentPerformanceDto = z.object({
  accountId: z.string(),
  currency: z.string(),
  range: BalanceRangeDto,
  /**
   * True when the account has private payslip money this user can't see. A gain worked out from the rest would be wrong,
   * so there are no figures.
   */
  hidden: z.boolean(),
  from: CalendarDateDto.nullable(),
  to: CalendarDateDto.nullable(),
  summary: z.object({ ...PerformanceFigures, annualizedBps: z.number().int().nullable() }).nullable(),
  points: z.array(z.object({ date: CalendarDateDto, value: z.string(), invested: z.string() })),
  periods: z.array(z.object({ from: CalendarDateDto, to: CalendarDateDto, ...PerformanceFigures })),
});
export type InvestmentPerformanceDto = z.infer<typeof InvestmentPerformanceDto>;

/** The latest statement of a card or line of credit, and what's still due on it (ADR-0026). Natural amounts: owed is positive. */
export const CardStatementDto = z.object({
  accountId: z.string(),
  name: z.string(),
  currency: z.string(),
  lastClose: CalendarDateDto,
  dueDate: CalendarDateDto,
  nextClose: CalendarDateDto,
  nextDueDate: CalendarDateDto,
  statementBalance: z.string(),
  paidSince: z.string(),
  due: z.string(),
  minimumDue: z.string(),
  owed: z.string(),
  /** Charged since the statement closed: what the next one will hold if nothing else changes. */
  sinceStatement: z.string(),
  limit: z.string().nullable(),
  available: z.string().nullable(),
  utilizationBps: z.number().int().nullable(),
  /** What the payment rule will pay on the due date, and from where. Null without a rule. */
  planned: z.object({ date: CalendarDateDto, amount: z.string(), fromAccountId: z.string() }).nullable(),
});
export type CardStatementDto = z.infer<typeof CardStatementDto>;

/** Interest paid into a savings account from 1 January to today (ADR-0027). */
export const InterestEarnedDto = z.object({
  accountId: z.string(),
  from: CalendarDateDto,
  to: CalendarDateDto,
  amount: z.string(),
  currency: z.string(),
});
export type InterestEarnedDto = z.infer<typeof InterestEarnedDto>;

export const CategoryDto = z.object({
  id: z.string(),
  entityId: z.string(),
  name: z.string(),
  type: z.enum(['income', 'expense']),
  group: z.string().nullable(),
  taxLineCode: z.string().nullable(),
});
export type CategoryDto = z.infer<typeof CategoryDto>;

export const RegisterView = z.enum(['ledger', 'simple']);

export const RegisterLineDto = z.object({
  date: z.string(),
  transactionId: z.string().nullable(),
  entryId: z.string(),
  description: z.string(),
  /** Ledger view (DE-06): debit/credit columns in minor units; null when empty. */
  debit: z.string().nullable(),
  credit: z.string().nullable(),
  /** Simple view: signed change to the natural balance. */
  amount: z.string(),
  runningBalance: z.string(),
  cleared: z.enum(['uncleared', 'cleared', 'reconciled']),
});
export type RegisterLineDto = z.infer<typeof RegisterLineDto>;

export const LedgerAccountDto = z.object({
  id: z.string(),
  entityId: z.string(),
  type: z.enum(['asset', 'liability', 'equity', 'income', 'expense']),
  subtype: z.string(),
  name: z.string(),
  currency: z.string(),
  isCategory: z.boolean(),
  systemRole: z.string().nullable(),
  counterpartyEntityId: z.string().nullable(),
  taxLineCode: z.string().nullable(),
  archived: z.boolean(),
});
export type LedgerAccountDto = z.infer<typeof LedgerAccountDto>;
