import { z } from 'zod';
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

export const BusinessProfileDto = z.object({
  entityId: Id,
  name: z.string(),
  businessType: z.string().nullable(),
  fiscalYearStartMonth: z.number().int(),
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
  deduction: MinorDto,
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
});
export type CreateTripRequest = z.output<typeof CreateTripRequest>;

export const UpdateTripRequest = CreateTripRequest.omit({ entityId: true })
  .partial()
  .extend({ version: Version });
export type UpdateTripRequest = z.output<typeof UpdateTripRequest>;

export const MileageSummaryDto = z.object({
  year: z.number().int(),
  trips: z.array(MileageTripDto),
  miles: z.string(),
  deduction: MinorDto,
  currency: CurrencyCodeDto,
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
  year: z.number().int(),
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
