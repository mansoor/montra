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
