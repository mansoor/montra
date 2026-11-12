import { z } from 'zod';
import { BUSINESS_TYPES } from '@montra/domain';
import { CalendarDateDto, CurrencyCodeDto, Id } from './common.js';
import { MinorDto } from './budgets.js';

// ----- Small business (BIZ-01..13, AI-10; design 03 §8, 04 §13, ADR-0017). Cash basis throughout. --------------

const NonNegativeMinor = MinorDto.refine((s) => BigInt(s) >= 0n, 'Amount must not be negative');
const PositiveMinor = MinorDto.refine((s) => BigInt(s) > 0n, 'Amount must be more than zero');
const Text = (max: number) => z.string().trim().max(max);
const Version = z.number().int().positive();

// ----- Profile (BIZ-01, BIZ-09, BIZ-12) ----------------------------------------------------------------------

/**
 * A website or email domain as people type it ("https://www.Example.com/about", "sales@example.com") → the bare host
 * name ("www.example.com", "example.com"), or null when it isn't one. Letters of any script are kept as typed; the
 * last label is a word of letters or a punycode label. No URL parser: Hermes doesn't have a full one.
 */
export function normalizeDomain(input: string): string | null {
  let s = input.trim().toLowerCase();
  if (!s) return null;
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, ''); // scheme
  s = s.replace(/^[^/?#]*@/, ''); // an email address, or credentials in a URL
  s = s.replace(/[/?#].*$/, ''); // path, query, fragment
  s = s.replace(/:\d+$/, '').replace(/\.$/, ''); // port, a trailing dot
  if (s.length < 3 || s.length > 253) return null;
  const labels = s.split('.');
  if (labels.length < 2) return null;
  const label = /^[\p{L}\p{N}](?:[\p{L}\p{N}-]{0,61}[\p{L}\p{N}])?$/u;
  if (!labels.every((l) => label.test(l))) return null;
  const top = labels[labels.length - 1]!;
  return /^\p{L}{2,63}$/u.test(top) || /^xn--[a-z0-9-]{1,59}$/.test(top) ? s : null;
}

/** What the settings accept for the domain: normalized, or refused with a reason people can act on. */
export const DomainInput = z
  .string()
  .max(300)
  .transform((s, ctx) => {
    const d = normalizeDomain(s);
    if (!d) {
      ctx.addIssue({ code: 'custom', message: 'Enter a domain such as example.com' });
      return z.NEVER;
    }
    return d;
  });

/** Logos are small images: PNG or JPEG, checked by their content, at most this big. */
export const LOGO_MAX_BYTES = 1_048_576;
export const LOGO_MAX_PIXELS = 4096;
export const BusinessLogoDto = z.object({
  fileId: Id,
  mediaType: z.enum(['image/png', 'image/jpeg']),
  bytes: z.number().int(),
  width: z.number().int(),
  height: z.number().int(),
});
export type BusinessLogoDto = z.infer<typeof BusinessLogoDto>;

// ----- Legal and tax setup, and registrations (BIZ-21..26, ADR-0037) ---------------------------------------------

/** Entity types the owner can choose. An LLC's tax treatment is part of its type (ADR-0037 §1). */
export const BusinessTypeInput = z.enum(BUSINESS_TYPES);
export type BusinessTypeInput = z.infer<typeof BusinessTypeInput>;

/** The federal return the entity type files (derived; Montra doesn't prepare it). */
export const ReturnFormDto = z.enum(['schedule_c', 'form_1065', 'form_1120s', 'form_1120']);
export type ReturnFormDto = z.infer<typeof ReturnFormDto>;

const digitsOnly = (s: string) => s.replace(/[\s-]/g, '');
const StateCode = z
  .string()
  .trim()
  .transform((s) => s.toUpperCase())
  .pipe(z.string().regex(/^[A-Z]{2}$/, 'Use the two-letter state code'));
/** Blank is the same as null. */
const OptionalText = (max: number) =>
  Text(max)
    .transform((s) => s || null)
    .nullable();

export const EinInput = z
  .string()
  .transform(digitsOnly)
  .pipe(z.string().regex(/^\d{9}$/, 'An EIN has nine digits'));
export const EddAccountInput = z
  .string()
  .transform(digitsOnly)
  .pipe(z.string().regex(/^\d{8}$/, 'An EDD account number has eight digits'));

/** The address the IRS and SSA have, in parts: W-2s, 1099s and the EFW2 file print it (moved from payroll). */
export const FilingAddressDto = z.object({
  line1: z.string(),
  line2: z.string().nullable(),
  city: z.string(),
  state: z.string(),
  zip: z.string(),
});
export type FilingAddressDto = z.infer<typeof FilingAddressDto>;
export const FilingAddressInput = z.object({
  line1: Text(100).min(1),
  line2: OptionalText(100).optional(),
  city: Text(60).min(1),
  state: StateCode,
  zip: z
    .string()
    .transform(digitsOnly)
    .pipe(z.string().regex(/^\d{5}(\d{4})?$/, 'A ZIP code has 5 or 9 digits')),
});

/** A registration beyond the named ones: a county permit, a professional licence, another state's account. */
export const OtherRegistrationDto = z.object({
  id: Id,
  label: z.string(),
  number: z.string().nullable(),
  issuer: z.string().nullable(),
  expiresOn: CalendarDateDto.nullable(),
  version: z.number().int(),
});
export type OtherRegistrationDto = z.infer<typeof OtherRegistrationDto>;

export const OtherRegistrationInput = z.object({
  label: Text(200).min(1),
  number: OptionalText(100).optional(),
  issuer: OptionalText(200).optional(),
  expiresOn: CalendarDateDto.nullable().optional(),
});
export type OtherRegistrationInput = z.output<typeof OtherRegistrationInput>;
export const UpdateOtherRegistrationRequest = OtherRegistrationInput.partial().extend({ version: Version });
export type UpdateOtherRegistrationRequest = z.output<typeof UpdateOtherRegistrationRequest>;

/**
 * Federal, state and local registrations. Tax account numbers come back masked to their last four (ADR-0037 §5); the
 * full value is a separate, logged `reveal`. Public-record numbers (the SOS file number, a city licence) are shown.
 */
export const BusinessRegistrationsDto = z.object({
  /** "••-•••6789". */
  einMasked: z.string().nullable(),
  /** The name exactly as the IRS has it (the EIN letter, CP 575). */
  irsName: z.string().nullable(),
  naicsCode: z.string().nullable(),
  formationState: z.string().nullable(),
  /** In California, the Secretary of State's entity (file) number. */
  sosEntityNumber: z.string().nullable(),
  formationDate: CalendarDateDto.nullable(),
  ftbEntityIdMasked: z.string().nullable(),
  caEmployerAccountMasked: z.string().nullable(),
  cdtfaPermitMasked: z.string().nullable(),
  registeredAgentName: z.string().nullable(),
  registeredAgentAddress: z.string().nullable(),
  dbaName: z.string().nullable(),
  dbaCounty: z.string().nullable(),
  dbaExpiresOn: CalendarDateDto.nullable(),
  cityLicenseNumber: z.string().nullable(),
  cityLicenseExpiresOn: CalendarDateDto.nullable(),
  filingAddress: FilingAddressDto.nullable(),
  other: z.array(OtherRegistrationDto),
});
export type BusinessRegistrationsDto = z.infer<typeof BusinessRegistrationsDto>;

/** Which full number to show. Each reveal needs a recent sign-in and is written to the audit log. */
export const BusinessRevealField = z.enum(['ein', 'ftbEntityId', 'caEmployerAccount', 'cdtfaPermit']);
export type BusinessRevealField = z.infer<typeof BusinessRevealField>;
export const BusinessRevealRequest = z.object({ field: BusinessRevealField });
export type BusinessRevealRequest = z.output<typeof BusinessRevealRequest>;
export const BusinessRevealResponse = z.object({ field: BusinessRevealField, value: z.string().nullable() });
export type BusinessRevealResponse = z.infer<typeof BusinessRevealResponse>;

export const BusinessProfileDto = z.object({
  entityId: Id,
  name: z.string(),
  /** One of `BusinessTypeInput`, or `llc`/`other` from before the owner could choose (ADR-0037 §1); null: not set. */
  businessType: z.string().nullable(),
  /** 1 = January. Sets the P&L's year and the Schedule C summary's year (ADR-0037 §2). */
  fiscalYearStartMonth: z.number().int(),
  /** Null while the type doesn't say; Montra then assumes Schedule C, as it always has. */
  returnForm: ReturnFormDto.nullable(),
  /** Form 2553's effective date, for the S-corp types. */
  sCorpElectionDate: CalendarDateDto.nullable(),
  registrations: BusinessRegistrationsDto,
  currency: CurrencyCodeDto,
  legalName: z.string().nullable(),
  address: z.string().nullable(),
  email: z.string().nullable(),
  invoicePrefix: z.string(),
  defaultTermsDays: z.number().int(),
  defaultDepositAccountId: Id.nullable(),
  taxRateBps: z.number().int().nullable(),
  taxSavingsAccountId: Id.nullable(),
  receiptThreshold: MinorDto,
  /**
   * ADR-0032: the logo printed on invoices, a PNG or JPEG. Read it from `GET /businesses/:entityId/logo`; the file id
   * changes with each upload, so it also serves to refresh a cached copy.
   */
  logoFileId: Id.nullable(),
  /** The business's website or email domain, as a bare host name ("example.com"). */
  domain: z.string().nullable(),
  version: z.number().int(),
});
export type BusinessProfileDto = z.infer<typeof BusinessProfileDto>;

export const UpdateBusinessProfileRequest = z
  .object({
    legalName: Text(200).nullable(),
    address: Text(1000).nullable(),
    email: z.email().max(320).nullable(),
    invoicePrefix: Text(20),
    defaultTermsDays: z.number().int().min(0).max(365),
    defaultDepositAccountId: Id.nullable(),
    taxRateBps: z.number().int().min(0).max(10000).nullable(),
    taxSavingsAccountId: Id.nullable(),
    receiptThreshold: NonNegativeMinor,
    domain: DomainInput.nullable(),
    // ADR-0037. The type and fiscal year are on the entity, so only an owner changes them.
    businessType: BusinessTypeInput,
    fiscalYearStartMonth: z.number().int().min(1).max(12),
    sCorpElectionDate: CalendarDateDto.nullable(),
    ein: EinInput.nullable(),
    irsName: OptionalText(200),
    naicsCode: z
      .string()
      .trim()
      .regex(/^\d{2,6}$/, 'A NAICS code has two to six digits')
      .nullable(),
    formationState: StateCode.nullable(),
    sosEntityNumber: OptionalText(30),
    formationDate: CalendarDateDto.nullable(),
    ftbEntityId: OptionalText(30),
    caEmployerAccount: EddAccountInput.nullable(),
    cdtfaPermit: OptionalText(30),
    registeredAgentName: OptionalText(200),
    registeredAgentAddress: OptionalText(1000),
    dbaName: OptionalText(200),
    dbaCounty: OptionalText(60),
    dbaExpiresOn: CalendarDateDto.nullable(),
    cityLicenseNumber: OptionalText(50),
    cityLicenseExpiresOn: CalendarDateDto.nullable(),
    filingAddress: FilingAddressInput.nullable(),
  })
  .partial();
export type UpdateBusinessProfileRequest = z.output<typeof UpdateBusinessProfileRequest>;

// ----- Customers and vendors (BIZ-04) ------------------------------------------------------------------------

export const PartyKind = z.enum(['customer', 'vendor']);
export type PartyKind = z.infer<typeof PartyKind>;

/**
 * A customer or vendor. `id` is null for one found from transactions that has no details yet: it's listed from its
 * activity, and saving details or invoicing it creates the row.
 */
export const PartyDto = z.object({
  id: Id.nullable(),
  entityId: Id,
  kind: PartyKind,
  name: z.string(),
  payeeKey: z.string().nullable(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  address: z.string().nullable(),
  termsDays: z.number().int().nullable(),
  notes: z.string().nullable(),
  archived: z.boolean(),
  /** Received from a customer, or paid to a vendor, this tax year. */
  yearTotal: MinorDto,
  lastActivity: CalendarDateDto.nullable(),
  version: z.number().int().nullable(),
});
export type PartyDto = z.infer<typeof PartyDto>;

export const CreatePartyRequest = z.object({
  entityId: Id,
  kind: PartyKind,
  name: Text(200).min(1),
  /** Ties it to the payee it was found from; otherwise derived from the name. */
  payeeKey: Text(200).nullable().optional(),
  email: z.email().max(320).nullable().optional(),
  phone: Text(50).nullable().optional(),
  address: Text(1000).nullable().optional(),
  termsDays: z.number().int().min(0).max(365).nullable().optional(),
  notes: Text(2000).nullable().optional(),
});
export type CreatePartyRequest = z.output<typeof CreatePartyRequest>;

export const UpdatePartyRequest = CreatePartyRequest.omit({ entityId: true, kind: true })
  .partial()
  .extend({ archived: z.boolean().optional(), version: Version });
export type UpdatePartyRequest = z.output<typeof UpdatePartyRequest>;

// ----- Invoices (BIZ-05) -------------------------------------------------------------------------------------

export const InvoiceStatus = z.enum(['draft', 'sent', 'partial', 'paid', 'overdue', 'void']);
export type InvoiceStatus = z.infer<typeof InvoiceStatus>;

export const InvoiceLineInput = z.object({
  description: Text(500).min(1),
  /** Decimal, up to three places: "1.5". */
  quantity: z.string().regex(/^\d{1,9}(\.\d{1,3})?$/, 'Enter a quantity such as 1.5'),
  unitPrice: NonNegativeMinor,
  taxRateBps: z.number().int().min(0).max(10000).default(0),
  /** The income category. Defaults to the first one of the business. */
  incomeAccountId: Id.optional(),
});
export type InvoiceLineInput = z.output<typeof InvoiceLineInput>;

export const InvoiceLineDto = z.object({
  id: Id,
  lineNo: z.number().int(),
  description: z.string(),
  quantity: z.string(),
  unitPrice: MinorDto,
  taxRateBps: z.number().int(),
  amount: MinorDto,
  tax: MinorDto,
  incomeAccountId: Id,
});
export type InvoiceLineDto = z.infer<typeof InvoiceLineDto>;

export const InvoicePaymentDto = z.object({
  id: Id,
  transactionId: Id,
  date: CalendarDateDto,
  amount: MinorDto,
  source: z.enum(['auto', 'manual']),
});
export type InvoicePaymentDto = z.infer<typeof InvoicePaymentDto>;

export const InvoiceDto = z.object({
  id: Id,
  entityId: Id,
  partyId: Id,
  partyName: z.string(),
  number: z.string(),
  status: InvoiceStatus,
  issueDate: CalendarDateDto,
  dueDate: CalendarDateDto,
  currency: CurrencyCodeDto,
  subtotal: MinorDto,
  tax: MinorDto,
  total: MinorDto,
  paid: MinorDto,
  open: MinorDto,
  notes: z.string().nullable(),
  sentAt: z.string().nullable(),
  sentTo: z.string().nullable(),
  lines: z.array(InvoiceLineDto),
  payments: z.array(InvoicePaymentDto),
  version: z.number().int(),
});
export type InvoiceDto = z.infer<typeof InvoiceDto>;

export const CreateInvoiceRequest = z.object({
  entityId: Id,
  partyId: Id,
  issueDate: CalendarDateDto,
  /** Defaults to the customer's terms, then the business's. */
  dueDate: CalendarDateDto.optional(),
  notes: Text(2000).nullable().optional(),
  lines: z.array(InvoiceLineInput).min(1).max(200),
});
export type CreateInvoiceRequest = z.output<typeof CreateInvoiceRequest>;

/** Only a draft can change: what's been sent stays as sent. Void it and issue another instead. */
export const UpdateInvoiceRequest = CreateInvoiceRequest.omit({ entityId: true })
  .partial()
  .extend({ version: Version });
export type UpdateInvoiceRequest = z.output<typeof UpdateInvoiceRequest>;

/** POST /invoices/{id}/send: emails the PDF, or with `email: false` just marks it sent (handed over another way). */
export const SendInvoiceRequest = z.object({
  version: Version,
  email: z.boolean().default(true),
  /** Defaults to the customer's address. */
  to: z.email().max(320).optional(),
  message: Text(2000).optional(),
});
export type SendInvoiceRequest = z.output<typeof SendInvoiceRequest>;

/** Link an existing deposit, or record a payment that isn't in the books yet. */
export const RecordPaymentRequest = z.union([
  z.object({ transactionId: Id }),
  z.object({ accountId: Id, date: CalendarDateDto, amount: PositiveMinor }),
]);
export type RecordPaymentRequest = z.output<typeof RecordPaymentRequest>;

/** A transaction that could be the payment of an invoice or bill. */
export const PaymentCandidateDto = z.object({
  transactionId: Id,
  date: CalendarDateDto,
  amount: MinorDto,
  payee: z.string().nullable(),
  accountId: Id,
});
export type PaymentCandidateDto = z.infer<typeof PaymentCandidateDto>;

// ----- Bills (BIZ-06) ----------------------------------------------------------------------------------------

export const BillStatus = z.enum(['open', 'overdue', 'paid', 'void']);
export type BillStatus = z.infer<typeof BillStatus>;

export const BillDto = z.object({
  id: Id,
  entityId: Id,
  partyId: Id,
  partyName: z.string(),
  reference: z.string().nullable(),
  status: BillStatus,
  billDate: CalendarDateDto,
  dueDate: CalendarDateDto,
  currency: CurrencyCodeDto,
  amount: MinorDto,
  expenseAccountId: Id,
  notes: z.string().nullable(),
  fileIds: z.array(Id),
  transactionId: Id.nullable(),
  version: z.number().int(),
});
export type BillDto = z.infer<typeof BillDto>;

export const CreateBillRequest = z.object({
  entityId: Id,
  partyId: Id,
  reference: Text(100).nullable().optional(),
  billDate: CalendarDateDto,
  dueDate: CalendarDateDto,
  amount: PositiveMinor,
  expenseAccountId: Id,
  notes: Text(2000).nullable().optional(),
  fileIds: z.array(Id).max(20).default([]),
});
export type CreateBillRequest = z.output<typeof CreateBillRequest>;

// Zod 4's .partial() keeps .default(): `fileIds` is redeclared without one (packages/schemas/test/patches.test.ts).
export const UpdateBillRequest = CreateBillRequest.omit({ entityId: true })
  .partial()
  .extend({ fileIds: z.array(Id).max(20).optional(), void: z.boolean().optional(), version: Version });
export type UpdateBillRequest = z.output<typeof UpdateBillRequest>;

// ----- Mileage (BIZ-07) --------------------------------------------------------------------------------------

export const MileageTripDto = z.object({
  id: Id,
  entityId: Id,
  date: CalendarDateDto,
  origin: z.string().nullable(),
  destination: z.string().nullable(),
  purpose: z.string(),
  vehicle: z.string().nullable(),
  /** Decimal miles, such as "12.4". */
  miles: z.string(),
  /** Cents per mile at the trip's date, such as "72.5". */
  centsPerMile: z.string(),
  /** Miles at the rate. The owner's deduction for their own trips; for a person's, what reimbursing it would pay. */
  deduction: MinorDto,
  /** BIZ-19: the owner's trips are the mileage deduction; a payroll person's aren't (ADR-0035 §8). */
  driver: z.enum(['owner', 'person']),
  driverPersonId: Id.nullable(),
  driverName: z.string().nullable(),
  reimbursementId: Id.nullable(),
  reimbursementStatus: z.enum(['submitted', 'approved', 'declined', 'paid']).nullable(),
  version: z.number().int(),
});
export type MileageTripDto = z.infer<typeof MileageTripDto>;

const Miles = z.string().regex(/^\d{1,6}(\.\d)?$/, 'Enter miles such as 12.4');

export const CreateTripRequest = z.object({
  entityId: Id,
  date: CalendarDateDto,
  origin: Text(200).nullable().optional(),
  destination: Text(200).nullable().optional(),
  purpose: Text(500).min(1),
  vehicle: Text(100).nullable().optional(),
  miles: Miles,
  /** A payroll person of this business who drove; null or left out for the owner. */
  driverPersonId: Id.nullable().optional(),
});
export type CreateTripRequest = z.output<typeof CreateTripRequest>;

export const UpdateTripRequest = CreateTripRequest.omit({ entityId: true })
  .partial()
  .extend({ version: Version });
export type UpdateTripRequest = z.output<typeof UpdateTripRequest>;

export const MileageSummaryDto = z.object({
  year: z.number().int(),
  trips: z.array(MileageTripDto),
  /** The owner's trips: these are the deduction. */
  miles: z.string(),
  deduction: MinorDto,
  currency: CurrencyCodeDto,
  /** BIZ-19: per driver, the owner first. `amount` is the deduction for the owner, and the value at the rate for others. */
  byDriver: z.array(
    z.object({
      driver: z.enum(['owner', 'person']),
      personId: Id.nullable(),
      name: z.string().nullable(),
      trips: z.number().int(),
      miles: z.string(),
      amount: MinorDto,
      reimbursed: MinorDto,
    }),
  ),
});
export type MileageSummaryDto = z.infer<typeof MileageSummaryDto>;

// ----- Estimated tax (BIZ-09) --------------------------------------------------------------------------------

export const TaxEstimateDto = z.object({
  entityId: Id,
  year: z.number().int(),
  currency: CurrencyCodeDto,
  /** Null until the user enters a rate: then there's profit to show but no set-aside. */
  rateBps: z.number().int().nullable(),
  /** Net profit so far this tax year. */
  ytdProfit: MinorDto,
  /** What the rate says to have put aside by now. */
  target: MinorDto,
  /** Transfers into the tax savings account this year. */
  saved: MinorDto,
  /** Target − saved, never negative. */
  toSetAside: MinorDto,
  periods: z.array(
    z.object({
      quarter: z.number().int(),
      through: CalendarDateDto,
      due: CalendarDateDto,
      /** Profit from January 1 through the period's end, as far as it's come. */
      profit: MinorDto,
      target: MinorDto,
      status: z.enum(['past', 'next', 'later']),
    }),
  ),
});
export type TaxEstimateDto = z.infer<typeof TaxEstimateDto>;

// ----- Reports (BIZ-10, AI-10) -------------------------------------------------------------------------------

export const PnlLineDto = z.object({
  categoryId: Id,
  name: z.string(),
  group: z.string().nullable(),
  taxLineCode: z.string().nullable(),
  amount: MinorDto,
});
export type PnlLineDto = z.infer<typeof PnlLineDto>;

export const PnlDto = z.object({
  entityId: Id,
  from: CalendarDateDto,
  to: CalendarDateDto,
  currency: CurrencyCodeDto,
  revenue: MinorDto,
  expenses: MinorDto,
  netProfit: MinorDto,
  /** Net ÷ revenue in basis points; null without revenue. */
  marginBps: z.number().int().nullable(),
  income: z.array(PnlLineDto),
  expense: z.array(PnlLineDto),
  months: z.array(z.object({ month: CalendarDateDto, revenue: MinorDto, expenses: MinorDto })),
});
export type PnlDto = z.infer<typeof PnlDto>;

// ----- The business's landing page (BIZ-10, FLOW-01; ADR-0032) -------------------------------------------------

export const BUSINESS_CHART_MONTHS = [3, 6, 12, 24] as const;
export const BusinessDashboardQuery = z.object({
  months: z.coerce
    .number()
    .int()
    .refine((n) => (BUSINESS_CHART_MONTHS as readonly number[]).includes(n), 'months must be 3, 6, 12 or 24')
    .default(6),
  /** The month the tiles are for (its first day); the charts and table end with it. Absent: this month. */
  month: CalendarDateDto.refine((d) => d.endsWith('-01'), 'month is the first day of a month').optional(),
});
export type BusinessDashboardQuery = z.output<typeof BusinessDashboardQuery>;

const OpenTotals = z.object({
  count: z.number().int(),
  amount: MinorDto,
  overdueCount: z.number().int(),
  overdueAmount: MinorDto,
});

/**
 * GET /businesses/:entityId/dashboard — one business at a glance, worked out on the server so web and phone agree.
 * Revenue and expenses are the P&L's (BIZ-10), month by month, so they match the reports. Money in and out is what
 * moved through the business's own bank, cash and card accounts, transfers between them left out.
 */
export const BusinessDashboardDto = z.object({
  entityId: Id,
  currency: CurrencyCodeDto,
  months: z.number().int(),
  /** The chosen month; `current` when it's this month (so far). */
  month: z.object({ start: CalendarDateDto, end: CalendarDateDto }),
  current: z.boolean(),
  /** The months the dropdown offers, newest first: this month back to the business's first activity (60 at most). */
  periods: z.array(z.object({ start: CalendarDateDto, end: CalendarDateDto })),
  /** One per calendar month, oldest first, ending with the chosen month. */
  monthly: z.array(
    z.object({
      start: CalendarDateDto,
      end: CalendarDateDto,
      moneyIn: MinorDto,
      moneyOut: MinorDto,
      revenue: MinorDto,
      expenses: MinorDto,
      /** revenue − expenses. */
      profit: MinorDto,
      /** Bank and cash balances at the month's end (today for this month). */
      cashOnHand: MinorDto,
    }),
  ),
  /** Over all the months shown. */
  totals: z.object({
    moneyIn: MinorDto,
    moneyOut: MinorDto,
    revenue: MinorDto,
    expenses: MinorDto,
    profit: MinorDto,
    marginBps: z.number().int().nullable(),
  }),
  /** Today, whatever month is chosen: what customers owe and what's owed to vendors. */
  openInvoices: OpenTotals,
  openBills: OpenTotals,
});
export type BusinessDashboardDto = z.infer<typeof BusinessDashboardDto>;

export const PartyReportDto = z.object({
  entityId: Id,
  kind: PartyKind,
  from: CalendarDateDto,
  to: CalendarDateDto,
  currency: CurrencyCodeDto,
  total: MinorDto,
  rows: z.array(
    z.object({
      name: z.string(),
      payeeKey: z.string().nullable(),
      amount: MinorDto,
      count: z.number().int(),
    }),
  ),
});
export type PartyReportDto = z.infer<typeof PartyReportDto>;

export const TaxLineDto = z.object({
  code: z.string(),
  form: z.string(),
  line: z.string(),
  label: z.string(),
  deductibleBps: z.number().int(),
});
export type TaxLineDto = z.infer<typeof TaxLineDto>;

export const ScheduleCDto = z.object({
  entityId: Id,
  /** The fiscal year, named by the year it begins in; `from`..`to` are its dates (ADR-0037 §2). */
  year: z.number().int(),
  from: CalendarDateDto,
  to: CalendarDateDto,
  currency: CurrencyCodeDto,
  lines: z.array(
    z.object({
      code: z.string(),
      line: z.string(),
      label: z.string(),
      amount: MinorDto,
      /** The categories behind it, for the drill-down. */
      categoryIds: z.array(Id),
      /** The mileage deduction, included in Car & truck expenses; it isn't in the ledger. */
      mileage: MinorDto.nullable(),
      /** Share usually deductible; below 100% means this isn't the amount to claim (meals). */
      deductibleBps: z.number().int(),
    }),
  ),
  grossReceipts: MinorDto,
  totalExpenses: MinorDto,
  netProfit: MinorDto,
  /** Spending in categories mapped to no line: not on the form until it's mapped. */
  unmapped: z.array(z.object({ categoryId: Id, name: z.string(), amount: MinorDto })),
  /** Gain (positive) or loss on assets sold: Form 4797, so not in these totals (ADR-0035 §5). */
  assetSales: MinorDto,
  warnings: z.array(z.enum(['mileage_and_actual_car'])),
});
export type ScheduleCDto = z.infer<typeof ScheduleCDto>;

/** BIZ-02, AI-10: the user's choice of line for a category; null takes it off the form. */
export const SetTaxLineRequest = z.object({ taxLineCode: z.string().max(40).nullable() });
export type SetTaxLineRequest = z.output<typeof SetTaxLineRequest>;

/** AI-10: a proposed tax line for a category without one. The user accepts it by mapping the category. */
export const TaxLineSuggestionDto = z.object({
  categoryId: Id,
  name: z.string(),
  code: z.string(),
  label: z.string(),
  explanation: z.string(),
});
export type TaxLineSuggestionDto = z.infer<typeof TaxLineSuggestionDto>;

// ----- Receipt vault (BIZ-12) --------------------------------------------------------------------------------

export const MissingReceiptsDto = z.object({
  entityId: Id,
  threshold: MinorDto,
  currency: CurrencyCodeDto,
  rows: z.array(
    z.object({
      transactionId: Id,
      date: CalendarDateDto,
      payee: z.string().nullable(),
      amount: MinorDto,
      categoryId: Id.nullable(),
      /** Over the de minimis limit on an equipment-like category, with no asset: "Record as an asset?" (BIZ-16). */
      assetCandidate: z.boolean(),
    }),
  ),
});
export type MissingReceiptsDto = z.infer<typeof MissingReceiptsDto>;

// ----- Accountant export (BIZ-13) ----------------------------------------------------------------------------

export const AccountingExportFormat = z.enum(['csv', 'xlsx', 'quickbooks_iif', 'xero_csv']);
export type AccountingExportFormat = z.infer<typeof AccountingExportFormat>;

export const AccountingExportQuery = z.object({
  entityId: Id,
  from: CalendarDateDto,
  to: CalendarDateDto,
  format: AccountingExportFormat,
});
export type AccountingExportQuery = z.output<typeof AccountingExportQuery>;
