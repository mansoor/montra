/**
 * Tax forms received (ADR-0052): typing a form in, listing a year's forms with those expected, changing and matching a
 * form by hand, deleting to the Trash, waivers for expected forms that won't come, and each form's checks against the
 * books (§5), worked out on read. Row-level security decides who sees and writes a form (§8.4): the person it's for,
 * owners and admins, and accountants while the owner's setting is on. Reading files and matching them automatically
 * come with PR 3.
 */
import { Inject, Injectable } from '@nestjs/common';
import {
  newId,
  type MemberRole,
  type TaxFormRow,
  type TaxFormTargetRow,
  type TaxFormWaiverRow,
  type Trx,
} from '@montra/db';
import { sql } from 'kysely';
import {
  accountProfile,
  asCurrencyCode,
  checksOutcome,
  expectedAgainstReceived,
  expectedTaxForms,
  normalizeTaxFormBoxes,
  parseTaxFormBoxes,
  reconcile1098,
  reconcile1099Div,
  reconcile1099Int,
  reconcileW2,
  TaxFormBoxesError,
  validateEntry,
  type CalendarDate,
  type JournalEntryDraft,
  type TaxFormAcceptances,
  type TaxFormCheck,
  type TaxFormKind,
} from '@montra/domain';
import { taxIssuerSignal } from '@montra/importers';
import type {
  AcceptTaxFormDifferenceRequest,
  ConfirmTaxFormReadingRequest,
  CreateTaxFormRequest,
  CreateTaxFormWaiverRequest,
  RecordFromTaxFormRequest,
  TaxFormCandidateDto,
  TaxFormCheckDto,
  TaxFormDto,
  TaxFormReadingProblem,
  TaxFormReason,
  TaxFormResultDto,
  TaxFormResultState,
  TaxFormStatus,
  TaxFormWaiverDto,
  TaxYearDto,
  UpdateTaxFormRequest,
} from '@montra/schemas';
import { Db } from '../db/database.js';
import { AppError, forbidden, notFound, unprocessable } from '../common/errors.js';
import { FieldCrypto } from '../crypto/crypto.service.js';
import { incomeCategory } from '../accounts/income-categories.js';
import { confirmMatch } from '../intakes/match-memory.js';
import { JOB_STALL_MS } from '../jobs/queue.js';
import { LedgerService } from '../ledger/ledger.service.js';
import { accountIncomeBooks, expectedInputs, mortgageBooks, w2Books } from './tax-form-books.js';

type Ctx = { workspaceId: string; userId: string };
/** A caller with their role, for the rules that depend on it. */
type Actor = Ctx & { role?: MemberRole | undefined };

/** Everyone but viewers handles tax forms; row-level security narrows it to the forms each can read (§8.4). */
export const TAX_FORM_WRITERS = ['owner', 'admin', 'partner', 'member', 'accountant'] as const;

/**
 * Who may match a W-2 to an employer by hand (ADR-0052 PR 2; an owner's question). Owners, admins and the form's own
 * person: row-level security on employers (PAY-09) narrows partners and members to their own. Accountants may not, even
 * with the owner's setting on: employers are restricted, and the setting is about forms, not payslips. An accountant
 * still reads the W-2's reconciliation through `app.tax_form_payslip_totals`. To let accountants match, add
 * `'accountant'` here; they would then also need to look the employer up, which their row-level security hides today.
 */
export const W2_EMPLOYER_MATCHERS: readonly MemberRole[] = ['owner', 'admin', 'partner', 'member'];

type Target = { employerId: string } | { accountId: string };

/** What `accepted` (jsonb) holds: accepted differences per box, and the entry Record from the form made (§5.6). */
interface StoredAccepted {
  boxes?: Record<string, { form: string; books: string; note: string; by: string; at: string }>;
  recorded?: {
    journalEntryId: string;
    amount: string;
    date: string;
    accountId: string;
    by: string;
    at: string;
  };
}

/**
 * What `detected` (jsonb) holds for a form read from a file (ADR-0052 PR 3): how it was read and matched. It becomes
 * the DTO's `reading`, plus the issuer's signal, kept to forget the memory when an automatic match is changed.
 */
export interface StoredReadingInfo {
  fileNames: string[];
  kindKnown: boolean;
  boxesRead: boolean;
  problem: TaxFormReadingProblem | null;
  droppedBoxes: number;
  confirmedBy: 'person' | 'books' | null;
  match: { automatic: boolean; reason: string | null; candidates: TaxFormCandidateDto[] };
  copyOfId: string | null;
  signal: string | null;
}

/** A form's checks and what they come to. */
interface Evaluation {
  checks: TaxFormCheck[];
  result: TaxFormResultDto;
  /** For a form still being read: its job failed, or waits with nothing picking it up. */
  jobProblem: 'failed' | 'waiting' | null;
}

/** The stored statuses that aren't a Review item whatever the books say. */
const SET_ASIDE: TaxFormStatus[] = ['dismissed', 'superseded'];

/** The reasons a person clears: a probable copy by confirming the reading, a conflict by picking the person. */
const HELD_REASONS: readonly string[] = ['probable_copy', 'person_conflict'];

const conflict = () =>
  new AppError(409, 'version.conflict', 'Someone else changed this form; reload and try again');

@Injectable()
export class TaxFormsService {
  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(LedgerService) private readonly ledger: LedgerService,
    @Inject(FieldCrypto) private readonly crypto: FieldCrypto,
  ) {}

  /**
   * A year's forms (not those in the Trash) with their checks, the forms the year should bring (§7.1) and its waivers.
   * Expected forms come only from the employers and accounts the reader can see.
   */
  async year(ctx: Ctx, year: number): Promise<TaxYearDto> {
    return this.db.run(ctx, async (trx) => {
      const forms = await trx
        .selectFrom('app.tax_form')
        .selectAll()
        .where('workspace_id', '=', ctx.workspaceId)
        .where('tax_year', '=', year)
        .where('deleted_at', 'is', null)
        .orderBy('kind')
        .orderBy('issuer_name')
        .orderBy('created_at')
        .execute();
      const targets = await this.targetsOf(
        trx,
        ctx,
        forms.map((f) => f.id),
      );
      const waivers = await trx
        .selectFrom('app.tax_form_waiver')
        .selectAll()
        .where('workspace_id', '=', ctx.workspaceId)
        .where('tax_year', '=', year)
        .orderBy('kind')
        .orderBy('created_at')
        .execute();
      const dtos: TaxFormDto[] = [];
      for (const f of forms) {
        const t = targets.get(f.id) ?? [];
        dtos.push(toDto(f, t, await this.evaluate(trx, ctx, f, t)));
      }
      const inputs = await expectedInputs(trx, ctx, year);
      const matched = expectedAgainstReceived(
        expectedTaxForms(year, inputs.employers, inputs.accounts),
        forms.map((f) => ({
          id: f.id,
          kind: f.kind,
          status: f.status,
          targets: (targets.get(f.id) ?? []).map((t) => ({
            employerId: t.employer_id,
            accountId: t.account_id,
          })),
        })),
        waivers.map((w) => ({ id: w.id, kind: w.kind, employerId: w.employer_id, accountId: w.account_id })),
      );
      return {
        year,
        forms: dtos,
        expected: matched.expected.map((e) => ({ ...e, amount: String(e.amount) })),
        unexpectedFormIds: matched.unexpectedFormIds,
        waivers: waivers.map(waiverDto),
      };
    });
  }

  /**
   * Review's "Tax forms to check" (§7.1): forms that differ (and aren't accepted), aren't matched, have no person or
   * couldn't be read, every year, oldest first.
   */
  async review(ctx: Ctx): Promise<TaxFormDto[]> {
    return this.db.run(ctx, async (trx) => {
      const forms = await trx
        .selectFrom('app.tax_form')
        .selectAll()
        .where('workspace_id', '=', ctx.workspaceId)
        .where('deleted_at', 'is', null)
        .where('status', 'not in', SET_ASIDE)
        .orderBy('tax_year')
        .orderBy('kind')
        .orderBy('issuer_name')
        .orderBy('created_at')
        .execute();
      const targets = await this.targetsOf(
        trx,
        ctx,
        forms.map((f) => f.id),
      );
      const out: TaxFormDto[] = [];
      for (const f of forms) {
        const t = targets.get(f.id) ?? [];
        const evaluation = await this.evaluate(trx, ctx, f, t);
        if (evaluation.result.review) out.push(toDto(f, t, evaluation));
      }
      return out;
    });
  }

  /**
   * Accepts a box's difference with a note (§5.6). It holds while the form and the books say the same; if either
   * changes, the form is back in Review.
   */
  async accept(ctx: Ctx, id: string, req: AcceptTaxFormDifferenceRequest): Promise<TaxFormDto> {
    return this.db.run(ctx, async (trx) => {
      const form = await this.live(trx, ctx, id);
      const targets = (await this.targetsOf(trx, ctx, [id])).get(id) ?? [];
      const { checks } = await this.evaluate(trx, ctx, form, targets);
      const check = checks.find((c) => c.box === req.box);
      if (!check || check.kind !== 'check' || !['differs', 'check_reading'].includes(check.status)) {
        throw unprocessable('tax_form.nothing_to_accept', 'That box doesn’t differ from the books');
      }
      const stored = storedAccepted(form);
      const boxes = {
        ...stored.boxes,
        [req.box]: {
          form: String(check.form ?? 0n),
          books: String(check.books ?? 0n),
          note: req.note,
          by: ctx.userId,
          at: new Date().toISOString(),
        },
      };
      await this.writeAccepted(trx, ctx, form, { ...stored, boxes });
      return this.read(trx, ctx, id);
    });
  }

  /**
   * Record from the form (§5.6): income the form reports on a valued account that posted none is moved from investment
   * gains to the income category, in one entry on 31 December. The account's balance doesn't change: the entry adds
   * the income to the account and takes the same amount out of its gains. `amount` is what the person confirmed.
   */
  async record(ctx: Ctx, id: string, req: RecordFromTaxFormRequest): Promise<TaxFormDto> {
    return this.db.run(ctx, async (trx) => {
      const form = await this.live(trx, ctx, id);
      const stored = storedAccepted(form);
      if (stored.recorded) throw unprocessable('tax_form.recorded', 'This form’s income is recorded already');
      const targets = (await this.targetsOf(trx, ctx, [id])).get(id) ?? [];
      const { result } = await this.evaluate(trx, ctx, form, targets);
      const offer = result.recordable;
      if (!offer) throw unprocessable('tax_form.not_recordable', 'There’s nothing to record from this form');
      if (offer.amount !== req.amount) {
        throw unprocessable('tax_form.amount_changed', 'The form changed: check the amount and try again');
      }
      const amount = BigInt(offer.amount);
      const account = await this.ledger.accountRef(trx, ctx.workspaceId, offer.accountId);
      const category = await this.incomeCategoryOf(trx, ctx, account.entityId, form.kind as IncomeKindForm);
      if (!category) throw unprocessable('tax_form.category', 'Add an income category for it first');
      const resolver = await this.ledger.resolver(trx, ctx.workspaceId);
      const entity = resolver.entity(account.entityId);
      if (account.currency !== entity.functionalCurrency) {
        throw unprocessable(
          'tax_form.currency',
          'Income is recorded only on accounts in the currency of their books',
        );
      }
      const gains = resolver.systemAccount(account.entityId, 'investment_gains');
      const date = `${form.tax_year}-12-31` as CalendarDate;
      const line = (lineNo: number, accountId: string, currency: string, value: bigint) => ({
        lineNo,
        accountId,
        accountEntityId: account.entityId,
        currency: asCurrencyCode(currency),
        amount: value,
        functionalAmount: value,
        fxRate: null,
      });
      const draft: JournalEntryDraft = {
        entityId: account.entityId,
        functionalCurrency: entity.functionalCurrency,
        entryDate: date,
        kind: 'adjustment',
        description: `${form.kind === '1099_div' ? 'Dividends' : 'Interest'} from the ${formName(form.kind)}${
          form.issuer_name ? ` (${form.issuer_name})` : ''
        }, recorded from the form`,
        postings: [
          line(1, account.id, account.currency, amount),
          line(2, category.id, account.currency, -amount),
          line(3, account.id, account.currency, -amount),
          line(4, gains.id, gains.currency, amount),
        ],
      };
      validateEntry(draft);
      const [entryId] = await this.ledger.post(trx, ctx, null, [draft]);
      await this.writeAccepted(trx, ctx, form, {
        ...stored,
        recorded: {
          journalEntryId: entryId!,
          amount: String(amount),
          date,
          accountId: account.id,
          by: ctx.userId,
          at: new Date().toISOString(),
        },
      });
      return this.read(trx, ctx, id);
    });
  }

  /** Takes back what Record from the form made: its entry is reversed on the same date. */
  async unrecord(ctx: Ctx, id: string): Promise<TaxFormDto> {
    return this.db.run(ctx, async (trx) => {
      const form = await this.live(trx, ctx, id);
      const stored = storedAccepted(form);
      if (!stored.recorded)
        throw unprocessable('tax_form.not_recorded', 'Nothing was recorded from this form');
      const entry = await trx
        .selectFrom('app.journal_entry')
        .select(['id', 'entity_id', 'entry_date', 'description'])
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', stored.recorded.journalEntryId)
        .executeTakeFirst();
      if (entry) {
        const postings = await trx
          .selectFrom('app.posting')
          .select(['line_no', 'ledger_account_id', 'currency', 'amount_minor', 'functional_amount_minor'])
          .where('workspace_id', '=', ctx.workspaceId)
          .where('journal_entry_id', '=', entry.id)
          .orderBy('line_no')
          .execute();
        const resolver = await this.ledger.resolver(trx, ctx.workspaceId);
        const draft: JournalEntryDraft = {
          entityId: entry.entity_id,
          functionalCurrency: resolver.entity(entry.entity_id).functionalCurrency,
          entryDate: String(entry.entry_date).slice(0, 10) as CalendarDate,
          kind: 'reversal',
          description: `Taken back: ${entry.description}`,
          postings: postings.map((p) => ({
            lineNo: p.line_no,
            accountId: p.ledger_account_id,
            accountEntityId: entry.entity_id,
            currency: asCurrencyCode(p.currency),
            amount: -BigInt(p.amount_minor),
            functionalAmount: -BigInt(p.functional_amount_minor),
            fxRate: null,
          })),
        };
        validateEntry(draft);
        await this.ledger.post(trx, ctx, null, [draft]);
      }
      const rest: StoredAccepted = { ...stored };
      delete rest.recorded;
      await this.writeAccepted(trx, ctx, form, rest);
      return this.read(trx, ctx, id);
    });
  }

  async get(ctx: Ctx, id: string): Promise<TaxFormDto> {
    return this.db.run(ctx, (trx) => this.read(trx, ctx, id));
  }

  /** A form typed in, with no file (TAX-01). A match given with it is a match by hand, and teaches the memory. */
  async create(ctx: Actor, req: CreateTaxFormRequest): Promise<TaxFormDto> {
    return this.db.run(ctx, async (trx) => {
      const boxes = checkedBoxes(req.kind, req.boxes);
      checkMatcher(ctx, req.kind, req.targets ?? []);
      const placed = await this.place(trx, ctx, req.kind, req.targets ?? [], req.personMemberId);
      checkIssuerTin(req.issuerEin ?? null, req.issuerTinLast4 ?? null);
      const supersedesId = req.supersedesId ?? null;
      if (supersedesId) await this.checkSupersedes(trx, ctx, supersedesId, req.kind, null);
      const id = newId();
      const { status, reason } = typedStatus(placed.targets.length > 0, placed.personMemberId !== null);
      await trx
        .insertInto('app.tax_form')
        .values({
          workspace_id: ctx.workspaceId,
          id,
          entity_id: placed.entityId,
          tax_year: req.taxYear,
          kind: req.kind,
          corrected: req.corrected ?? false,
          supersedes_id: supersedesId,
          issuer_name: req.issuerName ?? null,
          issuer_ein: req.issuerEin ?? null,
          issuer_tin_last4: req.issuerTinLast4 ?? null,
          person_tin_last4: req.personTinLast4 ?? null,
          account_last4: req.accountLast4 ?? null,
          person_member_id: placed.personMemberId,
          boxes: JSON.stringify(boxes),
          status,
          reason,
          source: 'typed',
          created_by: ctx.userId,
          // Typed in by a person: the reading is theirs.
          confirmed_by: status === 'confirmed' ? ctx.userId : null,
          confirmed_at: status === 'confirmed' ? new Date() : null,
        })
        .execute();
      await this.writeTargets(trx, ctx, id, placed.targets);
      if (supersedesId) await this.supersede(trx, ctx, supersedesId);
      await this.learn(trx, ctx, {
        kind: req.kind,
        ein: req.issuerEin ?? null,
        accountLast4: req.accountLast4 ?? null,
        issuerName: req.issuerName ?? null,
        personTinLast4: req.personTinLast4 ?? null,
        targets: req.targets !== undefined ? placed.targets : null,
        person: req.personMemberId !== undefined || req.targets !== undefined ? placed.personMemberId : null,
      });
      return this.read(trx, ctx, id);
    });
  }

  /**
   * Changes what a form says or what it's matched to. The boxes replace the old ones whole. Picking or changing the
   * match, or the person, is a match by hand: it confirms the match memory (`learnMatch`, ADR-0051 §3), and a change is
   * a correction that starts it again. A form from a file whose reading isn't confirmed can change its kind (it was
   * misread, or couldn't be read); its status then follows from what it says now (`settleRead`).
   */
  async update(ctx: Actor, id: string, req: UpdateTaxFormRequest): Promise<TaxFormDto> {
    return this.db.run(ctx, async (trx) => {
      const form = await this.row(trx, ctx, id);
      if (form.deleted_at) throw notFound('Tax form');
      if (BigInt(form.version) !== BigInt(req.version)) throw conflict();
      // Still being read: the reading would overwrite the change. Unless the reading failed or nothing picks it up.
      if (form.status === 'reading' && !(await this.jobProblem(trx, ctx, form))) {
        throw new AppError(409, 'tax_form.reading', 'This form is still being read; try again in a moment');
      }
      const typed = form.source === 'typed';
      let kind = form.kind;
      if (req.kind !== undefined && req.kind !== form.kind) {
        if (typed || form.status === 'confirmed') {
          throw unprocessable(
            'tax_form.kind',
            'Only a form read from a file and not confirmed changes its kind',
          );
        }
        kind = req.kind;
      }
      const kindChanged = kind !== form.kind;
      if (req.targets !== undefined) checkMatcher(ctx, kind, req.targets);
      const boxes = req.boxes !== undefined ? checkedBoxes(kind, req.boxes) : kindChanged ? {} : undefined;
      const current = await this.targetsOf(trx, ctx, [id]);
      const targets: Target[] =
        req.targets ??
        (kindChanged
          ? []
          : (current.get(id) ?? []).map((t) =>
              t.employer_id ? { employerId: t.employer_id } : { accountId: t.account_id! },
            ));
      const person = req.personMemberId !== undefined ? req.personMemberId : form.person_member_id;
      const placed = await this.place(trx, ctx, kind, targets, person);
      const issuerEin = req.issuerEin !== undefined ? req.issuerEin : form.issuer_ein;
      const issuerTinLast4 = req.issuerTinLast4 !== undefined ? req.issuerTinLast4 : form.issuer_tin_last4;
      checkIssuerTin(issuerEin, issuerTinLast4);
      const supersedesId = req.supersedesId !== undefined ? req.supersedesId : form.supersedes_id;
      if (supersedesId && supersedesId !== form.supersedes_id)
        await this.checkSupersedes(trx, ctx, supersedesId, kind, id);

      let status: TaxFormStatus = form.status;
      let reason: string | null = form.reason;
      if (req.dismissed === true) {
        status = 'dismissed';
      } else if (typed) {
        // Typed forms are confirmed once they're matched and have a person.
        if (form.status !== 'superseded')
          ({ status, reason } = typedStatus(placed.targets.length > 0, placed.personMemberId !== null));
      } else if (form.status === 'dismissed' || form.status === 'reading') {
        // Back in Review (or out of a reading that failed): what it says now decides its reason.
        status = 'review';
        reason = null;
      } else if (
        reason === 'person_conflict' &&
        (req.personMemberId !== undefined || req.targets !== undefined)
      ) {
        reason = null;
      }
      const info = readingInfo(form);
      const nextInfo: StoredReadingInfo | null = info
        ? {
            ...info,
            kindKnown: info.kindKnown || req.kind !== undefined,
            // Picked by a person now: no longer the automatic match.
            match: req.targets !== undefined ? { ...info.match, automatic: false, reason: null } : info.match,
          }
        : null;
      const confirmedNow = status === 'confirmed' && form.status !== 'confirmed';
      const updated = await trx
        .updateTable('app.tax_form')
        .set({
          entity_id: placed.entityId,
          kind,
          tax_year: req.taxYear ?? form.tax_year,
          corrected: req.corrected ?? form.corrected,
          supersedes_id: supersedesId,
          issuer_name: req.issuerName !== undefined ? req.issuerName : form.issuer_name,
          issuer_ein: issuerEin,
          issuer_tin_last4: issuerTinLast4,
          person_tin_last4: req.personTinLast4 !== undefined ? req.personTinLast4 : form.person_tin_last4,
          account_last4: req.accountLast4 !== undefined ? req.accountLast4 : form.account_last4,
          person_member_id: placed.personMemberId,
          ...(boxes !== undefined ? { boxes: JSON.stringify(boxes) } : {}),
          ...(nextInfo ? { detected: JSON.stringify(nextInfo) } : {}),
          status,
          reason,
          ...(confirmedNow ? { confirmed_by: ctx.userId, confirmed_at: new Date() } : {}),
          ...(status !== 'confirmed' ? { confirmed_by: null, confirmed_at: null } : {}),
        })
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', id)
        .where('version', '=', form.version)
        .executeTakeFirst();
      // Changed meanwhile, or readable but not writable (a viewer's own form).
      if (!updated.numUpdatedRows) {
        const now = await this.row(trx, ctx, id);
        throw BigInt(now.version) !== BigInt(form.version) ? conflict() : forbidden();
      }
      if (req.targets !== undefined || kindChanged) {
        await trx
          .deleteFrom('app.tax_form_target')
          .where('workspace_id', '=', ctx.workspaceId)
          .where('tax_form_id', '=', id)
          .execute();
        await this.writeTargets(trx, ctx, id, placed.targets);
      }
      if (supersedesId && supersedesId !== form.supersedes_id) await this.supersede(trx, ctx, supersedesId);
      await this.learn(trx, ctx, {
        kind,
        ein: issuerEin,
        accountLast4: req.accountLast4 !== undefined ? req.accountLast4 : form.account_last4,
        issuerName: req.issuerName !== undefined ? req.issuerName : form.issuer_name,
        personTinLast4: req.personTinLast4 !== undefined ? req.personTinLast4 : form.person_tin_last4,
        targets: req.targets !== undefined ? placed.targets : null,
        person: req.personMemberId !== undefined || req.targets !== undefined ? placed.personMemberId : null,
      });
      if (!typed) await this.settleRead(trx, ctx, id);
      return this.read(trx, ctx, id);
    });
  }

  /**
   * Confirm reading (§5.6): a person checked the boxes against the file. It needs the boxes, a match and the person;
   * it clears a probable copy (it's kept as its own form), drops the masked reading, and confirms the match memory, as
   * picking the match by hand would.
   */
  async confirm(ctx: Actor, id: string, req: ConfirmTaxFormReadingRequest): Promise<TaxFormDto> {
    return this.db.run(ctx, async (trx) => {
      const form = await this.live(trx, ctx, id);
      if (BigInt(form.version) !== BigInt(req.version)) throw conflict();
      if (form.source === 'typed')
        throw unprocessable('tax_form.typed', 'A form typed in is confirmed already');
      if (form.status === 'confirmed') return this.read(trx, ctx, id);
      if (form.status !== 'review') {
        throw unprocessable('tax_form.not_in_review', 'Only a form waiting in Review can be confirmed');
      }
      const info = readingInfo(form);
      if (Object.keys((form.boxes as object | null) ?? {}).length === 0 || info?.kindKnown === false) {
        throw unprocessable('tax_form.unread', 'Type the boxes in first');
      }
      const targets = (await this.targetsOf(trx, ctx, [id])).get(id) ?? [];
      if (targets.length === 0)
        throw unprocessable('tax_form.no_match', 'Match it to an employer or account first');
      if (!form.person_member_id) throw unprocessable('tax_form.no_person', 'Say who it’s for first');
      await this.confirmRead(trx, ctx, form, 'person');
      return this.read(trx, ctx, id);
    });
  }

  /**
   * A form from a file, after it's read or changed: its status from what it says now (§3, §5.6). Unread (no boxes, or
   * no kind) first; a probable copy or a person conflict until a person settles it; then no match, no person; then the
   * checks: every `check` box agreeing with the books confirms the reading by that match, and a difference keeps it
   * in Review. A reading that's neither (not tracked in the books) stays unconfirmed, and isn't a Review item.
   */
  async settleRead(trx: Trx, ctx: Ctx, id: string): Promise<void> {
    const form = await this.row(trx, ctx, id);
    if (form.source === 'typed' || form.status !== 'review') return;
    const info = readingInfo(form);
    const targets = (await this.targetsOf(trx, ctx, [id])).get(id) ?? [];
    let reason: TaxFormReason | null;
    if (Object.keys((form.boxes as object | null) ?? {}).length === 0 || info?.kindKnown === false)
      reason = 'unread';
    else if (form.reason && HELD_REASONS.includes(form.reason)) reason = form.reason as TaxFormReason;
    else if (targets.length === 0) reason = 'no_match';
    else if (!form.person_member_id) reason = 'no_person';
    else {
      const { checks } = await this.evaluate(trx, ctx, form, targets);
      const { outcome } = checksOutcome(checks);
      // Two sources agreeing to the cent: at least one box compared, and none differing (§5.6).
      if (outcome === 'matches' && checks.some((c) => c.kind === 'check' && c.status === 'matches')) {
        await this.confirmRead(trx, ctx, form, 'books');
        return;
      }
      reason = outcome === 'differs' || outcome === 'check_reading' ? 'differs' : null;
    }
    if (reason === form.reason) return;
    await trx
      .updateTable('app.tax_form')
      .set({ reason })
      .where('workspace_id', '=', ctx.workspaceId)
      .where('id', '=', id)
      .execute();
  }

  /** Confirms a reading, by a person or by the books; the masked reading is cleared and the match is learned. */
  private async confirmRead(trx: Trx, ctx: Ctx, form: TaxFormRow, by: 'person' | 'books'): Promise<void> {
    const info = readingInfo(form);
    const res = await trx
      .updateTable('app.tax_form')
      .set({
        status: 'confirmed',
        reason: null,
        reading: null,
        confirmed_by: by === 'person' ? ctx.userId : null,
        confirmed_at: new Date(),
        ...(info ? { detected: JSON.stringify({ ...info, confirmedBy: by, copyOfId: null }) } : {}),
      })
      .where('workspace_id', '=', ctx.workspaceId)
      .where('id', '=', form.id)
      .executeTakeFirst();
    if (!res.numUpdatedRows) throw forbidden();
    // Confirmed, by a person or by the books agreeing: the match and the person are right, so the memory learns them.
    const targets = (await this.targetsOf(trx, ctx, [form.id])).get(form.id) ?? [];
    await this.learn(trx, ctx, {
      kind: form.kind,
      ein: form.issuer_ein,
      accountLast4: form.account_last4,
      issuerName: form.issuer_name,
      personTinLast4: form.person_tin_last4,
      targets: targets.map((t) =>
        t.employer_id ? { employerId: t.employer_id } : { accountId: t.account_id! },
      ),
      person: form.person_member_id,
    });
  }

  /** Why a form still `reading` isn't: its job failed, or nothing has picked it up (a worker isn't running). */
  async jobProblem(trx: Trx, ctx: Ctx, form: TaxFormRow): Promise<'failed' | 'waiting' | null> {
    if (form.status !== 'reading') return null;
    const job = await trx
      .selectFrom('app.job')
      .select(['status', 'run_after'])
      .where('workspace_id', '=', ctx.workspaceId)
      .where('type', 'in', ['taxform.read', 'tax_form.match'])
      .where(sql<string>`payload->>'formId'`, '=', form.id)
      .orderBy('created_at', 'desc')
      .limit(1)
      .executeTakeFirst();
    if (!job || job.status === 'failed' || job.status === 'cancelled') return 'failed';
    if (job.status === 'queued' && Date.now() - job.run_after.getTime() > JOB_STALL_MS) return 'waiting';
    return null;
  }

  /** To the Trash for 30 days (BAK-06); restored from Settings → Your data. */
  async remove(ctx: Ctx, id: string): Promise<void> {
    await this.db.run(ctx, async (trx) => {
      const form = await this.row(trx, ctx, id);
      if (form.deleted_at) return;
      const res = await trx
        .updateTable('app.tax_form')
        .set({ deleted_at: new Date() })
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', id)
        .executeTakeFirst();
      if (!res.numUpdatedRows) throw forbidden();
    });
  }

  /** An expected form that won't come (§7.1). A W-2's is for its employer's member; an account's for whom it names. */
  async createWaiver(ctx: Ctx, req: CreateTaxFormWaiverRequest): Promise<TaxFormWaiverDto> {
    return this.db.run(ctx, async (trx) => {
      let entityId: string;
      let person: string | null;
      if (req.employerId) {
        const employer = await this.employer(trx, ctx, req.employerId);
        entityId = employer.entity_id;
        person = employer.member_id;
        if (req.personMemberId && req.personMemberId !== person) {
          throw unprocessable('tax_form.person_conflict', 'A W-2 is for its employer’s person');
        }
      } else {
        const account = await this.account(trx, ctx, req.accountId!);
        entityId = account.entity_id;
        person = req.personMemberId !== undefined ? req.personMemberId : account.default_member_id;
      }
      if (person) await this.member(trx, ctx, person);
      const id = newId();
      await trx
        .insertInto('app.tax_form_waiver')
        .values({
          workspace_id: ctx.workspaceId,
          id,
          entity_id: entityId,
          tax_year: req.taxYear,
          kind: req.kind,
          employer_id: req.employerId ?? null,
          account_id: req.accountId ?? null,
          person_member_id: person,
          reason: req.reason,
          note: req.note ?? null,
          created_by: ctx.userId,
        })
        .execute();
      const row = await trx
        .selectFrom('app.tax_form_waiver')
        .selectAll()
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', id)
        .executeTakeFirstOrThrow();
      return waiverDto(row);
    });
  }

  async removeWaiver(ctx: Ctx, id: string): Promise<void> {
    await this.db.run(ctx, async (trx) => {
      const res = await trx
        .deleteFrom('app.tax_form_waiver')
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', id)
        .executeTakeFirst();
      if (!res.numDeletedRows) throw notFound('Waiver');
    });
  }

  // ----- Inside a transaction -------------------------------------------------------------------------------------

  async row(trx: Trx, ctx: Ctx, id: string): Promise<TaxFormRow> {
    const form = await trx
      .selectFrom('app.tax_form')
      .selectAll()
      .where('workspace_id', '=', ctx.workspaceId)
      .where('id', '=', id)
      .executeTakeFirst();
    if (!form) throw notFound('Tax form');
    return form;
  }

  private async read(trx: Trx, ctx: Ctx, id: string): Promise<TaxFormDto> {
    const form = await this.row(trx, ctx, id);
    const targets = (await this.targetsOf(trx, ctx, [id])).get(id) ?? [];
    return toDto(form, targets, await this.evaluate(trx, ctx, form, targets));
  }

  /** A form that isn't in the Trash. */
  private async live(trx: Trx, ctx: Ctx, id: string): Promise<TaxFormRow> {
    const form = await this.row(trx, ctx, id);
    if (form.deleted_at) throw notFound('Tax form');
    return form;
  }

  private async writeAccepted(trx: Trx, ctx: Ctx, form: TaxFormRow, accepted: StoredAccepted): Promise<void> {
    const res = await trx
      .updateTable('app.tax_form')
      .set({ accepted: JSON.stringify(accepted) })
      .where('workspace_id', '=', ctx.workspaceId)
      .where('id', '=', form.id)
      .executeTakeFirst();
    // Readable but not writable (a read-only grant on the books).
    if (!res.numUpdatedRows) throw forbidden();
  }

  /**
   * A form's checks against the books for its tax year (§5), gathered under the reader's row-level security, and what
   * they come to. Nothing is stored: a payslip added later changes the result the next time it's read.
   */
  private async evaluate(
    trx: Trx,
    ctx: Ctx,
    form: TaxFormRow,
    targets: TaxFormTargetRow[],
  ): Promise<Evaluation> {
    const stored = storedAccepted(form);
    const accepted: TaxFormAcceptances = Object.fromEntries(
      Object.entries(stored.boxes ?? {}).map(([box, a]) => [
        box,
        { form: BigInt(a.form), books: BigInt(a.books), note: a.note },
      ]),
    );
    const employerIds = targets.flatMap((t) => (t.employer_id ? [t.employer_id] : []));
    const accountIds = targets.flatMap((t) => (t.account_id ? [t.account_id] : []));
    let checks: TaxFormCheck[] = [];
    let parsed: ReturnType<typeof parseTaxFormBoxes> | null = null;
    try {
      parsed = parseTaxFormBoxes(form.kind, form.boxes);
    } catch {
      parsed = null;
    }
    const year = form.tax_year;
    if (parsed && targets.length > 0 && form.status !== 'superseded' && form.status !== 'reading') {
      if (parsed.kind === 'w2') {
        checks = reconcileW2(year, parsed.boxes, await w2Books(trx, ctx, form, employerIds), accepted);
      } else if (parsed.kind === '1099_int') {
        const books = await accountIncomeBooks(trx, ctx, year, accountIds, 'interest');
        checks = reconcile1099Int(year, parsed.boxes, books, accepted);
      } else if (parsed.kind === '1099_div') {
        const books = await accountIncomeBooks(trx, ctx, year, accountIds, 'dividends');
        checks = reconcile1099Div(year, parsed.boxes, books, accepted);
      } else {
        const books = await mortgageBooks(trx, ctx, year, accountIds[0]!, parsed.boxes);
        checks = reconcile1098(year, parsed.boxes, books, accepted);
      }
    }
    const { outcome, difference } = checksOutcome(checks);
    const jobProblem = await this.jobProblem(trx, ctx, form);
    const { state, review } = resultState(
      form,
      targets.length > 0,
      checks.length > 0 ? outcome : null,
      jobProblem,
    );
    const recordable =
      parsed && (parsed.kind === '1099_int' || parsed.kind === '1099_div') && !stored.recorded
        ? await this.recordable(trx, ctx, form, accountIds, checks)
        : null;
    return {
      checks,
      result: {
        state,
        difference: state === 'differs' && difference !== null ? String(difference) : null,
        review,
        recordable,
        recorded: stored.recorded
          ? {
              journalEntryId: stored.recorded.journalEntryId,
              amount: stored.recorded.amount,
              date: stored.recorded.date,
            }
          : null,
      },
      jobProblem,
    };
  }

  /**
   * What Record from the form would move (§5.6): the form's income, when its main box isn't tracked (the account is
   * valued and posted none), onto the first valued account it's matched to, in the books' income category.
   */
  private async recordable(
    trx: Trx,
    ctx: Ctx,
    form: TaxFormRow,
    accountIds: string[],
    checks: TaxFormCheck[],
  ): Promise<TaxFormResultDto['recordable']> {
    const main = checks.find((c) => c.box === (form.kind === '1099_div' ? '1a' : '1+3+8'));
    if (!main || main.status !== 'not_tracked' || !main.form || main.form <= 0n) return null;
    const accounts = await trx
      .selectFrom('app.bank_account as b')
      .innerJoin('app.ledger_account as a', (j) =>
        j.onRef('a.workspace_id', '=', 'b.workspace_id').onRef('a.id', '=', 'b.ledger_account_id'),
      )
      .select(['a.id', 'a.name', 'a.entity_id', 'b.kind'])
      .where('b.workspace_id', '=', ctx.workspaceId)
      .where('b.ledger_account_id', 'in', accountIds)
      .execute();
    const valued = accountIds
      .map((id) => accounts.find((a) => a.id === id))
      .find((a) => a && accountProfile(a.kind).balanceWord === 'value');
    if (!valued) return null;
    const category = await this.incomeCategoryOf(trx, ctx, valued.entity_id, form.kind as IncomeKindForm);
    if (!category) return null;
    return {
      amount: String(main.form),
      accountId: valued.id,
      accountName: valued.name,
      categoryName: category.name,
    };
  }

  /** The books' interest or dividend income category: on Schedule B's line first, then by name (§5.7). */
  private async incomeCategoryOf(
    trx: Trx,
    ctx: Ctx,
    entityId: string,
    kind: IncomeKindForm,
  ): Promise<{ id: string; name: string } | undefined> {
    return trx
      .selectFrom('app.ledger_account as c')
      .select(['c.id', 'c.name'])
      .where('c.workspace_id', '=', ctx.workspaceId)
      .where('c.entity_id', '=', entityId)
      .where('c.archived_at', 'is', null)
      .where(incomeCategory('c', kind === '1099_div' ? 'dividends' : 'interest'))
      .orderBy(sql`c.tax_line_code is null`)
      .orderBy('c.sort_order')
      .orderBy('c.name')
      .executeTakeFirst();
  }

  /**
   * A match or person picked by hand teaches the memory (ADR-0052 §4): the issuer's signal points at the employer or
   * the one account (a form matched to several accounts teaches nothing), and the person's last four digits, as a
   * keyed hash, at the person.
   */
  private async learn(
    trx: Trx,
    ctx: Ctx,
    m: {
      kind: TaxFormKind;
      ein: string | null;
      accountLast4: string | null;
      issuerName: string | null;
      personTinLast4: string | null;
      targets: Target[] | null;
      person: string | null;
    },
  ): Promise<void> {
    if (m.targets && m.targets.length === 1) {
      const t = m.targets[0]!;
      const signal = taxIssuerSignal({
        kind: m.kind,
        ein: m.ein,
        accountLast4: m.accountLast4,
        issuerName: m.issuerName,
      });
      await confirmMatch(trx, ctx, 'tax_issuer', signal, 'employerId' in t ? t.employerId : t.accountId);
    }
    if (m.person && m.personTinLast4) {
      const hash = await this.crypto.keyedHash(trx, ctx.workspaceId, 'tax_person', m.personTinLast4);
      await confirmMatch(trx, ctx, 'tax_person', `tin4:${hash}`, m.person);
    }
  }

  private async targetsOf(trx: Trx, ctx: Ctx, ids: string[]): Promise<Map<string, TaxFormTargetRow[]>> {
    const byForm = new Map<string, TaxFormTargetRow[]>();
    if (ids.length === 0) return byForm;
    const rows = await trx
      .selectFrom('app.tax_form_target')
      .selectAll()
      .where('workspace_id', '=', ctx.workspaceId)
      .where('tax_form_id', 'in', ids)
      .orderBy('id')
      .execute();
    for (const r of rows) byForm.set(r.tax_form_id, [...(byForm.get(r.tax_form_id) ?? []), r]);
    return byForm;
  }

  async writeTargets(trx: Trx, ctx: Ctx, formId: string, targets: Target[]): Promise<void> {
    if (targets.length === 0) return;
    await trx
      .insertInto('app.tax_form_target')
      .values(
        targets.map((t) => ({
          workspace_id: ctx.workspaceId,
          // Time-ordered ids keep the targets in the order they were given.
          id: newId(),
          tax_form_id: formId,
          employer_id: 'employerId' in t ? t.employerId : null,
          account_id: 'accountId' in t ? t.accountId : null,
        })),
      )
      .execute();
  }

  /**
   * Where a form goes (§3, §4): its books from what it's matched to (the personal books until then), and its person,
   * which for a W-2 is the employer's member unless the request names the same person.
   */
  async place(
    trx: Trx,
    ctx: Ctx,
    kind: TaxFormKind,
    targets: Target[],
    personMemberId: string | null | undefined,
  ): Promise<{ entityId: string; personMemberId: string | null; targets: Target[] }> {
    const unique = dedupe(targets);
    const employers = unique.filter((t): t is { employerId: string } => 'employerId' in t);
    const accounts = unique.filter((t): t is { accountId: string } => 'accountId' in t);
    if (kind === 'w2' ? accounts.length > 0 || employers.length > 1 : employers.length > 0) {
      throw unprocessable(
        'tax_form.target_kind',
        kind === 'w2' ? 'A W-2 is matched to one employer' : 'A 1099 or 1098 is matched to accounts',
      );
    }
    const books = new Set<string>();
    let person = personMemberId ?? null;
    if (employers[0]) {
      const employer = await this.employer(trx, ctx, employers[0].employerId);
      books.add(employer.entity_id);
      if (personMemberId === undefined || personMemberId === null) person = employer.member_id;
      else if (personMemberId !== employer.member_id) {
        throw unprocessable('tax_form.person_conflict', 'A W-2 is for its employer’s person');
      }
    }
    for (const t of accounts) books.add((await this.account(trx, ctx, t.accountId)).entity_id);
    if (books.size > 1) {
      throw unprocessable('tax_form.targets_books', 'The accounts of one form belong to the same books');
    }
    if (person) await this.member(trx, ctx, person);
    const entityId = [...books][0] ?? (await this.personalBooks(trx, ctx));
    return { entityId, personMemberId: person, targets: unique };
  }

  private async employer(trx: Trx, ctx: Ctx, id: string) {
    const employer = await trx
      .selectFrom('app.employer')
      .select(['id', 'entity_id', 'member_id'])
      .where('workspace_id', '=', ctx.workspaceId)
      .where('id', '=', id)
      .executeTakeFirst();
    if (!employer) throw notFound('Employer');
    return employer;
  }

  private async account(trx: Trx, ctx: Ctx, id: string) {
    const account = await trx
      .selectFrom('app.ledger_account as a')
      .innerJoin('app.bank_account as b', (j) =>
        j.onRef('b.workspace_id', '=', 'a.workspace_id').onRef('b.ledger_account_id', '=', 'a.id'),
      )
      .select(['a.id', 'a.entity_id', 'b.default_member_id'])
      .where('a.workspace_id', '=', ctx.workspaceId)
      .where('a.id', '=', id)
      .executeTakeFirst();
    if (!account) throw notFound('Account');
    return account;
  }

  private async member(trx: Trx, ctx: Ctx, id: string): Promise<void> {
    const member = await trx
      .selectFrom('app.family_member')
      .select('id')
      .where('workspace_id', '=', ctx.workspaceId)
      .where('id', '=', id)
      .executeTakeFirst();
    if (!member) throw notFound('Family member');
  }

  async personalBooks(trx: Trx, ctx: Ctx): Promise<string> {
    const books = await trx
      .selectFrom('app.entity')
      .select('id')
      .where('workspace_id', '=', ctx.workspaceId)
      .where('type', '=', 'personal')
      .where('archived_at', 'is', null)
      .orderBy('created_at')
      .orderBy('id')
      .executeTakeFirst();
    if (!books) throw forbidden('You can’t add tax forms to the personal books');
    return books.id;
  }

  private async checkSupersedes(
    trx: Trx,
    ctx: Ctx,
    supersedesId: string,
    kind: TaxFormKind,
    selfId: string | null,
  ): Promise<void> {
    if (supersedesId === selfId) throw unprocessable('tax_form.supersedes', 'A form can’t replace itself');
    const old = await this.row(trx, ctx, supersedesId).catch(() => null);
    if (!old || old.deleted_at) throw notFound('The form it corrects');
    if (old.kind !== kind)
      throw unprocessable('tax_form.supersedes', 'A corrected form replaces one of its kind');
  }

  /** The form a corrected one replaces stays visible, marked superseded (§6). */
  async supersede(trx: Trx, ctx: Ctx, id: string): Promise<void> {
    await trx
      .updateTable('app.tax_form')
      .set({ status: 'superseded', reason: null })
      .where('workspace_id', '=', ctx.workspaceId)
      .where('id', '=', id)
      .execute();
  }
}

// ----- Pure helpers --------------------------------------------------------------------------------------------------

type IncomeKindForm = '1099_int' | '1099_div';

const formName = (kind: TaxFormKind) =>
  ({ w2: 'W-2', '1099_int': '1099-INT', '1099_div': '1099-DIV', '1098': '1098' })[kind];

function storedAccepted(form: TaxFormRow): StoredAccepted {
  const a = form.accepted as StoredAccepted | null;
  return a && typeof a === 'object' ? a : {};
}

/** Accountants don't match a W-2 to an employer (see `W2_EMPLOYER_MATCHERS`). */
function checkMatcher(ctx: Actor, kind: TaxFormKind, targets: readonly Target[]): void {
  if (kind !== 'w2' || !targets.some((t) => 'employerId' in t) || !ctx.role) return;
  if (!W2_EMPLOYER_MATCHERS.includes(ctx.role)) {
    throw forbidden('An owner, an admin or the person it’s for matches a W-2 to an employer');
  }
}

/**
 * What a form comes to (§7.1): its stored status first (being read, put aside, replaced, or waiting for a match or a
 * person), then what its checks add up to. Differences and misreads are Review items; so is anything waiting.
 */
function resultState(
  form: TaxFormRow,
  matched: boolean,
  outcome: ReturnType<typeof checksOutcome>['outcome'] | null,
  jobProblem: 'failed' | 'waiting' | null = null,
): { state: TaxFormResultState; review: boolean } {
  if (form.status === 'superseded') return { state: 'superseded', review: false };
  if (form.status === 'dismissed') return { state: 'dismissed', review: false };
  // A reading that failed is a form to type in; one nothing picks up is still being read, with a warning.
  if (form.status === 'reading')
    return jobProblem === 'failed' ? { state: 'unread', review: true } : { state: 'reading', review: false };
  if (form.status === 'review' && form.reason === 'unread') return { state: 'unread', review: true };
  // A person settles these first, matched or not.
  if (form.status === 'review' && form.reason === 'person_conflict')
    return { state: 'person_conflict', review: true };
  if (form.status === 'review' && form.reason === 'probable_copy')
    return { state: 'probable_copy', review: true };
  if (!matched) return { state: 'needs_match', review: true };
  if (form.status === 'review') {
    const waiting: Partial<Record<string, TaxFormResultState>> = {
      no_match: 'needs_match',
      no_person: 'needs_person',
      unread: 'unread',
      person_conflict: 'person_conflict',
      probable_copy: 'probable_copy',
    };
    const state = form.reason ? waiting[form.reason] : undefined;
    if (state) return { state, review: true };
  }
  const state = outcome ?? 'matches';
  return { state, review: state === 'differs' || state === 'check_reading' };
}

const checkDto = (c: TaxFormCheck): TaxFormCheckDto => ({
  box: c.box,
  kind: c.kind,
  form: c.form === null ? null : String(c.form),
  books: c.books === null ? null : String(c.books),
  difference: c.difference === null ? null : String(c.difference),
  status: c.status,
  rule: c.rule,
  explanation: c.explanation,
  acceptedNote: c.acceptedNote,
  sources: c.sources,
});

/** A typed form needs a person only once it's matched and its person is known. */
function typedStatus(
  matched: boolean,
  personKnown: boolean,
): { status: TaxFormStatus; reason: TaxFormReason | null } {
  if (!matched) return { status: 'review', reason: 'no_match' };
  if (!personKnown) return { status: 'review', reason: 'no_person' };
  return { status: 'confirmed', reason: null };
}

function checkedBoxes(kind: TaxFormKind, boxes: unknown): Record<string, unknown> {
  try {
    return normalizeTaxFormBoxes(kind, boxes);
  } catch (err) {
    if (err instanceof TaxFormBoxesError) {
      throw new AppError(422, 'tax_form.boxes', 'Check the boxes', [
        { path: `boxes.${err.path}`, message: err.message },
      ]);
    }
    throw err;
  }
}

function checkIssuerTin(ein: string | null, last4: string | null): void {
  if (ein && last4) {
    throw unprocessable('tax_form.issuer_tin', 'An issuer has an EIN or an SSN-shaped TIN, not both');
  }
}

function dedupe(targets: Target[]): Target[] {
  const seen = new Set<string>();
  return targets.filter((t) => {
    const key = 'employerId' in t ? `e:${t.employerId}` : `a:${t.accountId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

function toDto(f: TaxFormRow, targets: TaxFormTargetRow[], evaluation: Evaluation): TaxFormDto {
  return {
    id: f.id,
    entityId: f.entity_id,
    taxYear: f.tax_year,
    kind: f.kind,
    corrected: f.corrected,
    supersedesId: f.supersedes_id,
    issuerName: f.issuer_name,
    issuerEin: f.issuer_ein,
    issuerTinLast4: f.issuer_tin_last4,
    personTinLast4: f.person_tin_last4,
    accountLast4: f.account_last4,
    personMemberId: f.person_member_id,
    targets: targets.map((t) => ({ employerId: t.employer_id, accountId: t.account_id })),
    // Stored canonical by `normalizeTaxFormBoxes`; the kind decides which boxes they are.
    boxes: f.boxes,
    fileIds: f.file_ids,
    pages: f.pages,
    status: f.status,
    reason: f.reason as TaxFormReason | null,
    source: f.source,
    createdBy: f.created_by,
    confirmedBy: f.confirmed_by,
    confirmedAt: iso(f.confirmed_at),
    deletedAt: iso(f.deleted_at),
    createdAt: f.created_at.toISOString(),
    updatedAt: f.updated_at.toISOString(),
    version: Number(f.version),
    result: evaluation.result,
    checks: evaluation.checks.map(checkDto),
    reading: readingDto(f, evaluation.jobProblem),
  } as TaxFormDto;
}

/** How a form from a file was read (`detected`); null for one typed in. */
export function readingInfo(f: TaxFormRow): StoredReadingInfo | null {
  if (f.source === 'typed') return null;
  const d = f.detected as Partial<StoredReadingInfo> | null;
  return {
    fileNames: d?.fileNames ?? [],
    kindKnown: d?.kindKnown ?? true,
    boxesRead: d?.boxesRead ?? false,
    problem: d?.problem ?? null,
    droppedBoxes: d?.droppedBoxes ?? 0,
    confirmedBy: d?.confirmedBy ?? null,
    match: d?.match ?? { automatic: false, reason: null, candidates: [] },
    copyOfId: d?.copyOfId ?? null,
    signal: d?.signal ?? null,
  };
}

function readingDto(f: TaxFormRow, jobProblem: 'failed' | 'waiting' | null): TaxFormDto['reading'] {
  const info = readingInfo(f);
  if (!info) return null;
  return {
    fileNames: info.fileNames,
    kindKnown: info.kindKnown,
    boxesRead: info.boxesRead,
    problem: jobProblem ?? info.problem,
    droppedBoxes: info.droppedBoxes,
    confirmedBy: f.status === 'confirmed' ? info.confirmedBy : null,
    match: info.match,
    copyOfId: info.copyOfId,
  };
}

function waiverDto(w: TaxFormWaiverRow): TaxFormWaiverDto {
  return {
    id: w.id,
    entityId: w.entity_id,
    taxYear: w.tax_year,
    kind: w.kind,
    employerId: w.employer_id,
    accountId: w.account_id,
    personMemberId: w.person_member_id,
    reason: w.reason,
    note: w.note,
    createdBy: w.created_by,
    createdAt: w.created_at.toISOString(),
  };
}
