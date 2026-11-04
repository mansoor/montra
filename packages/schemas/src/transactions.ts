import { z } from 'zod';
import { CalendarDateDto, Id, MoneyDto } from './common.js';
import { CategorizationDto, MerchantDto } from './ai.js';
import { ForeignAmountDto, ForeignAmountInput, RateDto } from './fx.js';

export const SplitInput = z.object({
  /** A category, or any ledger account (e.g. mortgage principal, escrow) for advanced splits. */
  accountId: Id,
  amount: MoneyDto,
  memberId: Id.nullable().optional(),
  memo: z.string().max(500).optional(),
  /** RNT-06: the property and unit this part belongs to. */
  propertyId: Id.nullable().optional(),
  unitId: Id.nullable().optional(),
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
    /** RNT-06: tags every split, unless a split says otherwise. */
    propertyId: Id.nullable().optional(),
    unitId: Id.nullable().optional(),
    memo: z.string().max(2000).optional(),
    tags: z.array(z.string().trim().min(1).max(50)).max(20).optional(),
    /**
     * Foreign-currency account (CUR-05, CUR-07): functional units per account unit. Omitted: the day's
     * reference rate.
     */
    fxRate: RateDto.optional(),
    /**
     * A purchase in another currency on this account (CUR-03): the original amount, an optional rate
     * override, and a foreign transaction fee included in `amount` that posts to Bank fees.
     */
    foreign: ForeignAmountInput.optional(),
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
  /** Rate overrides (functional per unit) for foreign-currency legs; implied or reference otherwise. */
  fxRateFrom: RateDto.optional(),
  fxRateTo: RateDto.optional(),
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
  /** True for income/expense categories; false for bank, card, transfer and owner-equity lines. */
  isCategory: z.boolean(),
  systemRole: z.string().nullable(),
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
  /** How the category was chosen (AI-06); null for entries made before Phase 3 or with no category step. */
  categorization: CategorizationDto.nullable(),
  /** Merchant enrichment (AI-07) when the payee is a known merchant. */
  merchant: MerchantDto.nullable(),
  source: z.string(),
  version: z.string(),
  memo: z.string().nullable(),
  tags: z.array(z.string()),
  recurringItemId: z.string().nullable(),
  /** CUR-03: the original foreign amount and rate when the purchase was made in another currency. */
  foreign: ForeignAmountDto.nullable(),
  /** Travel mode (CUR-09). */
  tripId: z.string().nullable(),
  /** The receipt's wall-clock time, 'HH:MM:SS' (TZ-03); `date` stays the statement date. */
  localTime: z.string().nullable(),
  /** Paying account (standard) or source account (transfer), from the stored input; null for journals. */
  accountId: z.string().nullable(),
  /** The categorization as entered (also present on scheduled occurrences that have no entries yet). */
  splits: z
    .array(
      z.object({
        accountId: z.string(),
        amount: z.string(),
        memberId: z.string().nullable(),
        memo: z.string().nullable(),
        propertyId: z.string().nullable(),
        unitId: z.string().nullable(),
      }),
    )
    .nullable(),
  /** Signed amount from the paying account's view (negative = money out); null for manual journals. */
  amount: MoneyDto.nullable(),
  /** Scheduled occurrences have no entries until confirmed. */
  entries: z.array(JournalEntryDto),
});
export type TransactionDto = z.infer<typeof TransactionDto>;
