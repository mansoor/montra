import { z } from 'zod';
import { CalendarDateDto, CurrencyCodeDto, Id } from './common.js';

// ----- Business assets, who spent and meal details (BIZ-16..20, ADR-0035). ----------------------------------------
// Depreciation figures are estimates for the owner's records, not tax advice.

// Minor units as on the rest of the wire. Not imported from budgets.ts: transactions.ts imports this file, and budgets.ts
// reaches transactions.ts through ledger.ts, so that import would be a cycle.
const MinorDto = z.string().regex(/^-?\d{1,19}$/, 'Amount must be an integer number of minor units');

const PositiveMinor = MinorDto.refine((s) => BigInt(s) > 0n, 'Amount must be more than zero');
const NonNegativeMinor = MinorDto.refine((s) => BigInt(s) >= 0n, 'Amount must not be negative');
const Text = (max: number) => z.string().trim().max(max);
const Version = z.number().int().positive();

export const AssetCategory = z.enum(['equipment', 'computers', 'furniture', 'vehicle', 'software', 'other']);
export type AssetCategory = z.infer<typeof AssetCategory>;

export const AssetMethod = z.enum(['expense_now', 'straight_line', 'macrs_half_year']);
export type AssetMethod = z.infer<typeof AssetMethod>;

export const AssetLife = z.union([z.literal(3), z.literal(5), z.literal(7), z.literal(10)]);
export type AssetLife = z.infer<typeof AssetLife>;

export const AssetAssignmentDto = z.object({
  id: Id,
  personId: Id,
  personName: z.string(),
  assignedOn: CalendarDateDto,
  returnedOn: CalendarDateDto.nullable(),
  note: z.string().nullable(),
  version: z.number().int(),
});
export type AssetAssignmentDto = z.infer<typeof AssetAssignmentDto>;

export const BusinessAssetDto = z.object({
  id: Id,
  entityId: Id,
  name: z.string(),
  category: AssetCategory,
  serial: z.string().nullable(),
  cost: MinorDto,
  currency: CurrencyCodeDto,
  inServiceDate: CalendarDateDto,
  method: AssetMethod,
  lifeYears: AssetLife,
  section179: MinorDto,
  /** The purchase it came from; null for one the owner brought in. */
  transactionId: Id.nullable(),
  notes: z.string().nullable(),
  /** Depreciation posted to the ledger so far, Section 179 included. */
  accumulated: MinorDto,
  /** Cost less what's posted; zero once disposed of. */
  bookValue: MinorDto,
  /** Each year's deduction under the method, and whether it's posted. Empty for "expense now". */
  schedule: z.array(z.object({ year: z.number().int(), amount: MinorDto, posted: z.boolean() })),
  disposal: z
    .object({
      date: CalendarDateDto,
      proceeds: MinorDto,
      /** Proceeds less book value: positive is a gain. */
      gain: MinorDto,
      note: z.string().nullable(),
      transactionId: Id.nullable(),
    })
    .nullable(),
  /** Who holds it now. */
  assignedTo: AssetAssignmentDto.nullable(),
  /** Every assignment, newest first. */
  assignments: z.array(AssetAssignmentDto),
  version: z.number().int(),
});
export type BusinessAssetDto = z.infer<typeof BusinessAssetDto>;

/** A business purchase that may be an asset: over the de minimis limit on an equipment-like category, with no asset. */
export const AssetCandidateDto = z.object({
  transactionId: Id,
  date: CalendarDateDto,
  payee: z.string().nullable(),
  amount: MinorDto,
  categoryName: z.string().nullable(),
});
export type AssetCandidateDto = z.infer<typeof AssetCandidateDto>;

export const AssetListDto = z.object({
  entityId: Id,
  currency: CurrencyCodeDto,
  assets: z.array(BusinessAssetDto),
  totals: z.object({ cost: MinorDto, accumulated: MinorDto, bookValue: MinorDto }),
  candidates: z.array(AssetCandidateDto),
  /** The de minimis safe harbor per item, in minor units. */
  deMinimis: MinorDto,
});
export type AssetListDto = z.infer<typeof AssetListDto>;

export const CreateAssetRequest = z.object({
  entityId: Id,
  name: Text(200).min(1),
  category: AssetCategory,
  serial: Text(100).nullable().optional(),
  cost: PositiveMinor,
  inServiceDate: CalendarDateDto,
  method: AssetMethod,
  /** Defaults by category: 5 for computers and vehicles, 3 for software, 7 for the rest. */
  lifeYears: AssetLife.optional(),
  section179: NonNegativeMinor.optional(),
  /** The purchase: its cost moves out of the expense category into fixed assets, unless the method is "expense now". */
  transactionId: Id.nullable().optional(),
  notes: Text(2000).nullable().optional(),
});
export type CreateAssetRequest = z.output<typeof CreateAssetRequest>;

/** Name, serial, category and notes change any time; the money only while nothing is posted or disposed of. */
export const UpdateAssetRequest = CreateAssetRequest.omit({ entityId: true, transactionId: true })
  .partial()
  .extend({ version: Version });
export type UpdateAssetRequest = z.output<typeof UpdateAssetRequest>;

export const PostDepreciationRequest = z.object({
  entityId: Id,
  /** Every asset is caught up to the end of this year. */
  throughYear: z.number().int().min(1990).max(2200),
});
export type PostDepreciationRequest = z.output<typeof PostDepreciationRequest>;

export const PostDepreciationDto = z.object({
  posted: z.array(z.object({ assetId: Id, year: z.number().int(), amount: MinorDto })),
});
export type PostDepreciationDto = z.infer<typeof PostDepreciationDto>;

export const DisposeAssetRequest = z.object({
  date: CalendarDateDto,
  /** Zero when it was scrapped or given away. */
  proceeds: NonNegativeMinor,
  note: Text(500).nullable().optional(),
  /** Where the proceeds are: an existing deposit, or a new one on this account. Required when proceeds are more than zero. */
  payment: z
    .union([z.object({ transactionId: Id }), z.object({ accountId: Id })])
    .nullable()
    .optional(),
  version: Version,
});
export type DisposeAssetRequest = z.output<typeof DisposeAssetRequest>;

export const AssignAssetRequest = z.object({
  personId: Id,
  assignedOn: CalendarDateDto,
  note: Text(500).nullable().optional(),
});
export type AssignAssetRequest = z.output<typeof AssignAssetRequest>;

export const ReturnAssetRequest = z.object({ returnedOn: CalendarDateDto, version: Version });
export type ReturnAssetRequest = z.output<typeof ReturnAssetRequest>;

// ----- Expense details (BIZ-18) --------------------------------------------------------------------------------

export const SpentBy = z.enum(['owner', 'person']);
export type SpentBy = z.infer<typeof SpentBy>;

/**
 * A business expense's details, kept beside the transaction. Present on every transaction with spending in a business,
 * even before anything is entered (`version` 0), so the screens know to offer it.
 */
export const ExpenseDetailDto = z.object({
  entityId: Id,
  spentBy: SpentBy.nullable(),
  spentByPersonId: Id.nullable(),
  spentByName: z.string().nullable(),
  attendees: z.array(z.object({ partyId: Id.nullable(), name: z.string() })),
  businessPurpose: z.string().nullable(),
  /** One of its business splits is on Schedule C line 24b. */
  isMeal: z.boolean(),
  /** A meal without attendees or a purpose: "The IRS expects who and why". */
  needsMealDetail: z.boolean(),
  /** Over the de minimis limit on an equipment-like category, with no asset: "Record as an asset?". */
  assetCandidate: z.boolean(),
  /** The asset made from this purchase. */
  assetId: Id.nullable(),
  version: z.number().int(),
});
export type ExpenseDetailDto = z.infer<typeof ExpenseDetailDto>;

export const SetExpenseDetailRequest = z.object({
  entityId: Id,
  /** Null clears it. */
  spentBy: z
    .discriminatedUnion('kind', [
      z.object({ kind: z.literal('owner') }),
      z.object({ kind: z.literal('person'), personId: Id }),
    ])
    .nullable(),
  attendees: z.array(z.union([z.object({ partyId: Id }), z.object({ name: Text(200).min(1) })])).max(30),
  businessPurpose: Text(500).nullable(),
  /** The version from the last read; 0 when there were no details yet. */
  version: z.number().int().min(0),
});
export type SetExpenseDetailRequest = z.output<typeof SetExpenseDetailRequest>;

export const ExpensesByPersonDto = z.object({
  entityId: Id,
  from: CalendarDateDto,
  to: CalendarDateDto,
  currency: CurrencyCodeDto,
  /** The owner, each person, and spending nobody was named on (`spentBy` null). Largest first. */
  rows: z.array(
    z.object({
      spentBy: SpentBy.nullable(),
      personId: Id.nullable(),
      name: z.string().nullable(),
      amount: MinorDto,
      count: z.number().int(),
    }),
  ),
  total: MinorDto,
});
export type ExpensesByPersonDto = z.infer<typeof ExpensesByPersonDto>;
