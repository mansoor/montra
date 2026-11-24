import { z } from 'zod';
import { isCalendarDate, isCurrencyCode, type CalendarDate, type CurrencyCode } from '@montra/domain';

export const Id = z.uuid();

/** A colour as `#rrggbb`: a family member's, a book's. */
export const HexColorDto = z.string().regex(/^#[0-9a-fA-F]{6}$/);

export const CurrencyCodeDto = z
  .string()
  .length(3)
  .transform((s) => s.toUpperCase())
  .refine(isCurrencyCode, 'Unknown ISO 4217 currency code')
  .transform((s) => s as CurrencyCode);

export const CalendarDateDto = z
  .string()
  .refine(isCalendarDate, 'Expected a calendar date YYYY-MM-DD')
  .transform((s) => s as CalendarDate);

/** Money on the wire: minor units as an integer string (ADR-0004), e.g. { amount: "-4210", currency: "USD" }. */
export const MoneyDto = z.object({
  amount: z.string().regex(/^-?\d{1,19}$/, 'Amount must be an integer number of minor units'),
  currency: CurrencyCodeDto,
});
export type MoneyDto = z.output<typeof MoneyDto>;

/** One end of an amount filter: minor units of the workspace currency, without a sign. */
export const AmountBoundDto = z
  .string()
  .regex(/^\d{1,18}$/, 'Amount must be a whole number of minor units, without a sign');

/** Money in (income, refunds) or money out (spending). Transfers are neither. */
export const MoneyDirection = z.enum(['in', 'out']);
export type MoneyDirection = z.infer<typeof MoneyDirection>;

/**
 * Filters the web lists share (Transactions, Review, Receipts): the start of words in the merchant or payee, and an
 * amount range compared without the sign, so "20 to 100" finds $20–$100 spent or received. Each amount is compared in
 * its own currency, as the search's `>20` is.
 */
export const ListFilterQuery = z.object({
  merchant: z.string().trim().min(1).max(100).optional(),
  amountMin: AmountBoundDto.optional(),
  amountMax: AmountBoundDto.optional(),
});
export type ListFilterQuery = z.output<typeof ListFilterQuery>;

export const ProblemDto = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number().int(),
  code: z.string(),
  detail: z.string().optional(),
  errors: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
});
export type ProblemDto = z.infer<typeof ProblemDto>;

/**
 * Workspace roles (AUTH-14). The owner is the one account that created or was handed the workspace; an admin can do
 * everything else the owner can. A member adds transactions, receipts and trips in the books granted to them.
 */
export const MemberRole = z.enum(['owner', 'admin', 'partner', 'member', 'viewer', 'accountant']);
export type MemberRole = z.infer<typeof MemberRole>;
/** Roles an invite can give; ownership is only handed over. */
export const InviteRole = z.enum(['admin', 'partner', 'member', 'viewer', 'accountant']);
export type InviteRole = z.infer<typeof InviteRole>;
