import { z } from 'zod';
import { CalendarDateDto, CurrencyCodeDto, Id } from './common.js';
import { MinorDto } from './budgets.js';

/**
 * Household bills (ADR-0048 §4): a bill from a biller on personal books, usually scanned. It gives the biller's next
 * bill its exact amount and due date, and is marked paid when the payment to the biller shows up.
 */
export const HOUSEHOLD_BILL_STATUSES = ['open', 'paid', 'void'] as const;
export const HouseholdBillStatus = z.enum(HOUSEHOLD_BILL_STATUSES);

export const HouseholdBillDto = z.object({
  id: Id,
  entityId: Id,
  billerId: Id,
  billerName: z.string(),
  categoryId: Id,
  memberId: Id.nullable(),
  /** `overdue` is an open bill past its due date. */
  status: z.enum(['open', 'overdue', 'paid', 'void']),
  amount: MinorDto,
  currency: CurrencyCodeDto,
  dueDate: CalendarDateDto,
  billDate: CalendarDateDto.nullable(),
  periodStart: CalendarDateDto.nullable(),
  periodEnd: CalendarDateDto.nullable(),
  fileIds: z.array(Id),
  /** The payment that settled it. */
  transactionId: Id.nullable(),
  warnings: z.array(z.string()),
  version: z.number().int(),
});
export type HouseholdBillDto = z.infer<typeof HouseholdBillDto>;

const PositiveMinor = MinorDto.refine((s) => BigInt(s) > 0n, 'Amount must be positive');

/**
 * Files a bill for a biller: from a scan (`scanId`: its pages and reading) or typed in. A biller on a business's books
 * files it as that business's vendor bill instead (ADR-0017); the answer says which.
 */
export const CreateHouseholdBillRequest = z.object({
  billerId: Id,
  scanId: Id.optional(),
  amount: PositiveMinor,
  dueDate: CalendarDateDto,
  billDate: CalendarDateDto.nullable().optional(),
  periodStart: CalendarDateDto.nullable().optional(),
  periodEnd: CalendarDateDto.nullable().optional(),
  memberId: Id.nullable().optional(),
});
export type CreateHouseholdBillRequest = z.output<typeof CreateHouseholdBillRequest>;

export const UpdateHouseholdBillRequest = z.object({
  amount: PositiveMinor.optional(),
  dueDate: CalendarDateDto.optional(),
  void: z.boolean().optional(),
  version: z.number().int().positive(),
});
export type UpdateHouseholdBillRequest = z.output<typeof UpdateHouseholdBillRequest>;

/** What filing a bill made: a household bill, or a business's vendor bill. */
export const FiledBillDto = z.object({
  kind: z.enum(['household', 'business']),
  id: Id,
  entityId: Id,
});
export type FiledBillDto = z.infer<typeof FiledBillDto>;
