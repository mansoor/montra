import { z } from 'zod';
import { CalendarDateDto, CurrencyCodeDto, Id, MoneyDto } from './common.js';

// ----- Rates (CUR-05, ADR-0014) --------------------------------------------------------------------------

/** A positive decimal rate as a string, never a float: "1.0912". 1 `base` = `rate` `quote`. */
export const RateDto = z.string().regex(/^\d{1,10}(\.\d{1,10})?$/, 'Expected a positive decimal rate');
export type RateDto = z.output<typeof RateDto>;

export const FX_RATE_SOURCES = ['ecb', 'oxr'] as const;
/** Where a transaction's rate came from (`transaction.fx_rate_source`). */
export const FX_RATE_ORIGINS = ['implied', 'reference', 'user'] as const;

export const FxRateQuery = z.object({
  base: CurrencyCodeDto,
  quote: CurrencyCodeDto,
  date: CalendarDateDto,
});
export type FxRateQuery = z.output<typeof FxRateQuery>;

export const FxRateDto = z.object({
  base: z.string(),
  quote: z.string(),
  rate: RateDto,
  /** The day the rate was published; earlier than the requested date on weekends and holidays. */
  rateDate: z.string(),
  requestedDate: z.string(),
  source: z.enum(FX_RATE_SOURCES),
  /** True when derived through a third currency (EUR for ECB, USD for OXR). */
  cross: z.boolean(),
});
export type FxRateDto = z.infer<typeof FxRateDto>;

// ----- Foreign amounts on transactions (CUR-03/05) -------------------------------------------------------

/**
 * The four values of a foreign purchase: original amount and currency, the home amount (the transaction's
 * own amount), the rate, and an optional foreign transaction fee posted to the entity's Bank fees account.
 */
export const ForeignAmountInput = z.object({
  original: MoneyDto,
  /** Overrides the implied rate (CUR-05). Omitted: implied from the two amounts, else the day's reference rate. */
  rate: RateDto.optional(),
  /** Positive fee in the account's currency, charged on the same statement line. */
  fee: MoneyDto.optional(),
});
export type ForeignAmountInput = z.output<typeof ForeignAmountInput>;

export const ForeignAmountDto = z.object({
  original: MoneyDto,
  /** Home currency per original unit. */
  rate: RateDto,
  rateSource: z.enum(FX_RATE_ORIGINS),
  fee: MoneyDto.nullable(),
});
export type ForeignAmountDto = z.infer<typeof ForeignAmountDto>;

/** CUR-05: set or clear the rate on a transaction; the entries are re-posted through the DE-10 rules. */
export const SetTransactionRateRequest = z.object({
  rate: RateDto.nullable(),
  version: z.string(),
});
export type SetTransactionRateRequest = z.output<typeof SetTransactionRateRequest>;

// ----- Transfers between currencies (CUR-08) -------------------------------------------------------------

/**
 * A transfer between currencies against the market (CUR-08): the rate it got, the reference rate for its date,
 * and the gap in the base currency of the books it leaves from.
 */
export const TransferFxDto = z.object({
  /** Amount that left the source account, in its currency. */
  sent: MoneyDto,
  /** Amount that arrived, in the destination account's currency. */
  received: MoneyDto,
  /** Received units per one unit sent, implied by the two amounts. */
  effectiveRate: RateDto,
  /** The reference rate (received per sent) for the date; null when no rate is stored for it. */
  marketRate: RateDto.nullable(),
  /** The day that rate was published: up to a week before the transfer on weekends and holidays. */
  marketRateDate: z.string().nullable(),
  /** The source account's books' base (functional) currency, which `cost` is in. */
  baseCurrency: z.string(),
  /**
   * What was sent at market minus what arrived at market: positive = cost (spread and fees), negative = better
   * than market. Null when no market rate exists for the date.
   */
  cost: MoneyDto.nullable(),
  /** The cost as a share of what was sent at market, in basis points (1% = 100); null without a market rate. */
  costBps: z.number().int().nullable(),
});
export type TransferFxDto = z.infer<typeof TransferFxDto>;

/** POST /transactions/transfer/fx-cost: the same figures for a transfer being entered, before it is saved. */
export const TransferFxQuery = z.object({
  date: CalendarDateDto,
  fromAccountId: Id,
  toAccountId: Id,
  /** Positive amount leaving the source account, in its currency. */
  amount: MoneyDto,
  /** Positive amount arriving in the destination account, in its currency. */
  amountIn: MoneyDto,
});
export type TransferFxQuery = z.output<typeof TransferFxQuery>;

// ----- Travel mode (CUR-09) ------------------------------------------------------------------------------

export const TripInput = z
  .object({
    name: z.string().trim().min(1).max(200),
    startDate: CalendarDateDto,
    endDate: CalendarDateDto,
    currency: CurrencyCodeDto,
    /** IANA time zone for receipt local times (TZ-03), e.g. "Europe/Paris". */
    timeZone: z.string().max(64).nullable().optional(),
  })
  .refine((t) => t.endDate >= t.startDate, {
    message: 'The trip must end on or after its start',
    path: ['endDate'],
  });
export type TripInput = z.output<typeof TripInput>;

export const TripDto = z.object({
  id: Id,
  name: z.string(),
  startDate: z.string(),
  endDate: z.string(),
  currency: z.string(),
  timeZone: z.string().nullable(),
  /** Transactions tagged with the trip. */
  transactionCount: z.number().int(),
  version: z.string(),
});
export type TripDto = z.infer<typeof TripDto>;
