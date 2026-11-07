import { z } from 'zod';
import { ACCOUNT_KINDS, BALANCE_RANGES } from '@montra/domain';
import { CalendarDateDto, CurrencyCodeDto, Id, MoneyDto } from './common.js';

export const BankAccountKind = z.enum(ACCOUNT_KINDS);
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
