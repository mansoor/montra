import { z } from 'zod';
import { isCalendarDate, isCurrencyCode, type CalendarDate, type CurrencyCode } from '@montra/domain';

export const Id = z.uuid();

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
