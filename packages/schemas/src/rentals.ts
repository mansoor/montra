import { z } from 'zod';
import { CalendarDateDto, CurrencyCodeDto, Id } from './common.js';
import { MinorDto } from './budgets.js';

// ----- Rental properties (RNT-01..14, UP-10; design 03 §8, 04 §9 and §13, ADR-0018). Cash basis throughout. ------

const NonNegativeMinor = MinorDto.refine((s) => BigInt(s) >= 0n, 'Amount must not be negative');
const PositiveMinor = MinorDto.refine((s) => BigInt(s) > 0n, 'Amount must be more than zero');
const Text = (max: number) => z.string().trim().max(max);
const Version = z.number().int().positive();

// ----- Properties and units (RNT-01, RNT-02) -----------------------------------------------------------------

export const PROPERTY_TYPES = ['sfh', 'multi_family', 'condo', 'str', 'commercial'] as const;
export const PropertyType = z.enum(PROPERTY_TYPES);
export type PropertyType = z.infer<typeof PropertyType>;

export const UnitStatus = z.enum(['occupied', 'vacant', 'under_repair']);
export type UnitStatus = z.infer<typeof UnitStatus>;

export const UnitDto = z.object({
  id: Id,
  propertyId: Id,
  label: z.string(),
  beds: z.number().int().nullable(),
  /** Decimal, such as "1.5". */
  baths: z.string().nullable(),
  sqft: z.number().int().nullable(),
  marketRent: MinorDto.nullable(),
  /** Occupied or vacant follows from the leases; under repair is the owner's. */
  status: UnitStatus,
  currentLeaseId: Id.nullable(),
  archived: z.boolean(),
  version: z.number().int(),
});
export type UnitDto = z.infer<typeof UnitDto>;

const Baths = z.string().regex(/^\d{1,2}(\.\d)?$/, 'Enter baths such as 1.5');

export const CreateUnitRequest = z.object({
  label: Text(100).min(1),
  beds: z.number().int().min(0).max(100).nullable().optional(),
  baths: Baths.nullable().optional(),
  sqft: z.number().int().positive().nullable().optional(),
  marketRent: NonNegativeMinor.nullable().optional(),
});
export type CreateUnitRequest = z.output<typeof CreateUnitRequest>;

export const UpdateUnitRequest = CreateUnitRequest.partial().extend({
  underRepair: z.boolean().optional(),
  archived: z.boolean().optional(),
  version: Version,
});
export type UpdateUnitRequest = z.output<typeof UpdateUnitRequest>;

export const PropertyDto = z.object({
  id: Id,
  entityId: Id,
  name: z.string(),
  address: z.string().nullable(),
  type: PropertyType,
  purchaseDate: CalendarDateDto.nullable(),
  purchasePrice: MinorDto.nullable(),
  landValue: MinorDto.nullable(),
  cashInvested: MinorDto.nullable(),
  ownershipBps: z.number().int(),
  currentValue: MinorDto.nullable(),
  sqft: z.number().int().nullable(),
  units: z.array(UnitDto),
  archived: z.boolean(),
  version: z.number().int(),
});
export type PropertyDto = z.infer<typeof PropertyDto>;

const PropertyFields = {
  name: Text(200).min(1),
  address: Text(1000).nullable().optional(),
  type: PropertyType.default('sfh'),
  purchaseDate: CalendarDateDto.nullable().optional(),
  purchasePrice: NonNegativeMinor.nullable().optional(),
  landValue: NonNegativeMinor.nullable().optional(),
  cashInvested: NonNegativeMinor.nullable().optional(),
  ownershipBps: z.number().int().min(1).max(10000).default(10000),
  currentValue: NonNegativeMinor.nullable().optional(),
  sqft: z.number().int().positive().nullable().optional(),
};

/** `units` defaults to one, named after the property: most single-family homes need no more. */
export const CreatePropertyRequest = z.object({
  entityId: Id,
  ...PropertyFields,
  units: z.array(CreateUnitRequest).max(500).default([]),
});
export type CreatePropertyRequest = z.output<typeof CreatePropertyRequest>;

export const UpdatePropertyRequest = z
  .object({ ...PropertyFields, type: PropertyType, ownershipBps: z.number().int().min(1).max(10000) })
  .partial()
  .extend({ archived: z.boolean().optional(), version: Version });
export type UpdatePropertyRequest = z.output<typeof UpdatePropertyRequest>;

// ----- Tenants and leases (RNT-03) ---------------------------------------------------------------------------

export const TenantDto = z.object({
  id: Id,
  entityId: Id,
  name: z.string(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  notes: z.string().nullable(),
  version: z.number().int(),
});
export type TenantDto = z.infer<typeof TenantDto>;

export const CreateTenantRequest = z.object({
  entityId: Id,
  name: Text(200).min(1),
  email: z.email().max(320).nullable().optional(),
  phone: Text(50).nullable().optional(),
  notes: Text(2000).nullable().optional(),
});
export type CreateTenantRequest = z.output<typeof CreateTenantRequest>;

export const UpdateTenantRequest = CreateTenantRequest.omit({ entityId: true })
  .partial()
  .extend({ version: Version });
export type UpdateTenantRequest = z.output<typeof UpdateTenantRequest>;

export const LeaseStatus = z.enum(['upcoming', 'active', 'ended']);
export type LeaseStatus = z.infer<typeof LeaseStatus>;

export const DepositEventDto = z.object({
  id: Id,
  kind: z.enum(['received', 'returned', 'forfeited']),
  date: CalendarDateDto,
  amount: MinorDto,
  transactionId: Id,
  source: z.enum(['auto', 'manual']),
  notes: z.string().nullable(),
});
export type DepositEventDto = z.infer<typeof DepositEventDto>;

export const LeaseDto = z.object({
  id: Id,
  entityId: Id,
  propertyId: Id,
  propertyName: z.string(),
  unitId: Id,
  unitLabel: z.string(),
  tenants: z.array(z.object({ id: Id, name: z.string() })),
  status: LeaseStatus,
  startDate: CalendarDateDto,
  /** Null: month to month. */
  endDate: CalendarDateDto.nullable(),
  endedOn: CalendarDateDto.nullable(),
  rent: MinorDto,
  dueDay: z.number().int(),
  lateGraceDays: z.number().int(),
  lateFeeFlat: MinorDto,
  lateFeeBps: z.number().int(),
  lateFeeCap: MinorDto.nullable(),
  /** The deposit the lease calls for. */
  deposit: MinorDto,
  /** What's held now: received less returned and forfeited. */
  depositHeld: MinorDto,
  depositEvents: z.array(DepositEventDto),
  depositAccountId: Id.nullable(),
  fileIds: z.array(Id),
  notes: z.string().nullable(),
  currency: CurrencyCodeDto,
  version: z.number().int(),
});
export type LeaseDto = z.infer<typeof LeaseDto>;

const LeaseFields = {
  tenantIds: z.array(Id).min(1).max(20),
  startDate: CalendarDateDto,
  endDate: CalendarDateDto.nullable().optional(),
  rent: PositiveMinor,
  dueDay: z.number().int().min(1).max(31).default(1),
  lateGraceDays: z.number().int().min(0).max(60).default(5),
  lateFeeFlat: NonNegativeMinor.default('0'),
  lateFeeBps: z.number().int().min(0).max(10000).default(0),
  lateFeeCap: NonNegativeMinor.nullable().optional(),
  deposit: NonNegativeMinor.default('0'),
  depositAccountId: Id.nullable().optional(),
  fileIds: z.array(Id).max(20).default([]),
  notes: Text(2000).nullable().optional(),
};

export const CreateLeaseRequest = z.object({ unitId: Id, ...LeaseFields });
export type CreateLeaseRequest = z.output<typeof CreateLeaseRequest>;

/** Terms apply to charges not yet made; an existing charge is edited on its own. */
export const UpdateLeaseRequest = z
  .object({
    tenantIds: LeaseFields.tenantIds,
    endDate: LeaseFields.endDate,
    endedOn: CalendarDateDto.nullable(),
    rent: PositiveMinor,
    dueDay: z.number().int().min(1).max(31),
    lateGraceDays: z.number().int().min(0).max(60),
    lateFeeFlat: NonNegativeMinor,
    lateFeeBps: z.number().int().min(0).max(10000),
    lateFeeCap: NonNegativeMinor.nullable(),
    deposit: NonNegativeMinor,
    depositAccountId: Id.nullable(),
    fileIds: z.array(Id).max(20),
    notes: Text(2000).nullable(),
  })
  .partial()
  .extend({ version: Version });
export type UpdateLeaseRequest = z.output<typeof UpdateLeaseRequest>;

// ----- Rent roll and arrears (RNT-04, RNT-05) ----------------------------------------------------------------

export const RentStatus = z.enum(['paid', 'partial', 'upcoming', 'due', 'late', 'waived']);
export type RentStatus = z.infer<typeof RentStatus>;

export const RentChargeDto = z.object({
  id: Id,
  leaseId: Id,
  kind: z.enum(['rent', 'late_fee']),
  periodStart: CalendarDateDto,
  dueDate: CalendarDateDto,
  amount: MinorDto,
  paid: MinorDto,
  open: MinorDto,
  status: RentStatus,
  daysLate: z.number().int(),
  version: z.number().int(),
});
export type RentChargeDto = z.infer<typeof RentChargeDto>;

export const RentRollRowDto = z.object({
  leaseId: Id,
  propertyId: Id,
  propertyName: z.string(),
  unitId: Id,
  unitLabel: z.string(),
  tenants: z.array(z.string()),
  /** This month's charges. */
  charges: z.array(RentChargeDto),
  expected: MinorDto,
  paid: MinorDto,
  open: MinorDto,
  /** Paid ahead, on the lease as a whole. */
  credit: MinorDto,
});
export type RentRollRowDto = z.infer<typeof RentRollRowDto>;

export const RentRollDto = z.object({
  entityId: Id,
  month: CalendarDateDto,
  currency: CurrencyCodeDto,
  rows: z.array(RentRollRowDto),
  expected: MinorDto,
  paid: MinorDto,
  open: MinorDto,
  /** Units with no lease this month, at market rent where it's known. */
  vacant: z.array(
    z.object({
      unitId: Id,
      propertyName: z.string(),
      unitLabel: z.string(),
      marketRent: MinorDto.nullable(),
    }),
  ),
});
export type RentRollDto = z.infer<typeof RentRollDto>;

export const ArrearsRowDto = z.object({
  leaseId: Id,
  propertyName: z.string(),
  unitLabel: z.string(),
  tenants: z.array(z.string()),
  rentOwed: MinorDto,
  feesOwed: MinorDto,
  total: MinorDto,
  oldestDue: CalendarDateDto,
  daysLate: z.number().int(),
  charges: z.array(RentChargeDto),
});
export type ArrearsRowDto = z.infer<typeof ArrearsRowDto>;

export const ArrearsDto = z.object({
  entityId: Id,
  currency: CurrencyCodeDto,
  total: MinorDto,
  rows: z.array(ArrearsRowDto),
});
export type ArrearsDto = z.infer<typeof ArrearsDto>;

export const UpdateChargeRequest = z
  .object({ amount: NonNegativeMinor, waived: z.boolean() })
  .partial()
  .extend({ version: Version });
export type UpdateChargeRequest = z.output<typeof UpdateChargeRequest>;

/** Link an existing line, or record one that isn't in the books yet. */
export const RentPaymentRequest = z.union([
  z.object({ transactionId: Id }),
  z.object({ accountId: Id, date: CalendarDateDto, amount: PositiveMinor }),
]);
export type RentPaymentRequest = z.output<typeof RentPaymentRequest>;

export const RentPaymentDto = z.object({
  id: Id,
  leaseId: Id,
  transactionId: Id,
  date: CalendarDateDto,
  amount: MinorDto,
  source: z.enum(['auto', 'manual']),
});
export type RentPaymentDto = z.infer<typeof RentPaymentDto>;

export const LeaseCandidateDto = z.object({
  transactionId: Id,
  date: CalendarDateDto,
  amount: MinorDto,
  payer: z.string().nullable(),
  accountId: Id,
});
export type LeaseCandidateDto = z.infer<typeof LeaseCandidateDto>;

/** RNT-10. `received` and `returned` move money; `forfeited` moves what's held to income. */
export const DepositEventRequest = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('received'), transactionId: Id }),
  z.object({
    kind: z.literal('received_new'),
    accountId: Id,
    date: CalendarDateDto,
    amount: PositiveMinor,
  }),
  z.object({
    kind: z.literal('returned'),
    accountId: Id,
    date: CalendarDateDto,
    amount: PositiveMinor,
    notes: Text(500).optional(),
  }),
  z.object({
    kind: z.literal('forfeited'),
    date: CalendarDateDto,
    amount: PositiveMinor,
    notes: Text(500).optional(),
  }),
]);
export type DepositEventRequest = z.output<typeof DepositEventRequest>;

// ----- Shared expenses (RNT-07) ------------------------------------------------------------------------------

export const AllocationBasis = z.enum(['percent', 'units', 'sqft']);
export type AllocationBasis = z.infer<typeof AllocationBasis>;

export const AllocationRuleDto = z.object({
  id: Id,
  entityId: Id,
  name: z.string(),
  basis: AllocationBasis,
  targets: z.array(z.object({ propertyId: Id, percentBps: z.number().int().nullable() })),
  version: z.number().int(),
});
export type AllocationRuleDto = z.infer<typeof AllocationRuleDto>;

const AllocationTargets = z
  .array(z.object({ propertyId: Id, percentBps: z.number().int().min(1).max(10000).optional() }))
  .min(2)
  .max(200);

export const CreateAllocationRuleRequest = z.object({
  entityId: Id,
  name: Text(200).min(1),
  basis: AllocationBasis,
  targets: AllocationTargets,
});
export type CreateAllocationRuleRequest = z.output<typeof CreateAllocationRuleRequest>;

/** Split a transaction across properties, by a saved rule or a one-off. */
export const AllocateTransactionRequest = z.union([
  z.object({ ruleId: Id }),
  z.object({ basis: AllocationBasis, targets: AllocationTargets }),
]);
export type AllocateTransactionRequest = z.output<typeof AllocateTransactionRequest>;

// ----- Mortgages (RNT-08) ------------------------------------------------------------------------------------

export const LoanDto = z.object({
  id: Id,
  entityId: Id,
  propertyId: Id.nullable(),
  loanAccountId: Id,
  name: z.string(),
  startDate: CalendarDateDto.nullable(),
  /** The original amount. */
  principal: MinorDto,
  rateBps: z.number().int(),
  termMonths: z.number().int(),
  firstPaymentDate: CalendarDateDto,
  escrowTaxes: MinorDto,
  escrowInsurance: MinorDto,
  /** Principal and interest. */
  payment: MinorDto,
  /** With escrow: what leaves the bank. */
  totalPayment: MinorDto,
  /** What's owed now, from the ledger. */
  scheduledBalance: MinorDto,
  paymentsMade: z.number().int(),
  /** Where the payment comes from, and whether it records itself on its due date. */
  payingAccountId: Id.nullable(),
  autoRecord: z.boolean(),
  /** The next unrecorded payment, null once it's paid off. */
  next: z
    .object({
      number: z.number().int(),
      date: CalendarDateDto,
      total: MinorDto,
      interest: MinorDto,
      principal: MinorDto,
      escrow: MinorDto,
    })
    .nullable(),
  /** When it's paid off at this rate and payment. */
  payoffDate: CalendarDateDto.nullable(),
  interestRemaining: MinorDto,
  /** Recorded here. Payments made before tracking began aren't known. */
  interestPaid: MinorDto,
  currency: CurrencyCodeDto,
  version: z.number().int(),
});
export type LoanDto = z.infer<typeof LoanDto>;

export const CreateLoanRequest = z
  .object({
    /** Only on a rental portfolio. */
    propertyId: Id.optional(),
    /** An account that already exists, or `newAccount` to add it in the same step. */
    loanAccountId: Id.optional(),
    newAccount: z
      .object({
        kind: z.enum(['loan', 'mortgage']),
        entityId: Id.optional(),
        institution: Text(200).optional(),
        last4: z
          .string()
          .regex(/^\d{4}$/)
          .optional(),
        /** Leave out to estimate it from the terms. */
        owed: PositiveMinor.optional(),
      })
      .optional(),
    name: Text(200).min(1),
    startDate: CalendarDateDto.optional(),
    principal: PositiveMinor,
    rateBps: z.number().int().min(0).max(5000),
    termMonths: z.number().int().min(1).max(600),
    firstPaymentDate: CalendarDateDto,
    escrowTaxes: NonNegativeMinor.default('0'),
    escrowInsurance: NonNegativeMinor.default('0'),
    /** Payments scheduled on or before this date are already in the balance, so they aren't asked for. */
    balanceAsOf: CalendarDateDto.optional(),
    payingAccountId: Id.optional(),
    /** The lender's principal and interest, when it differs from the calculated one. */
    paymentAmount: PositiveMinor.optional(),
    autoRecord: z.boolean().default(false),
  })
  .refine((r) => (r.loanAccountId === undefined) !== (r.newAccount === undefined), {
    message: 'Choose a loan account, or add a new one',
    path: ['loanAccountId'],
  });
export type CreateLoanRequest = z.output<typeof CreateLoanRequest>;

export const UpdateLoanRequest = z
  .object({
    name: Text(200).min(1),
    escrowTaxes: NonNegativeMinor,
    escrowInsurance: NonNegativeMinor,
    archived: z.boolean(),
    /** Applies from the next payment. The payment is recalculated over the time left, unless `paymentAmount` says otherwise. */
    rateBps: z.number().int().min(0).max(5000),
    /** Null goes back to the calculated payment. */
    paymentAmount: PositiveMinor.nullable(),
    payingAccountId: Id.nullable(),
    autoRecord: z.boolean(),
  })
  .partial()
  .extend({ version: Version });
export type UpdateLoanRequest = z.output<typeof UpdateLoanRequest>;

export const AmortizationRowDto = z.object({
  number: z.number().int(),
  date: CalendarDateDto,
  payment: MinorDto,
  interest: MinorDto,
  principal: MinorDto,
  escrow: MinorDto,
  balance: MinorDto,
  /** The bank line it was linked to. */
  transactionId: Id.nullable(),
});
export type AmortizationRowDto = z.infer<typeof AmortizationRowDto>;

export const LoanPaymentRequest = z.union([
  z.object({
    number: z.number().int().positive(),
    transactionId: Id,
    /** Accept a line for a different amount: principal takes the difference. */
    adjustPrincipal: z.boolean().optional(),
  }),
  z.object({
    number: z.number().int().positive(),
    accountId: Id,
    date: CalendarDateDto,
    /** Paid on top of the scheduled payment, all of it to principal. */
    extraPrincipal: NonNegativeMinor.optional(),
  }),
]);
export type LoanPaymentRequest = z.output<typeof LoanPaymentRequest>;

// ----- Depreciation (RNT-09) ---------------------------------------------------------------------------------

export const DepreciationDto = z.object({
  id: Id,
  propertyId: Id,
  name: z.string(),
  basis: MinorDto,
  inServiceDate: CalendarDateDto,
  method: z.enum(['SL_27_5', 'SL_39']),
  /** For the year asked about. */
  forYear: MinorDto,
  /** Everything to the end of that year. */
  accumulated: MinorDto,
  transactionId: Id.nullable(),
  version: z.number().int(),
});
export type DepreciationDto = z.infer<typeof DepreciationDto>;

export const CreateDepreciationRequest = z.object({
  propertyId: Id,
  name: Text(200).min(1),
  basis: PositiveMinor,
  inServiceDate: CalendarDateDto,
  method: z.enum(['SL_27_5', 'SL_39']).default('SL_27_5'),
});
export type CreateDepreciationRequest = z.output<typeof CreateDepreciationRequest>;

// ----- Reminders and maintenance (RNT-12, RNT-13) ---------------------------------------------------------------

export const ReminderKind = z.enum(['lease_end', 'insurance', 'property_tax', 'inspection', 'other']);
export type ReminderKind = z.infer<typeof ReminderKind>;

export const ReminderDto = z.object({
  /** Null for a lease ending: those come from the lease. */
  id: Id.nullable(),
  kind: ReminderKind,
  title: z.string(),
  propertyId: Id.nullable(),
  leaseId: Id.nullable(),
  dueDate: CalendarDateDto,
  /** Whether it's in its lead time now. */
  active: z.boolean(),
  overdue: z.boolean(),
  version: z.number().int().nullable(),
});
export type ReminderDto = z.infer<typeof ReminderDto>;

export const CreateReminderRequest = z.object({
  entityId: Id,
  propertyId: Id.nullable().optional(),
  kind: z.enum(['insurance', 'property_tax', 'inspection', 'other']),
  title: Text(200).min(1),
  dueDate: CalendarDateDto,
  leadDays: z.number().int().min(0).max(365).default(30),
});
export type CreateReminderRequest = z.output<typeof CreateReminderRequest>;

export const UpdateReminderRequest = z
  .object({ title: Text(200).min(1), dueDate: CalendarDateDto, done: z.boolean() })
  .partial()
  .extend({ version: Version });
export type UpdateReminderRequest = z.output<typeof UpdateReminderRequest>;

export const MaintenanceStatus = z.enum(['open', 'scheduled', 'done']);
export type MaintenanceStatus = z.infer<typeof MaintenanceStatus>;

export const MaintenanceDto = z.object({
  id: Id,
  entityId: Id,
  propertyId: Id,
  propertyName: z.string(),
  unitId: Id.nullable(),
  unitLabel: z.string().nullable(),
  issue: z.string(),
  vendor: z.string().nullable(),
  cost: MinorDto.nullable(),
  status: MaintenanceStatus,
  reportedOn: CalendarDateDto,
  completedOn: CalendarDateDto.nullable(),
  fileIds: z.array(Id),
  transactionIds: z.array(Id),
  notes: z.string().nullable(),
  version: z.number().int(),
});
export type MaintenanceDto = z.infer<typeof MaintenanceDto>;

export const CreateMaintenanceRequest = z.object({
  propertyId: Id,
  unitId: Id.nullable().optional(),
  issue: Text(500).min(1),
  vendor: Text(200).nullable().optional(),
  cost: NonNegativeMinor.nullable().optional(),
  reportedOn: CalendarDateDto,
  fileIds: z.array(Id).max(20).default([]),
  transactionIds: z.array(Id).max(50).default([]),
  notes: Text(2000).nullable().optional(),
});
export type CreateMaintenanceRequest = z.output<typeof CreateMaintenanceRequest>;

export const UpdateMaintenanceRequest = CreateMaintenanceRequest.omit({ propertyId: true }).partial().extend({
  status: MaintenanceStatus.optional(),
  completedOn: CalendarDateDto.nullable().optional(),
  version: Version,
});
export type UpdateMaintenanceRequest = z.output<typeof UpdateMaintenanceRequest>;

// ----- Budgets per property (RNT-14) ---------------------------------------------------------------------------

export const PropertyBudgetDto = z.object({
  propertyId: Id,
  month: CalendarDateDto,
  currency: CurrencyCodeDto,
  units: z.number().int(),
  capexReservePerUnit: MinorDto,
  /** Units × the reserve. */
  capexReserve: MinorDto,
  expectedRent: MinorDto,
  receivedRent: MinorDto,
  planned: MinorDto,
  spent: MinorDto,
  /** Expected rent − planned costs − the reserve. */
  expectedNet: MinorDto,
  lines: z.array(z.object({ categoryId: Id, name: z.string(), planned: MinorDto, spent: MinorDto })),
  version: z.number().int().nullable(),
});
export type PropertyBudgetDto = z.infer<typeof PropertyBudgetDto>;

export const SavePropertyBudgetRequest = z.object({
  capexReservePerUnit: NonNegativeMinor,
  lines: z.array(z.object({ categoryId: Id, amount: NonNegativeMinor })).max(100),
});
export type SavePropertyBudgetRequest = z.output<typeof SavePropertyBudgetRequest>;

// ----- Reports (RNT-11, UP-10) -----------------------------------------------------------------------------------

const RentalMetrics = z.object({
  income: MinorDto,
  operatingExpenses: MinorDto,
  /** Income − operating expenses, before debt service, depreciation and capital spending. */
  noi: MinorDto,
  /** Interest and principal. */
  debtService: MinorDto,
  capex: MinorDto,
  cashFlow: MinorDto,
  /** NOI ÷ value, annualized for the range. Null without a value. */
  capRateBps: z.number().int().nullable(),
  /** Cash flow ÷ cash invested, annualized for the range. Null without it. */
  cashOnCashBps: z.number().int().nullable(),
  /** Occupied unit-days ÷ all unit-days. Null with no units. */
  occupancyBps: z.number().int().nullable(),
});
export type RentalMetrics = z.infer<typeof RentalMetrics>;

export const PropertyReportDto = RentalMetrics.extend({
  propertyId: Id.nullable(),
  name: z.string(),
  units: z.number().int(),
  currentValue: MinorDto.nullable(),
  cashInvested: MinorDto.nullable(),
  lines: z.array(
    z.object({
      categoryId: Id,
      name: z.string(),
      type: z.enum(['income', 'expense']),
      amount: MinorDto,
    }),
  ),
});
export type PropertyReportDto = z.infer<typeof PropertyReportDto>;

export const PortfolioReportDto = z.object({
  entityId: Id,
  from: CalendarDateDto,
  to: CalendarDateDto,
  currency: CurrencyCodeDto,
  portfolio: PropertyReportDto,
  properties: z.array(PropertyReportDto),
  /** Expenses tagged to no property: in the portfolio's totals, and no property's. */
  untagged: PropertyReportDto,
});
export type PortfolioReportDto = z.infer<typeof PortfolioReportDto>;

export const ScheduleELineDto = z.object({
  code: z.string(),
  line: z.string(),
  label: z.string(),
  amount: MinorDto,
  categoryIds: z.array(Id),
  /** The depreciation helper's figure, included in the amount; it isn't in the ledger. */
  depreciation: MinorDto.nullable(),
});
export type ScheduleELineDto = z.infer<typeof ScheduleELineDto>;

export const ScheduleEDto = z.object({
  entityId: Id,
  year: z.number().int(),
  currency: CurrencyCodeDto,
  properties: z.array(
    z.object({
      propertyId: Id.nullable(),
      name: z.string(),
      address: z.string().nullable(),
      type: z.string().nullable(),
      ownershipBps: z.number().int(),
      lines: z.array(ScheduleELineDto),
      income: MinorDto,
      expenses: MinorDto,
      net: MinorDto,
      /** Net at the ownership share. */
      yourShare: MinorDto,
    }),
  ),
  /** In the totals, on no line until the category is mapped. */
  unmapped: z.array(z.object({ categoryId: Id, name: z.string(), amount: MinorDto })),
  totalIncome: MinorDto,
  totalExpenses: MinorDto,
  totalNet: MinorDto,
  totalYourShare: MinorDto,
});
export type ScheduleEDto = z.infer<typeof ScheduleEDto>;

export const ScheduleEExportFormat = z.enum(['csv', 'xlsx']);
export type ScheduleEExportFormat = z.infer<typeof ScheduleEExportFormat>;
