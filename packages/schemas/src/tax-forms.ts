import { z } from 'zod';
import { normalizeEin, TAX_CHECK_STATUSES, TAX_FORM_KINDS, TaxFormBoxesJsonSchemas } from '@montra/domain';
import { Id } from './common.js';
import { MinorDto } from './budgets.js';

/**
 * Tax forms received (ADR-0052): W-2, 1099-INT, 1099-DIV and 1098, kept per tax year, matched to an employer or
 * account(s) and a household member, and checked against the books. Montra doesn't prepare returns or calculate tax.
 *
 * Who sees a form: the person it's for, owners and admins, and accountants while the owner's setting
 * (`WorkspaceDto.accountantSeesTaxForms`) is on.
 */
export const TaxFormKind = z.enum(TAX_FORM_KINDS);
export type TaxFormKind = z.infer<typeof TaxFormKind>;

/**
 * The boxes per kind, as stored and sent: money as strings of integer minor units, every box optional (blank on the
 * form), unknown boxes refused. Box names follow the form (`box1`, `box12`, `box1a`); state rows are `states`.
 * Defined once in `@montra/domain`, where `parseTaxFormBoxes` reads them as bigint.
 */
export const TaxFormW2BoxesDto = TaxFormBoxesJsonSchemas.w2;
export type TaxFormW2BoxesDto = z.infer<typeof TaxFormW2BoxesDto>;
export const TaxForm1099IntBoxesDto = TaxFormBoxesJsonSchemas['1099_int'];
export type TaxForm1099IntBoxesDto = z.infer<typeof TaxForm1099IntBoxesDto>;
export const TaxForm1099DivBoxesDto = TaxFormBoxesJsonSchemas['1099_div'];
export type TaxForm1099DivBoxesDto = z.infer<typeof TaxForm1099DivBoxesDto>;
export const TaxForm1098BoxesDto = TaxFormBoxesJsonSchemas['1098'];
export type TaxForm1098BoxesDto = z.infer<typeof TaxForm1098BoxesDto>;
export const TaxFormBoxesDto = {
  w2: TaxFormW2BoxesDto,
  '1099_int': TaxForm1099IntBoxesDto,
  '1099_div': TaxForm1099DivBoxesDto,
  '1098': TaxForm1098BoxesDto,
} as const;

/**
 * - `reading`: the file is being read (from PR 3).
 * - `review`: a person is needed (see `reason`).
 * - `confirmed`: the reading is confirmed, by a person or by matching the books on every check.
 * - `dismissed`: put aside. `superseded`: a corrected form replaced it.
 */
export const TAX_FORM_STATUSES = ['reading', 'review', 'confirmed', 'dismissed', 'superseded'] as const;
export const TaxFormStatus = z.enum(TAX_FORM_STATUSES);
export type TaxFormStatus = z.infer<typeof TaxFormStatus>;

/** Why a form is in Review. */
export const TAX_FORM_REASONS = [
  /** It couldn't be read: type the boxes in. */
  'unread',
  /** No employer or account is matched yet. */
  'no_match',
  /** The person it's for isn't known yet. */
  'no_person',
  /** The employer's member and the reading name different people. */
  'person_conflict',
  /** A box differs from the books. */
  'differs',
  /** It looks like a copy of a form already received. */
  'probable_copy',
] as const;
export const TaxFormReason = z.enum(TAX_FORM_REASONS);
export type TaxFormReason = z.infer<typeof TaxFormReason>;

export const TaxFormSource = z.enum(['upload', 'scan', 'typed']);
export type TaxFormSource = z.infer<typeof TaxFormSource>;

/** A tax year as forms carry it. */
export const TaxYearNumber = z.number().int().min(2000).max(2100);

const Last4 = z.string().regex(/^\d{4}$/, 'the last four digits');
/** An EIN as printed (`12-3456789`) or as nine digits; kept as nine digits. */
const EinInput = z.string().transform((s, ctx) => {
  const ein = normalizeEin(s);
  if (!ein) {
    ctx.addIssue({ code: 'custom', message: 'an EIN, as 12-3456789' });
    return z.NEVER;
  }
  return ein;
});

/** What a form is matched to: its employer (a W-2), or one of its accounts. */
export const TaxFormTargetDto = z.object({ employerId: Id.nullable(), accountId: Id.nullable() });
export type TaxFormTargetDto = z.infer<typeof TaxFormTargetDto>;

const TargetInput = z.union([z.strictObject({ employerId: Id }), z.strictObject({ accountId: Id })]);

/**
 * One check of a form against the books (§5), worked out each time it's shown. `kind`: a `check` box that differs
 * puts the form in Review; an `info` box is shown only. Amounts are minor units; `books` and `difference` are null
 * where the books hold no figure for the box.
 */
export const TaxFormCheckDto = z.object({
  /** The box as printed: `1`, `12D`, `1a`, `1+3+8`, `16 CA`. */
  box: z.string(),
  kind: z.enum(['check', 'info']),
  form: MinorDto.nullable(),
  books: MinorDto.nullable(),
  difference: MinorDto.nullable(),
  status: z.enum(TAX_CHECK_STATUSES),
  /** How the books' figure was worked out, in words. */
  rule: z.string(),
  /** The known explanation that made it match ("Interest credited on 31 December, posted on 2 January"), or what a
   * difference probably means ("a payslip seems to be missing"). */
  explanation: z.string().nullable(),
  /** The note of an accepted difference. */
  acceptedNote: z.string().nullable(),
  /** What was summed, for the drill-down (RPT-03). Empty for an accountant's payslip totals. */
  sources: z.object({
    payslipIds: z.array(Id),
    transactionIds: z.array(Id),
    loanPaymentIds: z.array(Id),
    /** Entries with no transaction behind them (a balance, or income recorded from the form). */
    journalEntryIds: z.array(Id),
  }),
});
export type TaxFormCheckDto = z.infer<typeof TaxFormCheckDto>;

/**
 * What a form comes to (§7.1), in words and colour on the screen: Matches the books · Differs by $412.50 · Difference
 * accepted · Not tracked in the books · Needs a match · Reading. The stored status comes first (a form being read, put
 * aside, replaced, or waiting for a match or a person); then what its checks add up to.
 */
export const TAX_FORM_RESULT_STATES = [
  'matches',
  'differs',
  'accepted',
  'not_tracked',
  'check_reading',
  'needs_match',
  'needs_person',
  'unread',
  'person_conflict',
  'probable_copy',
  'reading',
  'dismissed',
  'superseded',
] as const;
export const TaxFormResultState = z.enum(TAX_FORM_RESULT_STATES);
export type TaxFormResultState = z.infer<typeof TaxFormResultState>;

export const TaxFormResultDto = z.object({
  state: TaxFormResultState,
  /** For `differs`: the largest difference among the `check` boxes, form minus books. */
  difference: MinorDto.nullable(),
  /** Whether it's a Review item ("Tax forms to check"). */
  review: z.boolean(),
  /**
   * Income the form reports on a valued account that posted none (§5.6): what Record from the form would move from
   * investment gains to the income category, on 31 December. Null when it isn't offered.
   */
  recordable: z
    .object({
      amount: MinorDto,
      accountId: Id,
      accountName: z.string(),
      categoryName: z.string(),
    })
    .nullable(),
  /** The entry Record from the form made, while it stands. */
  recorded: z.object({ journalEntryId: Id, amount: MinorDto, date: z.string() }).nullable(),
});
export type TaxFormResultDto = z.infer<typeof TaxFormResultDto>;

/** A suggested employer or account for a form read from a file, with why it's offered. */
export const TaxFormCandidateDto = z.object({
  employerId: Id.nullable(),
  accountId: Id.nullable(),
  name: z.string(),
  /** In words: "Ends 4471 and earned interest in 2025". */
  reason: z.string(),
});
export type TaxFormCandidateDto = z.infer<typeof TaxFormCandidateDto>;

/** Why a file's form couldn't be read, so its boxes are typed in. */
export const TAX_FORM_READING_PROBLEMS = [
  /** AI is off, unavailable, over its budget or local (local readings aren't applied yet). */
  'ai_unavailable',
  /** The reading didn't come back usable. */
  'ai_failed',
  /** The file itself: corrupt, no text, too many pages, or a scan with no OCR on the server. */
  'unreadable',
  /** Read, but no W-2, 1099-INT, 1099-DIV or 1098 was found in it. */
  'no_form_found',
  /** Reading it failed and won't be retried. */
  'failed',
  /** Nothing has picked it up for a while: a worker may not be running. */
  'waiting',
] as const;
export const TaxFormReadingProblem = z.enum(TAX_FORM_READING_PROBLEMS);
export type TaxFormReadingProblem = z.infer<typeof TaxFormReadingProblem>;

/**
 * How a form from a file was read and matched (ADR-0052 §4, §6); null for a form typed in. The masked text never
 * comes back, only what was done with it.
 */
export const TaxFormReadingDto = z.object({
  /** The files' names, as uploaded. */
  fileNames: z.array(z.string()),
  /** The kind was found on the form; false when the person has to say which form it is. */
  kindKnown: z.boolean(),
  /** The boxes were read; false while it's being read, or when they're to be typed in. */
  boxesRead: z.boolean(),
  problem: TaxFormReadingProblem.nullable(),
  /** Boxes the reading gave that weren't valid for the kind, and were left out. */
  droppedBoxes: z.number().int(),
  /** Who confirmed the reading: a person, or the books agreeing on every check (§5.6). */
  confirmedBy: z.enum(['person', 'books']).nullable(),
  /** Matched automatically, and why in words; otherwise the best candidates to pick from. */
  match: z.object({
    automatic: z.boolean(),
    reason: z.string().nullable(),
    candidates: z.array(TaxFormCandidateDto),
  }),
  /** The form this one looks like a copy of (same kind, year, issuer, person and boxes). */
  copyOfId: Id.nullable(),
});
export type TaxFormReadingDto = z.infer<typeof TaxFormReadingDto>;

const TaxFormFields = {
  id: Id,
  /** The books it belongs to: from what it's matched to, the personal books until then. */
  entityId: Id,
  taxYear: z.number().int(),
  corrected: z.boolean(),
  /** The earlier form a corrected one replaces. */
  supersedesId: Id.nullable(),
  issuerName: z.string().nullable(),
  /** Nine digits, when the issuer's TIN is an EIN. */
  issuerEin: z.string().nullable(),
  /** An SSN-shaped payer TIN keeps only its last four digits. */
  issuerTinLast4: z.string().nullable(),
  /** The person's SSN, last four digits only. */
  personTinLast4: z.string().nullable(),
  accountLast4: z.string().nullable(),
  /** The household member it's for; null until known. */
  personMemberId: Id.nullable(),
  targets: z.array(TaxFormTargetDto),
  fileIds: z.array(Id),
  pages: z.array(z.number().int()).nullable(),
  status: TaxFormStatus,
  reason: TaxFormReason.nullable(),
  source: TaxFormSource,
  createdBy: Id.nullable(),
  confirmedBy: Id.nullable(),
  confirmedAt: z.string().nullable(),
  /** In the Trash since then (30 days); null otherwise. */
  deletedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  version: z.number().int(),
  /** What its checks against the books come to, worked out on read (§5). */
  result: TaxFormResultDto,
  /** One per box (§5); empty until it's matched. */
  checks: z.array(TaxFormCheckDto),
  /** How it was read and matched, for a form from a file; null for one typed in. */
  reading: TaxFormReadingDto.nullable(),
};

/** One form received, with the boxes of its kind. */
export const TaxFormDto = z.discriminatedUnion('kind', [
  z.object({ ...TaxFormFields, kind: z.literal('w2'), boxes: TaxFormW2BoxesDto }),
  z.object({ ...TaxFormFields, kind: z.literal('1099_int'), boxes: TaxForm1099IntBoxesDto }),
  z.object({ ...TaxFormFields, kind: z.literal('1099_div'), boxes: TaxForm1099DivBoxesDto }),
  z.object({ ...TaxFormFields, kind: z.literal('1098'), boxes: TaxForm1098BoxesDto }),
]);
export type TaxFormDto = z.infer<typeof TaxFormDto>;

/** Why an expected form won't come. */
export const TaxFormWaiverReason = z.enum(['not_issued', 'combined', 'other']);
export type TaxFormWaiverReason = z.infer<typeof TaxFormWaiverReason>;

/** An expected form the person says won't come or is covered elsewhere (§7.1). */
export const TaxFormWaiverDto = z.object({
  id: Id,
  entityId: Id,
  taxYear: z.number().int(),
  kind: TaxFormKind,
  employerId: Id.nullable(),
  accountId: Id.nullable(),
  personMemberId: Id.nullable(),
  reason: TaxFormWaiverReason,
  note: z.string().nullable(),
  createdBy: Id.nullable(),
  createdAt: z.string(),
});
export type TaxFormWaiverDto = z.infer<typeof TaxFormWaiverDto>;

/** A form the year should bring (§7.1), inferred from payslips, interest, dividends and mortgages; never stored. */
export const TaxFormExpectedDto = z.object({
  kind: TaxFormKind,
  employerId: Id.nullable(),
  accountId: Id.nullable(),
  personMemberId: Id.nullable(),
  entityId: Id,
  /** The employer's or the account's name. */
  name: z.string(),
  /** The books' figure that makes it expected: pay, interest, dividends or mortgage interest in the year. */
  amount: MinorDto,
  /** Received (a form of its kind matched to it), Won't come (a waiver), or Not yet. */
  state: z.enum(['received', 'waived', 'missing']),
  formId: Id.nullable(),
  waiverId: Id.nullable(),
});
export type TaxFormExpectedDto = z.infer<typeof TaxFormExpectedDto>;

/**
 * A year's tax forms (`GET tax-forms?year=`): those received, with their results; those expected, each received,
 * waived or missing; and the waivers. Expected forms are listed only for the employers and accounts the reader can see.
 */
export const TaxYearDto = z.object({
  year: z.number().int(),
  forms: z.array(TaxFormDto),
  expected: z.array(TaxFormExpectedDto),
  /** Received forms that match nothing expected ("Received, not expected"). */
  unexpectedFormIds: z.array(Id),
  waivers: z.array(TaxFormWaiverDto),
});
export type TaxYearDto = z.infer<typeof TaxYearDto>;

export const ListTaxFormsQuery = z.object({ year: z.coerce.number().int().min(2000).max(2100) });
export type ListTaxFormsQuery = z.output<typeof ListTaxFormsQuery>;

// ----- Typing a form in, and changing one ------------------------------------------------------------------------------

const IdentificationInput = {
  corrected: z.boolean().optional(),
  supersedesId: Id.nullable().optional(),
  issuerName: z.string().trim().min(1).max(200).nullable().optional(),
  issuerEin: EinInput.nullable().optional(),
  issuerTinLast4: Last4.nullable().optional(),
  personTinLast4: Last4.nullable().optional(),
  accountLast4: Last4.nullable().optional(),
  /** Who it's for. A W-2 matched to an employer is for the employer's member when this is left out. */
  personMemberId: Id.nullable().optional(),
  /** A W-2 has one employer; a 1099 or 1098 one or more accounts. */
  targets: z.array(TargetInput).max(10).optional(),
};

/** `POST tax-forms`: a form typed in, with no file (TAX-01). */
export const CreateTaxFormRequest = z.discriminatedUnion('kind', [
  z.strictObject({
    ...IdentificationInput,
    taxYear: TaxYearNumber,
    kind: z.literal('w2'),
    boxes: TaxFormW2BoxesDto,
  }),
  z.strictObject({
    ...IdentificationInput,
    taxYear: TaxYearNumber,
    kind: z.literal('1099_int'),
    boxes: TaxForm1099IntBoxesDto,
  }),
  z.strictObject({
    ...IdentificationInput,
    taxYear: TaxYearNumber,
    kind: z.literal('1099_div'),
    boxes: TaxForm1099DivBoxesDto,
  }),
  z.strictObject({
    ...IdentificationInput,
    taxYear: TaxYearNumber,
    kind: z.literal('1098'),
    boxes: TaxForm1098BoxesDto,
  }),
]);
export type CreateTaxFormRequest = z.output<typeof CreateTaxFormRequest>;

/**
 * `PATCH tax-forms/:id`: change what a form says or what it's matched to. The boxes are checked against the kind, and
 * replace the old ones whole. The kind changes only on a form from a file whose reading isn't confirmed (it was misread,
 * or couldn't be read), and then with its boxes. `version` is the one read, so two edits can't overwrite each other.
 */
export const UpdateTaxFormRequest = z.strictObject({
  ...IdentificationInput,
  kind: TaxFormKind.optional(),
  taxYear: TaxYearNumber.optional(),
  boxes: z.record(z.string(), z.unknown()).optional(),
  /** Put aside, or back in Review. */
  dismissed: z.boolean().optional(),
  version: z.number().int(),
});
export type UpdateTaxFormRequest = z.output<typeof UpdateTaxFormRequest>;

/** `POST tax-forms/waivers`: an expected form that won't come. A W-2's waiver names its employer; the others an account. */
export const CreateTaxFormWaiverRequest = z
  .strictObject({
    taxYear: TaxYearNumber,
    kind: TaxFormKind,
    employerId: Id.optional(),
    accountId: Id.optional(),
    /** Who it's for, for an account's form; a W-2's is the employer's member. */
    personMemberId: Id.nullable().optional(),
    reason: TaxFormWaiverReason,
    note: z.string().trim().max(500).nullable().optional(),
  })
  .refine((r) => (r.employerId === undefined) !== (r.accountId === undefined), {
    message: 'Name an employer or an account',
    path: ['employerId'],
  })
  .refine((r) => (r.kind === 'w2') === (r.employerId !== undefined), {
    message: 'A W-2 comes from an employer; the other forms from an account',
    path: ['kind'],
  });
export type CreateTaxFormWaiverRequest = z.output<typeof CreateTaxFormWaiverRequest>;

/** `GET tax-forms/review`: Review's "Tax forms to check" (§7.1), every year, oldest year first. */
export const TaxFormReviewDto = z.object({ data: z.array(TaxFormDto) });
export type TaxFormReviewDto = z.infer<typeof TaxFormReviewDto>;

/** `POST tax-forms/:id/accept`: accept a box's difference with a note (§5.6). It holds while the difference stays. */
export const AcceptTaxFormDifferenceRequest = z.strictObject({
  box: z.string().min(1).max(40),
  note: z.string().trim().min(1).max(500),
});
export type AcceptTaxFormDifferenceRequest = z.output<typeof AcceptTaxFormDifferenceRequest>;

/**
 * `POST tax-forms/:id/record`: Record from the form (§5.6). `amount` is the one the person confirmed, so a form changed
 * meanwhile is refused rather than recorded at another figure.
 */
export const RecordFromTaxFormRequest = z.strictObject({ amount: MinorDto });
export type RecordFromTaxFormRequest = z.output<typeof RecordFromTaxFormRequest>;

/** `POST tax-forms/:id/confirm`: Confirm reading (§5.6): a person checked the boxes against the file. */
export const ConfirmTaxFormReadingRequest = z.strictObject({ version: z.number().int() });
export type ConfirmTaxFormReadingRequest = z.output<typeof ConfirmTaxFormReadingRequest>;

/** `POST tax-forms/files` (multipart: files, and the fields `year` and `source`): several files at once (TAX-01). */
export const UploadTaxFormFieldsDto = z.object({
  /** The year on screen, for a form that prints none. */
  year: z.coerce.number().int().min(2000).max(2100).optional(),
  /** `scan` from the phone's scanner; `upload` otherwise. */
  source: z.enum(['upload', 'scan']).optional(),
});
export type UploadTaxFormFieldsDto = z.output<typeof UploadTaxFormFieldsDto>;

/**
 * What became of each file: being read (a form in `reading`, which the reading may split into several), or refused as
 * a file already received, with the form made from it.
 */
export const TaxFormUploadDto = z.object({
  files: z.array(
    z.object({
      fileName: z.string(),
      status: z.enum(['reading', 'duplicate']),
      formId: Id,
    }),
  ),
});
export type TaxFormUploadDto = z.infer<typeof TaxFormUploadDto>;

/** `PUT workspaces/:id/accountant-tax-forms`: the owner's setting (ADR-0052 §8.4). Owner only, after a recent sign-in. */
export const AccountantTaxFormsDto = z.strictObject({ accountantSeesTaxForms: z.boolean() });
export type AccountantTaxFormsDto = z.infer<typeof AccountantTaxFormsDto>;
