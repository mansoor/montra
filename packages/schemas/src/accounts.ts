import { z } from 'zod';
import { CalendarDateDto, CurrencyCodeDto, Id, MoneyDto } from './common.js';

export const BankAccountKind = z.enum([
  'checking',
  'savings',
  'credit_card',
  'cash',
  'loan',
  'mortgage',
  'line_of_credit',
  'investment',
  'asset',
  'liability',
]);
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
});
export type AccountDto = z.infer<typeof AccountDto>;

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
