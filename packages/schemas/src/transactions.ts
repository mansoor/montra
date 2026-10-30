import { z } from 'zod';
import { CalendarDateDto, Id, MoneyDto } from './common.js';

export const SplitInput = z.object({
  /** A category, or any ledger account (e.g. mortgage principal, escrow) for advanced splits. */
  accountId: Id,
  amount: MoneyDto,
  memberId: Id.nullable().optional(),
  memo: z.string().max(500).optional(),
});

/**
 * Income or expense, optionally split (TXN-01..03). `amount` is signed from the account's view:
 * negative = money out (purchase), positive = money in (deposit, refund). Splits use the same sign.
 */
export const CreateTransactionRequest = z
  .object({
    date: CalendarDateDto,
    accountId: Id,
    amount: MoneyDto,
    payee: z.string().trim().max(200).optional(),
    description: z.string().trim().max(500).optional(),
    categoryId: Id.optional(),
    splits: z.array(SplitInput).min(1).max(250).optional(),
    memberId: Id.nullable().optional(),
    tags: z.array(z.string().trim().min(1).max(50)).max(20).optional(),
  })
  .refine((t) => !(t.categoryId && t.splits), {
    message: 'Use either categoryId or splits, not both',
    path: ['splits'],
  })
  .refine((t) => t.amount.amount !== '0', { message: 'Amount must not be zero', path: ['amount'] });
export type CreateTransactionRequest = z.output<typeof CreateTransactionRequest>;

export const CreateTransferRequest = z.object({
  date: CalendarDateDto,
  fromAccountId: Id,
  toAccountId: Id,
  /** Positive amount leaving the source account, in its currency. */
  amount: MoneyDto,
  /** Amount arriving in the destination account, required when currencies differ (CUR-08). */
  amountIn: MoneyDto.optional(),
  description: z.string().trim().max(500).optional(),
});
export type CreateTransferRequest = z.output<typeof CreateTransferRequest>;

export const PostingDto = z.object({
  lineNo: z.number().int(),
  accountId: z.string(),
  accountName: z.string(),
  debit: z.string().nullable(),
  credit: z.string().nullable(),
  currency: z.string(),
  memberId: z.string().nullable(),
  memo: z.string().nullable(),
});

export const JournalEntryDto = z.object({
  id: z.string(),
  entityId: z.string(),
  date: z.string(),
  kind: z.string(),
  description: z.string(),
  postings: z.array(PostingDto),
});

export const TransactionDto = z.object({
  id: z.string(),
  date: z.string(),
  payee: z.string().nullable(),
  description: z.string(),
  status: z.string(),
  reviewState: z.string(),
  source: z.string(),
  version: z.string(),
  entries: z.array(JournalEntryDto),
});
export type TransactionDto = z.infer<typeof TransactionDto>;
