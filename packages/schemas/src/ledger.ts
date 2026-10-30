import { z } from 'zod';
import { CalendarDateDto, CurrencyCodeDto, Id, MoneyDto } from './common.js';
import { SplitInput } from './transactions.js';

// ----- Transactions: edit, bulk, void (TXN-10, DE-10) -----------------------------------------------------

export const UpdateTransactionRequest = z
  .object({
    date: CalendarDateDto,
    accountId: Id,
    amount: MoneyDto,
    payee: z.string().trim().max(200).nullable(),
    description: z.string().trim().max(500),
    categoryId: Id,
    splits: z.array(SplitInput).min(1).max(250),
    memberId: Id.nullable(),
    memo: z.string().max(2000).nullable(),
    tags: z.array(z.string().trim().min(1).max(50)).max(20),
    reviewState: z.enum(['reviewed', 'needs_review']),
  })
  .partial()
  .refine((t) => !(t.categoryId && t.splits), {
    message: 'Use either categoryId or splits, not both',
    path: ['splits'],
  });
export type UpdateTransactionRequest = z.output<typeof UpdateTransactionRequest>;

export const BulkEditRequest = z.object({
  ids: z.array(Id).min(1).max(500),
  set: z
    .object({
      categoryId: Id,
      /** Moves single-category transactions to the same-named category of another entity (UP-08). */
      entityId: Id,
      memberId: Id.nullable(),
      addTags: z.array(z.string().trim().min(1).max(50)).max(20),
      removeTags: z.array(z.string().trim().min(1).max(50)).max(20),
      reviewState: z.enum(['reviewed', 'needs_review']),
    })
    .partial()
    .refine((s) => Object.keys(s).length > 0, 'Nothing to change'),
});
export type BulkEditRequest = z.output<typeof BulkEditRequest>;

export const BulkEditResult = z.object({
  updated: z.array(z.string()),
  skipped: z.array(z.object({ id: z.string(), reason: z.string() })),
});
export type BulkEditResult = z.infer<typeof BulkEditResult>;

// ----- Journals and period close (DE-07, DE-09) -----------------------------------------------------------

export const ManualJournalRequest = z.object({
  entityId: Id,
  date: CalendarDateDto,
  description: z.string().trim().min(1).max(500),
  kind: z.enum(['manual', 'adjustment', 'depreciation']).default('manual'),
  lines: z
    .array(
      z
        .object({
          accountId: Id,
          debit: z
            .string()
            .regex(/^\d{1,19}$/)
            .optional(),
          credit: z
            .string()
            .regex(/^\d{1,19}$/)
            .optional(),
          memberId: Id.nullable().optional(),
          memo: z.string().max(500).optional(),
        })
        .refine(
          (l) => (l.debit === undefined) !== (l.credit === undefined),
          'Each line has a debit or a credit',
        ),
    )
    .min(2)
    .max(250),
});
export type ManualJournalRequest = z.output<typeof ManualJournalRequest>;

export const PeriodLockRequest = z.object({
  lockedThrough: CalendarDateDto,
  note: z.string().trim().max(500).optional(),
});
export type PeriodLockRequest = z.output<typeof PeriodLockRequest>;

export const AuditedNoteRequest = z.object({ note: z.string().trim().min(3).max(500) });

// ----- Entities, accounts, members (ACC, FAM) -------------------------------------------------------------

export const CreateEntityRequest = z.object({
  type: z.enum(['business', 'rental']),
  name: z.string().trim().min(1).max(200),
  functionalCurrency: CurrencyCodeDto.optional(),
  businessType: z
    .enum(['sole_prop', 'llc', 'single_member_llc', 's_corp', 'partnership', 'other'])
    .optional(),
  fiscalYearStartMonth: z.number().int().min(1).max(12).optional(),
});
export type CreateEntityRequest = z.output<typeof CreateEntityRequest>;

export const UpdateEntityRequest = z
  .object({
    name: z.string().trim().min(1).max(200),
    businessType: z
      .enum(['sole_prop', 'llc', 'single_member_llc', 's_corp', 'partnership', 'other'])
      .nullable(),
    fiscalYearStartMonth: z.number().int().min(1).max(12),
    archived: z.boolean(),
  })
  .partial();
export type UpdateEntityRequest = z.output<typeof UpdateEntityRequest>;

export const UpdateAccountRequest = z
  .object({
    name: z.string().trim().min(1).max(200),
    institution: z.string().trim().max(200).nullable(),
    last4: z
      .string()
      .regex(/^\d{4}$/)
      .nullable(),
    defaultMemberId: Id.nullable(),
    archived: z.boolean(),
    hidden: z.boolean(),
  })
  .partial();
export type UpdateAccountRequest = z.output<typeof UpdateAccountRequest>;

export const BalanceAdjustmentRequest = z.object({
  date: CalendarDateDto,
  /** Target natural balance on `date` (held for assets, owed for liabilities). */
  balance: MoneyDto,
  note: z.string().trim().min(3).max(500),
});
export type BalanceAdjustmentRequest = z.output<typeof BalanceAdjustmentRequest>;

export const FamilyRelationship = z.enum(['self', 'spouse_partner', 'child', 'parent', 'other']);

export const CreateFamilyMemberRequest = z.object({
  name: z.string().trim().min(1).max(100),
  relationship: FamilyRelationship,
  birthDate: CalendarDateDto.optional(),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .optional(),
  isDependent: z.boolean().optional(),
  linkedUserId: Id.nullable().optional(),
});
export type CreateFamilyMemberRequest = z.output<typeof CreateFamilyMemberRequest>;

export const UpdateFamilyMemberRequest = CreateFamilyMemberRequest.partial().extend({
  status: z.enum(['active', 'inactive']).optional(),
});
export type UpdateFamilyMemberRequest = z.output<typeof UpdateFamilyMemberRequest>;

export const FamilyMemberDto = z.object({
  id: z.string(),
  name: z.string(),
  relationship: FamilyRelationship,
  birthDate: z.string().nullable(),
  color: z.string().nullable(),
  status: z.enum(['active', 'inactive']),
  isDependent: z.boolean(),
  linkedUserId: z.string().nullable(),
});
export type FamilyMemberDto = z.infer<typeof FamilyMemberDto>;

// ----- Sharing (UP-04, AUTH-10) ---------------------------------------------------------------------------

export const EntityGrant = z.object({ entityId: Id, access: z.enum(['none', 'read', 'write']) });

export const CreateInviteRequest = z.object({
  email: z.email().transform((e) => e.toLowerCase()),
  role: z.enum(['partner', 'viewer', 'accountant']),
  entityGrants: z.array(EntityGrant).max(50).default([]),
});
export type CreateInviteRequest = z.output<typeof CreateInviteRequest>;

export const UpdateMemberRequest = z
  .object({ role: z.enum(['partner', 'viewer', 'accountant']), status: z.enum(['active', 'revoked']) })
  .partial();
export type UpdateMemberRequest = z.output<typeof UpdateMemberRequest>;

export const SetGrantsRequest = z.object({ grants: z.array(EntityGrant).max(50) });

export const MemberDto = z.object({
  userId: z.string(),
  email: z.string(),
  displayName: z.string(),
  role: z.enum(['owner', 'partner', 'viewer', 'accountant']),
  status: z.enum(['invited', 'active', 'revoked']),
  grants: z.array(z.object({ entityId: z.string(), access: z.enum(['none', 'read', 'write']) })),
});
export type MemberDto = z.infer<typeof MemberDto>;

// ----- Me (TZ-01, TZ-05, CUR-10) --------------------------------------------------------------------------

export const UpdateMeRequest = z
  .object({
    displayName: z.string().trim().max(100),
    locale: z.string().regex(/^[a-z]{2,3}(-[A-Z]{2})?$/),
    timeZone: z.string().refine((tz) => {
      try {
        new Intl.DateTimeFormat('en', { timeZone: tz });
        return true;
      } catch {
        return false;
      }
    }, 'Unknown time zone'),
    dateFormat: z.enum(['YYYY-MM-DD', 'MM/DD/YYYY', 'DD/MM/YYYY', 'DD.MM.YYYY']).nullable(),
    weekStart: z.number().int().min(1).max(7),
  })
  .partial();
export type UpdateMeRequest = z.output<typeof UpdateMeRequest>;

export const MeDto = z.object({
  id: z.string(),
  email: z.string(),
  displayName: z.string(),
  locale: z.string(),
  timeZone: z.string(),
  dateFormat: z.string().nullable(),
  weekStart: z.number(),
  emailVerified: z.boolean(),
});
export type MeDto = z.infer<typeof MeDto>;

// ----- Recurring templates (TXN-05) -----------------------------------------------------------------------

export const Cadence = z.enum(['weekly', 'biweekly', 'semimonthly', 'monthly', 'quarterly', 'yearly']);

export const CreateRecurringRequest = z
  .object({
    name: z.string().trim().min(1).max(200),
    accountId: Id,
    amount: MoneyDto,
    payee: z.string().trim().max(200).optional(),
    categoryId: Id.optional(),
    splits: z.array(SplitInput).min(1).max(50).optional(),
    cadence: Cadence,
    startDate: CalendarDateDto,
    endDate: CalendarDateDto.optional(),
    autoCreate: z.enum(['scheduled', 'posted']).default('scheduled'),
  })
  .refine((r) => Boolean(r.categoryId) !== Boolean(r.splits), {
    message: 'Provide exactly one of categoryId or splits',
    path: ['categoryId'],
  });
export type CreateRecurringRequest = z.output<typeof CreateRecurringRequest>;

export const UpdateRecurringRequest = z
  .object({
    name: z.string().trim().min(1).max(200),
    amount: MoneyDto,
    endDate: CalendarDateDto.nullable(),
    status: z.enum(['active', 'paused', 'ended']),
    autoCreate: z.enum(['scheduled', 'posted']),
  })
  .partial();
export type UpdateRecurringRequest = z.output<typeof UpdateRecurringRequest>;

export const RecurringDto = z.object({
  id: z.string(),
  name: z.string(),
  cadence: Cadence,
  startDate: z.string(),
  endDate: z.string().nullable(),
  nextDate: z.string(),
  autoCreate: z.enum(['scheduled', 'posted']),
  status: z.enum(['active', 'paused', 'ended']),
  amount: MoneyDto,
  accountId: z.string(),
  payee: z.string().nullable(),
});
export type RecurringDto = z.infer<typeof RecurringDto>;

export const ConfirmOccurrenceRequest = z.object({
  amount: MoneyDto.optional(),
  date: CalendarDateDto.optional(),
});
export type ConfirmOccurrenceRequest = z.output<typeof ConfirmOccurrenceRequest>;

// ----- Sync (PLT-06) --------------------------------------------------------------------------------------

export const ChangeDto = z.object({
  seq: z.string(),
  table: z.string(),
  id: z.string(),
  op: z.enum(['insert', 'update', 'delete']),
});
export type ChangeDto = z.infer<typeof ChangeDto>;
