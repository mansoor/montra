import { z } from 'zod';
import { CalendarDateDto, Id } from './common.js';
import { MinorDto } from './budgets.js';

// ----- Payroll (PRL-01..22, requirements 5.1, ADR-0034). Stage 1: people and onboarding forms. ----------------------
// Personal data never comes back in full from a list or a read: TINs and bank numbers are masked, and a full value
// takes a separate, logged reveal request.

const NonNegativeMinor = MinorDto.refine((s) => BigInt(s) >= 0n, 'Amount must not be negative');
const Text = (max: number) => z.string().trim().max(max);
const OptionalText = (max: number) => Text(max).nullable().optional();
const Version = z.number().int().positive();
const StateCode = z
  .string()
  .trim()
  .transform((s) => s.toUpperCase())
  .pipe(z.string().regex(/^[A-Z]{2}$/, 'Use the two-letter state code'));

/** Digits only: dashes and spaces are dropped before checking. */
const digits = (s: string) => s.replace(/[\s-]/g, '');

export const TinType = z.enum(['ssn', 'itin', 'ein']);
export type TinType = z.infer<typeof TinType>;

/**
 * An SSN, ITIN or EIN as nine digits. An SSN's area, group and serial can't be all zeros and its area can't be 666;
 * 9xx areas are allowed, as test SSNs use them and ITINs start with 9.
 */
export const TinInput = z
  .object({ type: TinType, value: z.string().max(20) })
  .transform((t) => ({ type: t.type, value: digits(t.value) }))
  .refine((t) => /^\d{9}$/.test(t.value), { message: 'A tax ID has nine digits', path: ['value'] })
  .refine(
    (t) =>
      t.type === 'ein' ||
      (!t.value.startsWith('000') &&
        !t.value.startsWith('666') &&
        t.value.slice(3, 5) !== '00' &&
        t.value.slice(5) !== '0000'),
    { message: 'This is not a valid SSN or ITIN', path: ['value'] },
  );
export type TinInput = z.output<typeof TinInput>;

/** ABA routing number: nine digits with the 3-7-1 checksum. */
export const RoutingNumber = z
  .string()
  .max(20)
  .transform(digits)
  .refine((s) => {
    if (!/^\d{9}$/.test(s)) return false;
    const d = [...s].map(Number);
    const sum = 3 * (d[0]! + d[3]! + d[6]!) + 7 * (d[1]! + d[4]! + d[7]!) + (d[2]! + d[5]! + d[8]!);
    return sum % 10 === 0;
  }, 'This is not a valid routing number');

export const BankInput = z.object({
  routing: RoutingNumber,
  account: z
    .string()
    .max(30)
    .transform(digits)
    .refine((s) => /^\d{4,17}$/.test(s), 'An account number has 4 to 17 digits'),
  accountType: z.enum(['checking', 'savings']),
});
export type BankInput = z.output<typeof BankInput>;

export const PersonKind = z.enum(['employee', 'contractor']);
export type PersonKind = z.infer<typeof PersonKind>;
export const PayType = z.enum(['hourly', 'salary']);
export type PayType = z.infer<typeof PayType>;

export const AddressDto = z.object({
  line1: z.string().nullable(),
  line2: z.string().nullable(),
  city: z.string().nullable(),
  region: z.string().nullable(),
  postalCode: z.string().nullable(),
  country: z.string(),
});
export type AddressDto = z.infer<typeof AddressDto>;

const AddressInput = z.object({
  line1: OptionalText(200),
  line2: OptionalText(200),
  city: OptionalText(100),
  region: OptionalText(50),
  postalCode: OptionalText(20),
  country: z
    .string()
    .trim()
    .transform((s) => s.toUpperCase())
    .pipe(z.string().regex(/^[A-Z]{2}$/))
    .optional(),
});

/** Where an employee stands with their forms. Retention follows ADR-0034 §5. */
export const OnboardingDto = z.object({
  w4: z
    .object({ id: Id, effectiveDate: CalendarDateDto, filingStatus: z.string(), exempt: z.boolean() })
    .nullable(),
  w9: z.object({ id: Id, signedOn: CalendarDateDto }).nullable(),
  i9: z
    .object({
      id: Id,
      section1: z.boolean(),
      section2: z.boolean(),
      documents: z.number().int(),
      /** Section 2 is due by the third business day after the first day of work. */
      section2Due: CalendarDateDto.nullable(),
      /** Kept at least until this date; null while still employed with no end date in sight beyond 3 years. */
      retainUntil: CalendarDateDto.nullable(),
      mayDestroy: z.boolean(),
    })
    .nullable(),
});
export type OnboardingDto = z.infer<typeof OnboardingDto>;

export const PayrollPersonDto = z.object({
  id: Id,
  entityId: Id,
  kind: PersonKind,
  firstName: z.string(),
  middleName: z.string().nullable(),
  lastName: z.string(),
  /** "First Last", or the business name for a contractor that has one. */
  displayName: z.string(),
  businessName: z.string().nullable(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  address: AddressDto,
  tinType: TinType.nullable(),
  /** "•••-••-1234" for an SSN or ITIN, "••-•••1234" for an EIN. */
  tinMasked: z.string().nullable(),
  hasBirthDate: z.boolean(),
  hireDate: CalendarDateDto.nullable(),
  endDate: CalendarDateDto.nullable(),
  /** Worked out from the dates and today in the workspace's time zone. */
  status: z.enum(['active', 'starting', 'ended']),
  payType: PayType.nullable(),
  /** Per hour for hourly pay, per year for salary. */
  rate: MinorDto.nullable(),
  workState: z.string().nullable(),
  bank: z.object({ accountType: z.enum(['checking', 'savings']), last4: z.string() }).nullable(),
  vendorPartyId: Id.nullable(),
  notes: z.string().nullable(),
  payScheduleId: Id.nullable(),
  /** Thousandths of an hour an hourly employee usually works in a period. */
  defaultHoursMilli: z.string().nullable(),
  onboarding: OnboardingDto,
  version: z.number().int(),
});
export type PayrollPersonDto = z.infer<typeof PayrollPersonDto>;

const PersonFields = z.object({
  firstName: Text(100).min(1),
  middleName: OptionalText(100),
  lastName: Text(100).min(1),
  businessName: OptionalText(200),
  email: z.email().max(320).nullable().optional(),
  phone: OptionalText(50),
  address: AddressInput.optional(),
  /** null clears it. */
  tin: TinInput.nullable().optional(),
  birthDate: CalendarDateDto.nullable().optional(),
  hireDate: CalendarDateDto.nullable().optional(),
  endDate: CalendarDateDto.nullable().optional(),
  payType: PayType.nullable().optional(),
  rate: NonNegativeMinor.nullable().optional(),
  workState: StateCode.nullable().optional(),
  bank: BankInput.nullable().optional(),
  notes: OptionalText(2000),
  payScheduleId: Id.nullable().optional(),
  defaultHoursMilli: z
    .string()
    .regex(/^\d{1,9}$/)
    .nullable()
    .optional(),
});

export const CreatePersonRequest = PersonFields.extend({
  entityId: Id,
  kind: PersonKind,
  /** A contractor is paid through bills to a vendor: this one, or a new vendor made from their name. */
  vendorPartyId: Id.nullable().optional(),
});
export type CreatePersonRequest = z.output<typeof CreatePersonRequest>;

export const UpdatePersonRequest = PersonFields.partial().extend({
  vendorPartyId: Id.nullable().optional(),
  version: Version,
});
export type UpdatePersonRequest = z.output<typeof UpdatePersonRequest>;

/** Which full value to show. Each reveal needs a recent sign-in and is written to the audit log. */
export const RevealField = z.enum([
  'tin',
  'birthDate',
  'bankRouting',
  'bankAccount',
  'w4.tin',
  'w9.tin',
  'i9.ssn',
  'i9.birthDate',
  'i9.aNumber',
  'i9.i94Number',
  'i9.passportNumber',
  'i9.document',
]);
export type RevealField = z.infer<typeof RevealField>;

export const RevealRequest = z.object({
  field: RevealField,
  /** The form or document the field is on, for `w4.*`, `w9.*` and `i9.document`. */
  recordId: Id.optional(),
});
export type RevealRequest = z.output<typeof RevealRequest>;
export const RevealResponse = z.object({ value: z.string().nullable() });
export type RevealResponse = z.infer<typeof RevealResponse>;

// ----- W-4 (PRL-02) ----------------------------------------------------------------------------------------------

export const W4FilingStatus = z.enum(['single', 'married_jointly', 'head_of_household']);
export type W4FilingStatus = z.infer<typeof W4FilingStatus>;

export const W4Dto = z.object({
  id: Id,
  personId: Id,
  effectiveDate: CalendarDateDto,
  legalName: z.string(),
  address: z.string().nullable(),
  tinMasked: z.string().nullable(),
  filingStatus: W4FilingStatus,
  multipleJobs: z.boolean(),
  dependents: MinorDto,
  otherIncome: MinorDto,
  deductions: MinorDto,
  extraWithholding: MinorDto,
  exempt: z.boolean(),
  signedName: z.string(),
  signedOn: CalendarDateDto,
  /** The one pay runs use today. */
  current: z.boolean(),
});
export type W4Dto = z.infer<typeof W4Dto>;

/** A W-4 is recorded as signed and never edited: a new one supersedes it from its effective date. */
export const CreateW4Request = z.object({
  effectiveDate: CalendarDateDto,
  filingStatus: W4FilingStatus,
  multipleJobs: z.boolean().default(false),
  dependents: NonNegativeMinor.default('0'),
  otherIncome: NonNegativeMinor.default('0'),
  deductions: NonNegativeMinor.default('0'),
  extraWithholding: NonNegativeMinor.default('0'),
  exempt: z.boolean().default(false),
  signedName: Text(300).min(1),
  signedOn: CalendarDateDto,
  /** The person recording it confirms the employee signed this form (typed or on paper). */
  attested: z.literal(true),
});
export type CreateW4Request = z.output<typeof CreateW4Request>;

// ----- W-9 (PRL-03) ----------------------------------------------------------------------------------------------

export const W9TaxClassification = z.enum([
  'individual',
  'c_corporation',
  's_corporation',
  'partnership',
  'trust_estate',
  'llc_c',
  'llc_s',
  'llc_p',
  'other',
]);
export type W9TaxClassification = z.infer<typeof W9TaxClassification>;

export const W9Dto = z.object({
  id: Id,
  personId: Id,
  legalName: z.string(),
  businessName: z.string().nullable(),
  taxClassification: W9TaxClassification,
  otherClassification: z.string().nullable(),
  foreignPartners: z.boolean(),
  exemptPayeeCode: z.string().nullable(),
  fatcaCode: z.string().nullable(),
  address: z.string(),
  accountNumbers: z.string().nullable(),
  tinType: TinType,
  tinMasked: z.string(),
  backupWithholding: z.boolean(),
  signedName: z.string(),
  signedOn: CalendarDateDto,
  current: z.boolean(),
});
export type W9Dto = z.infer<typeof W9Dto>;

export const CreateW9Request = z.object({
  legalName: Text(300).min(1),
  businessName: OptionalText(300),
  taxClassification: W9TaxClassification,
  otherClassification: OptionalText(100),
  foreignPartners: z.boolean().default(false),
  exemptPayeeCode: OptionalText(4),
  fatcaCode: OptionalText(4),
  address: Text(1000).min(1),
  accountNumbers: OptionalText(200),
  tin: TinInput,
  backupWithholding: z.boolean().default(false),
  signedName: Text(300).min(1),
  signedOn: CalendarDateDto,
  attested: z.literal(true),
});
export type CreateW9Request = z.output<typeof CreateW9Request>;

// ----- I-9 (PRL-04) ----------------------------------------------------------------------------------------------

export const I9Citizenship = z.enum([
  'citizen',
  'noncitizen_national',
  'permanent_resident',
  'authorized_alien',
]);
export type I9Citizenship = z.infer<typeof I9Citizenship>;

export const I9DocumentDto = z.object({
  id: Id,
  list: z.enum(['A', 'B', 'C']),
  title: z.string(),
  issuingAuthority: z.string().nullable(),
  numberMasked: z.string().nullable(),
  expiresOn: CalendarDateDto.nullable(),
  files: z.array(z.object({ id: Id, fileName: z.string(), mime: z.string(), bytes: z.number().int() })),
});
export type I9DocumentDto = z.infer<typeof I9DocumentDto>;

export const I9Dto = z.object({
  id: Id,
  personId: Id,
  section1: z.object({
    lastName: z.string(),
    firstName: z.string(),
    middleInitial: z.string().nullable(),
    otherLastNames: z.string().nullable(),
    address: z.string().nullable(),
    apartment: z.string().nullable(),
    city: z.string().nullable(),
    state: z.string().nullable(),
    zip: z.string().nullable(),
    hasBirthDate: z.boolean(),
    ssnMasked: z.string().nullable(),
    email: z.string().nullable(),
    phone: z.string().nullable(),
    citizenship: I9Citizenship.nullable(),
    hasANumber: z.boolean(),
    workUntil: CalendarDateDto.nullable(),
    hasI94Number: z.boolean(),
    hasPassportNumber: z.boolean(),
    passportCountry: z.string().nullable(),
    signedName: z.string().nullable(),
    signedOn: CalendarDateDto.nullable(),
    preparerName: z.string().nullable(),
    preparerAddress: z.string().nullable(),
    preparerSignedOn: CalendarDateDto.nullable(),
  }),
  section2: z.object({
    firstDay: CalendarDateDto.nullable(),
    additionalInfo: z.string().nullable(),
    signedName: z.string().nullable(),
    title: z.string().nullable(),
    signedOn: CalendarDateDto.nullable(),
    businessName: z.string().nullable(),
    businessAddress: z.string().nullable(),
  }),
  documents: z.array(I9DocumentDto),
  status: OnboardingDto.shape.i9.unwrap(),
  version: z.number().int(),
});
export type I9Dto = z.infer<typeof I9Dto>;

const SecretInput = (max: number) => z.string().trim().max(max).nullable().optional();

/** Section 1: created on first save; saving again replaces what's given. Signing it needs the attestation. */
export const SaveI9Section1Request = z.object({
  lastName: Text(100).min(1),
  firstName: Text(100).min(1),
  middleInitial: Text(1).nullable().optional(),
  otherLastNames: OptionalText(200),
  address: OptionalText(200),
  apartment: OptionalText(20),
  city: OptionalText(100),
  state: StateCode.nullable().optional(),
  zip: OptionalText(10),
  birthDate: CalendarDateDto.nullable().optional(),
  ssn: z
    .string()
    .max(20)
    .transform(digits)
    .refine((s) => /^\d{9}$/.test(s), 'An SSN has nine digits')
    .nullable()
    .optional(),
  email: z.email().max(320).nullable().optional(),
  phone: OptionalText(50),
  citizenship: I9Citizenship,
  aNumber: SecretInput(20),
  workUntil: CalendarDateDto.nullable().optional(),
  i94Number: SecretInput(20),
  passportNumber: SecretInput(30),
  passportCountry: OptionalText(100),
  preparerName: OptionalText(300),
  preparerAddress: OptionalText(500),
  preparerSignedOn: CalendarDateDto.nullable().optional(),
  signedName: Text(300).min(1),
  signedOn: CalendarDateDto,
  /** The employee attests, under penalty of perjury, to the status chosen. */
  attested: z.literal(true),
  version: Version.optional(),
});
export type SaveI9Section1Request = z.output<typeof SaveI9Section1Request>;

export const SaveI9Section2Request = z.object({
  firstDay: CalendarDateDto,
  additionalInfo: OptionalText(1000),
  signedName: Text(300).min(1),
  title: Text(100).min(1),
  signedOn: CalendarDateDto,
  businessName: Text(300).min(1),
  businessAddress: Text(500).min(1),
  /** The employer examined the original documents, which appear genuine and relate to the employee. */
  examinedOriginals: z.literal(true),
  version: Version,
});
export type SaveI9Section2Request = z.output<typeof SaveI9Section2Request>;

export const AddI9DocumentRequest = z.object({
  list: z.enum(['A', 'B', 'C']),
  title: Text(200).min(1),
  issuingAuthority: OptionalText(200),
  number: SecretInput(40),
  expiresOn: CalendarDateDto.nullable().optional(),
  /** Copies uploaded through `POST /payroll/files`; sealed in storage. */
  fileIds: z.array(Id).max(4).default([]),
});
export type AddI9DocumentRequest = z.output<typeof AddI9DocumentRequest>;

export const PayrollFileDto = z.object({ fileId: Id, mediaType: z.string(), bytes: z.number().int() });
export type PayrollFileDto = z.infer<typeof PayrollFileDto>;

// ----- Stage 2: pay schedules, pay runs, payslips and reimbursements (PRL-06..11) -----------------------------------

export const PayFrequency = z.enum(['biweekly', 'semimonthly', 'monthly']);
export type PayFrequency = z.infer<typeof PayFrequency>;

export const PayScheduleDto = z.object({
  id: Id,
  entityId: Id,
  name: z.string(),
  frequency: PayFrequency,
  anchorDate: CalendarDateDto,
  payLagDays: z.number().int(),
  payFromAccountId: Id.nullable(),
  /** The next period without a pay run, and its payday. */
  nextPeriod: z.object({ start: CalendarDateDto, end: CalendarDateDto, payDate: CalendarDateDto }),
  people: z.number().int(),
  archived: z.boolean(),
  version: z.number().int(),
});
export type PayScheduleDto = z.infer<typeof PayScheduleDto>;

export const CreatePayScheduleRequest = z.object({
  entityId: Id,
  name: Text(100).min(1),
  frequency: PayFrequency,
  /** Every two weeks: the first day of any one period. Ignored for the others. */
  anchorDate: CalendarDateDto,
  payLagDays: z.number().int().min(0).max(31).default(0),
  payFromAccountId: Id.nullable().optional(),
});
export type CreatePayScheduleRequest = z.output<typeof CreatePayScheduleRequest>;

export const UpdatePayScheduleRequest = z.object({
  name: Text(100).min(1).optional(),
  payLagDays: z.number().int().min(0).max(31).optional(),
  payFromAccountId: Id.nullable().optional(),
  archived: z.boolean().optional(),
  version: Version,
});
export type UpdatePayScheduleRequest = z.output<typeof UpdatePayScheduleRequest>;

export const PaycheckLineKind = z.enum([
  'earning',
  'pre_tax_deduction',
  'employee_tax',
  'post_tax_deduction',
  'reimbursement',
  'employer_tax',
]);
export type PaycheckLineKind = z.infer<typeof PaycheckLineKind>;

export const PaycheckLineDto = z.object({
  id: Id,
  kind: PaycheckLineKind,
  code: z.string(),
  label: z.string(),
  /** Thousandths of an hour: 37.5 hours = "37500". */
  hoursMilli: z.string().nullable(),
  rate: MinorDto.nullable(),
  amount: MinorDto,
  taxable: MinorDto.nullable(),
  source: z.enum(['computed', 'manual']),
  reimbursementId: Id.nullable(),
});
export type PaycheckLineDto = z.infer<typeof PaycheckLineDto>;

const Totals = {
  gross: MinorDto,
  preTax: MinorDto,
  employeeTaxes: MinorDto,
  postTax: MinorDto,
  reimbursements: MinorDto,
  net: MinorDto,
  employerTaxes: MinorDto,
};

export const PaycheckDto = z.object({
  id: Id,
  payRunId: Id,
  personId: Id,
  personName: z.string(),
  payType: PayType.nullable(),
  ...Totals,
  lines: z.array(PaycheckLineDto),
  /** Calendar year to date through this paycheck: approved runs only, and this one. */
  ytd: z.object(Totals),
  transactionId: Id.nullable(),
  version: z.number().int(),
});
export type PaycheckDto = z.infer<typeof PaycheckDto>;

export const PayRunDto = z.object({
  id: Id,
  entityId: Id,
  scheduleId: Id.nullable(),
  scheduleName: z.string().nullable(),
  periodStart: CalendarDateDto,
  periodEnd: CalendarDateDto,
  payDate: CalendarDateDto,
  status: z.enum(['draft', 'approved']),
  payFromAccountId: Id.nullable(),
  /** Which tax engine filled in the taxes: `manual` means they were entered by hand (ADR-0034 §7). */
  engine: z.string(),
  notes: z.string().nullable(),
  approvedAt: z.string().nullable(),
  totals: z.object({ ...Totals, paychecks: z.number().int() }),
  /** Present on a single pay run, absent from lists. */
  paychecks: z.array(PaycheckDto).optional(),
  version: z.number().int(),
});
export type PayRunDto = z.infer<typeof PayRunDto>;

export const CreatePayRunRequest = z.object({
  entityId: Id,
  scheduleId: Id,
  /** Any day in the period to pay; the next unpaid period when left out. */
  periodDate: CalendarDateDto.optional(),
});
export type CreatePayRunRequest = z.output<typeof CreatePayRunRequest>;

export const UpdatePayRunRequest = z.object({
  payDate: CalendarDateDto.optional(),
  payFromAccountId: Id.nullable().optional(),
  notes: OptionalText(2000),
  version: Version,
});
export type UpdatePayRunRequest = z.output<typeof UpdatePayRunRequest>;

const HoursMilli = z.string().regex(/^\d{1,9}$/, 'Hours in thousandths');
const EditableLine = z.object({
  code: z.string().trim().min(1).max(40),
  label: Text(100).min(1),
  amount: NonNegativeMinor,
});

/**
 * What can be changed on a draft paycheck. Each list given replaces the manual lines of its kind. Regular pay is worked
 * out from `hoursMilli` (hourly) or the salary; taxes are entered by hand until a tax engine fills them in (stage 3).
 */
export const UpdatePaycheckRequest = z.object({
  hoursMilli: HoursMilli.nullable().optional(),
  overtimeHoursMilli: HoursMilli.nullable().optional(),
  earnings: z.array(EditableLine).max(20).optional(),
  preTaxDeductions: z.array(EditableLine).max(20).optional(),
  employeeTaxes: z.array(EditableLine).max(20).optional(),
  postTaxDeductions: z.array(EditableLine).max(20).optional(),
  employerTaxes: z.array(EditableLine).max(20).optional(),
  version: Version,
});
export type UpdatePaycheckRequest = z.output<typeof UpdatePaycheckRequest>;

export const ApprovePayRunRequest = z.object({
  version: Version,
  /** The person approving confirms the amounts; Montra moves no money. */
  confirmed: z.literal(true),
});
export type ApprovePayRunRequest = z.output<typeof ApprovePayRunRequest>;

export const ReimbursementStatus = z.enum(['submitted', 'approved', 'declined', 'paid']);
export type ReimbursementStatus = z.infer<typeof ReimbursementStatus>;

export const ReimbursementDto = z.object({
  id: Id,
  entityId: Id,
  personId: Id,
  personName: z.string(),
  personKind: PersonKind,
  spentOn: CalendarDateDto,
  description: z.string(),
  amount: MinorDto,
  currency: z.string(),
  expenseAccountId: Id,
  files: z.array(z.object({ id: Id, fileName: z.string(), mime: z.string() })),
  /** Paid is worked out: its pay run was approved, or its bill was paid. */
  status: ReimbursementStatus,
  payVia: z.enum(['pay_run', 'bill']).nullable(),
  declineReason: z.string().nullable(),
  payRunId: Id.nullable(),
  billId: Id.nullable(),
  version: z.number().int(),
});
export type ReimbursementDto = z.infer<typeof ReimbursementDto>;

export const CreateReimbursementRequest = z.object({
  entityId: Id,
  personId: Id,
  spentOn: CalendarDateDto,
  description: Text(500).min(1),
  amount: MinorDto.refine((s) => BigInt(s) > 0n, 'Amount must be more than zero'),
  expenseAccountId: Id,
  /** Receipt photos or PDFs uploaded through `POST /payroll/files?purpose=receipt`. */
  fileIds: z.array(Id).max(6).default([]),
});
export type CreateReimbursementRequest = z.output<typeof CreateReimbursementRequest>;

/** An employee is paid on the next pay run, untaxed; a contractor through a bill to their vendor record. */
export const DecideReimbursementRequest = z.discriminatedUnion('decision', [
  z.object({ decision: z.literal('approve'), version: Version }),
  z.object({ decision: z.literal('decline'), reason: OptionalText(500), version: Version }),
]);
export type DecideReimbursementRequest = z.output<typeof DecideReimbursementRequest>;
