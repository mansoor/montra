import { z } from 'zod';
import { CalendarDateDto, CurrencyCodeDto, Id } from './common.js';
import { MinorDto } from './budgets.js';
import { Cadence } from './ledger.js';

// ----- Employers and payslips (PAY-01..09; design 03 §8, 04 §14, ADR-0016) ----------------------------------

export const EmployerType = z.enum(['employer', 'freelance', 'pension', 'benefits', 'other']);
export type EmployerType = z.infer<typeof EmployerType>;

/** A fixed amount of each pay that goes to another account. Whatever's left goes to the employer's deposit account (ADR-0022). */
export const DepositSplitInput = z.object({
  accountId: Id,
  amount: MinorDto.refine((s) => BigInt(s) > 0n, 'Amount must be more than zero'),
});
export type DepositSplitInput = z.output<typeof DepositSplitInput>;

const DepositSplits = z
  .array(DepositSplitInput)
  .max(10)
  .refine(
    (list) => new Set(list.map((d) => d.accountId)).size === list.length,
    'Each account can only be listed once',
  );

export const CreateEmployerRequest = z.object({
  /** Defaults to the Personal entity. */
  entityId: Id.optional(),
  memberId: Id,
  name: z.string().trim().min(1).max(200),
  type: EmployerType.default('employer'),
  payFrequency: Cadence.default('monthly'),
  /** The bank account the pay lands in. */
  depositAccountId: Id,
  /** How the pay appears on the statement, for matching the deposit. Defaults to the name. */
  payee: z.string().trim().max(200).nullable().optional(),
  deposits: DepositSplits.default([]),
});
export type CreateEmployerRequest = z.output<typeof CreateEmployerRequest>;

export const UpdateEmployerRequest = z
  .object({
    name: z.string().trim().min(1).max(200),
    type: EmployerType,
    payFrequency: Cadence,
    depositAccountId: Id,
    payee: z.string().trim().max(200).nullable(),
    retirementAccountId: Id.nullable(),
    archived: z.boolean(),
    deposits: DepositSplits,
  })
  .partial()
  .extend({ version: z.number().int().positive() });
export type UpdateEmployerRequest = z.output<typeof UpdateEmployerRequest>;

export const EmployerDto = z.object({
  id: Id,
  entityId: Id,
  memberId: Id,
  name: z.string(),
  type: EmployerType,
  payFrequency: Cadence,
  depositAccountId: Id,
  /** Fixed amounts to other accounts. The rest goes to `depositAccountId`. */
  deposits: z.array(z.object({ accountId: Id, amount: MinorDto })),
  payee: z.string().nullable(),
  retirementAccountId: Id.nullable(),
  archived: z.boolean(),
  /** The latest confirmed pay date, for "last payslip". */
  lastPayDate: CalendarDateDto.nullable(),
  version: z.number().int(),
});
export type EmployerDto = z.infer<typeof EmployerDto>;

export const PAYSLIP_SECTIONS = ['earning', 'pre_tax', 'tax', 'post_tax', 'employer'] as const;
export const PayslipSection = z.enum(PAYSLIP_SECTIONS);
export type PayslipSection = z.infer<typeof PayslipSection>;

export const PAYSLIP_STATUSES = ['processing', 'needs_review', 'posted', 'rejected'] as const;
export const PayslipStatus = z.enum(PAYSLIP_STATUSES);
export type PayslipStatus = z.infer<typeof PayslipStatus>;

const NonNegativeMinor = MinorDto.refine((s) => BigInt(s) >= 0n, 'Amount must not be negative');

export const PayslipLineInput = z.object({
  section: PayslipSection,
  /** salary, overtime, bonus, commission, 401k, roth_401k, hsa, fsa, health, fed_tax, state_tax, local_tax,
   * social_security, medicare, union_dues, loan, match, other. */
  code: z.string().trim().min(1).max(40),
  label: z.string().trim().min(1).max(200),
  amount: NonNegativeMinor,
  ytd: NonNegativeMinor.nullable().optional(),
  /** Post this line somewhere other than the default for its code. */
  accountId: Id.nullable().optional(),
});
export type PayslipLineInput = z.output<typeof PayslipLineInput>;

export const PayslipLineDto = z.object({
  id: Id,
  lineNo: z.number().int().positive(),
  section: PayslipSection,
  code: z.string(),
  label: z.string(),
  amount: MinorDto,
  ytd: MinorDto.nullable(),
  accountId: Id.nullable(),
});
export type PayslipLineDto = z.infer<typeof PayslipLineDto>;

/** A deposit that could be this pay, when more than one could (PAY-04). */
export const DepositCandidateDto = z.object({
  /** The account this could be the deposit for. With a split, each account has its own. */
  accountId: Id,
  transactionId: Id,
  date: CalendarDateDto,
  amount: MinorDto,
  payee: z.string().nullable(),
});
export type DepositCandidateDto = z.infer<typeof DepositCandidateDto>;

export const PayslipDto = z.object({
  id: Id,
  entityId: Id,
  employerId: Id,
  memberId: Id,
  status: PayslipStatus,
  payDate: CalendarDateDto.nullable(),
  periodStart: CalendarDateDto.nullable(),
  periodEnd: CalendarDateDto.nullable(),
  currency: CurrencyCodeDto,
  gross: MinorDto,
  net: MinorDto,
  /** computed net − printed net; a payslip confirms only at zero. */
  gap: MinorDto,
  lines: z.array(PayslipLineDto),
  fileIds: z.array(Id),
  extraction: z
    .object({
      provider: z.string().nullable(),
      model: z.string().nullable(),
      confidence: z.number().nullable(),
      warnings: z.array(z.string()),
    })
    .nullable(),
  /** The transaction it posted to: a new one, or the imported deposit it took over. */
  transactionId: Id.nullable(),
  /** True when it took over an imported deposit, so the deposit isn't counted twice (PAY-04). */
  matchedDeposit: z.boolean(),
  matchCandidates: z.array(DepositCandidateDto),
  /** What goes to the employer's deposit account: the net, less `deposits`. */
  mainDeposit: MinorDto,
  /** Fixed amounts to other accounts (ADR-0022), each its own transaction once posted. */
  deposits: z.array(
    z.object({
      accountId: Id,
      amount: MinorDto,
      transactionId: Id.nullable(),
      matchedDeposit: z.boolean(),
    }),
  ),
  version: z.number().int(),
});
export type PayslipDto = z.infer<typeof PayslipDto>;

/**
 * POST /payslips: from uploaded files (AI reads them), or by hand. `fromLast` starts from the employer's last
 * payslip (PAY-03), with its lines and amounts to check against the new one.
 */
export const CreatePayslipRequest = z.object({
  employerId: Id,
  fileIds: z.array(Id).max(20).default([]),
  fromLast: z.boolean().default(false),
  payDate: CalendarDateDto.optional(),
});
export type CreatePayslipRequest = z.output<typeof CreatePayslipRequest>;

/** PATCH /payslips/{id}: the fields the user checks. Posted payslips re-post. */
export const UpdatePayslipRequest = z
  .object({
    payDate: CalendarDateDto,
    periodStart: CalendarDateDto.nullable(),
    periodEnd: CalendarDateDto.nullable(),
    net: NonNegativeMinor,
    lines: z.array(PayslipLineInput).min(1).max(100),
    /** Only before posting: this payslip's split. */
    deposits: DepositSplits,
  })
  .partial()
  .extend({ version: z.number().int().positive() });
export type UpdatePayslipRequest = z.output<typeof UpdatePayslipRequest>;

/** POST /payslips/{id}/confirm: posts it. `depositTransactionId` picks among several candidates, or null for none. */
export const ConfirmPayslipRequest = z.object({
  version: z.number().int().positive(),
  depositTransactionId: Id.nullable().optional(),
  /** The same choice for the other accounts in a split. */
  otherDeposits: z
    .array(z.object({ accountId: Id, transactionId: Id.nullable() }))
    .max(10)
    .optional(),
});
export type ConfirmPayslipRequest = z.output<typeof ConfirmPayslipRequest>;

// ----- Reports by member (FAM-08, PAY-06, RPT-01) -----------------------------------------------------------

/** One member, or Household (memberId null), in a date range. Income and spending are functional amounts. */
export const MemberTotalsDto = z.object({
  memberId: Id.nullable(),
  name: z.string(),
  income: MinorDto,
  spending: MinorDto,
  /** Share of all spending, 0–100 (display only). */
  spendingShare: z.number(),
  categories: z.array(
    z.object({ categoryId: Id, name: z.string(), group: z.string().nullable(), amount: MinorDto }),
  ),
  /** Spending per calendar month in the range, oldest first (cost over time). */
  months: z.array(z.object({ month: CalendarDateDto, income: MinorDto, spending: MinorDto })),
});
export type MemberTotalsDto = z.infer<typeof MemberTotalsDto>;

export const MemberReportDto = z.object({
  from: CalendarDateDto,
  to: CalendarDateDto,
  currency: CurrencyCodeDto,
  members: z.array(MemberTotalsDto),
});
export type MemberReportDto = z.infer<typeof MemberReportDto>;

const WithholdingDto = z.object({
  payslips: z.number().int(),
  gross: MinorDto,
  net: MinorDto,
  taxes: MinorDto,
  preTax: MinorDto,
  postTax: MinorDto,
  retirement: MinorDto,
  employer: MinorDto,
  /** Taxes ÷ gross in basis points; null without pay. */
  effectiveRateBps: z.number().int().nullable(),
});
export type WithholdingDto = z.infer<typeof WithholdingDto>;

/** PAY-06: gross vs net, taxes, retirement and effective rate, year to date against the same span last year. */
export const PayslipSummaryDto = z.object({
  memberId: Id,
  name: z.string(),
  currency: CurrencyCodeDto,
  year: z.number().int(),
  through: CalendarDateDto,
  ytd: WithholdingDto,
  priorYear: WithholdingDto,
  byTax: z.array(z.object({ code: z.string(), label: z.string(), amount: MinorDto })),
});
export type PayslipSummaryDto = z.infer<typeof PayslipSummaryDto>;
