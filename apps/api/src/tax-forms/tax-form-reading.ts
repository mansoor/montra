/**
 * Reading tax forms from files (ADR-0052 §4, §6; TAX-01 upload, TAX-02, TAX-03, TAX-08):
 *
 * 1. `POST tax-forms/files` stores each file (refusing one already received, by its SHA-256) and makes a form in
 *    `reading` for it, then queues the doc-worker's `taxform.read`, with the household's names and pseudonym tokens.
 * 2. The doc-worker reads the text (text layer or OCR), finds the titles and drops duplicate copies, extracts the
 *    identifiers locally and masks the text. Nothing but masked text and last four digits (and an issuer's EIN) leaves it.
 * 3. `tax_form.match` (here) reads the masked text with the gateway's `extract_tax_form` (text only, never images),
 *    makes one form per form found (a consolidated 1099 gives several), attaches the identifiers by page, matches the
 *    issuer and the person (§4: the memory with an EIN, or one clear candidate), finds probable copies and the forms a
 *    corrected one replaces, and settles each form's status: confirmed by the books when every check agrees, otherwise
 *    in Review with its reason. With AI off or unavailable, the forms the titles name wait in Review to be typed in.
 *
 * The job runs as the uploader, under their row-level security: a member matches only to their own employers and
 * accounts, and an accountant never to an employer (`W2_EMPLOYER_MATCHERS`).
 */
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { newId, type MemberRole, type TaxFormRow, type Trx } from '@montra/db';
import { isTaxFormKind, parseTaxFormBoxes, type TaxFormKind } from '@montra/domain';
import type { TaxFormExtraction } from '@montra/ai-gateway';
import {
  decideTaxFormMatch,
  issuerNamesAgree,
  taxIssuerSignal,
  type TaxFormMatchDecision,
  type TaxIssuerCandidate,
} from '@montra/importers';
import type {
  TaxFormCandidateDto,
  TaxFormReadingProblem,
  TaxFormUploadDto,
  UploadTaxFormFieldsDto,
} from '@montra/schemas';
import { AiService } from '../ai/ai.service.js';
import { AppError, notFound } from '../common/errors.js';
import { FieldCrypto } from '../crypto/crypto.service.js';
import { Db } from '../db/database.js';
import { memoryState, readMemory } from '../intakes/match-memory.js';
import { JobQueue, PermanentJobError, Worker, type Job } from '../jobs/queue.js';
import { detectReceiptMedia } from '../receipts/receipts.service.js';
import { FileBytes } from '../storage/file-bytes.js';
import { STORAGE_PORT, sha256, storageKey, type StoragePort } from '../storage/storage.js';
import { expectedInputs } from './tax-form-books.js';
import { TaxFormsService, W2_EMPLOYER_MATCHERS, type StoredReadingInfo } from './tax-forms.service.js';

type Ctx = { workspaceId: string; userId: string };

/** At most this many files in one upload. */
export const MAX_TAX_FORM_FILES = 20;

/** The doc-worker's `taxform.read` result (apps/doc-worker taxform.py). */
interface DocPage {
  page: number;
  text: string;
  forms: { kind: TaxFormKind | 'other'; corrected: boolean; taxYear: number | null }[];
  copiesDropped: number;
  identifiers: {
    personTinLast4: string | null;
    issuerEin: string | null;
    issuerTinLast4: string | null;
    accountLast4: string | null;
  };
}
export interface TaxFormTextResult {
  kind: 'taxform_text';
  pages: DocPage[];
  pageCount: number;
  textLayer: boolean;
  ocrEngine: 'tesseract' | null;
  error: { code: string; message: string } | null;
}

interface MatchPayload {
  formId: string;
  taxYearHint: number;
  previousResult?: TaxFormTextResult;
}

/** One form found in a file, before it's placed. */
interface Draft {
  kind: TaxFormKind;
  kindKnown: boolean;
  taxYear: number;
  corrected: boolean;
  issuerName: string | null;
  personToken: string | null;
  pages: number[];
  boxes: Record<string, unknown>;
  droppedBoxes: number;
  ids: DocPage['identifiers'];
  problem: TaxFormReadingProblem | null;
}

const last4 = (s: string | null | undefined) => (s && /^\d{4}$/.test(s) ? s : null);
const ein = (s: string | null | undefined) => (s && /^\d{9}$/.test(s) ? s : null);

@Injectable()
export class TaxFormReading {
  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(JobQueue) private readonly queue: JobQueue,
    @Inject(STORAGE_PORT) private readonly storage: StoragePort,
    @Inject(AiService) private readonly ai: AiService,
    @Inject(FieldCrypto) private readonly crypto: FieldCrypto,
    @Inject(TaxFormsService) private readonly forms: TaxFormsService,
    @Inject(Worker) private readonly worker: Worker,
    @Inject(FileBytes) private readonly files: FileBytes,
  ) {}

  register(): void {
    this.worker.register('tax_form.match', (job) => this.match(job));
  }

  // ----- Upload ------------------------------------------------------------------------------------------------------

  /**
   * Stores the files and starts reading each one. The same file again is refused with the form already made from it;
   * the rest are read. Every file is checked before any is stored.
   */
  async upload(
    ctx: Ctx,
    files: readonly { bytes: Uint8Array; fileName: string }[],
    fields: UploadTaxFormFieldsDto,
  ): Promise<TaxFormUploadDto> {
    if (files.length === 0) throw new AppError(400, 'upload.no_file', 'No file in the request');
    if (files.length > MAX_TAX_FORM_FILES)
      throw new AppError(413, 'upload.too_many', `Upload up to ${MAX_TAX_FORM_FILES} files at once`);
    const checked = files.map((f) => {
      const mime = detectReceiptMedia(f.bytes);
      if (!mime)
        throw new AppError(
          415,
          'tax_form.unsupported_type',
          `${f.fileName}: upload a PDF, or a JPEG, PNG or WebP photo`,
        );
      return {
        ...f,
        mime,
        digest: sha256(f.bytes),
        fileName: f.fileName.replace(/[\\/\0]/g, '_').slice(0, 255),
      };
    });
    const year = fields.year ?? new Date().getUTCFullYear() - 1;
    const source = fields.source ?? 'upload';
    const out: TaxFormUploadDto['files'] = [];
    const stored: string[] = [];
    try {
      await this.db.run(ctx, async (trx) => {
        const members = await this.pseudonyms(trx, ctx);
        const personal = await this.forms.personalBooks(trx, ctx);
        const seen = new Map<string, string>();
        for (const f of checked) {
          const earlier =
            seen.get(f.digest) ??
            (
              await trx
                .selectFrom('app.tax_form')
                .select('id')
                .where('workspace_id', '=', ctx.workspaceId)
                .where('sha256', '=', f.digest)
                .where('deleted_at', 'is', null)
                .orderBy('created_at')
                .executeTakeFirst()
            )?.id;
          if (earlier) {
            out.push({ fileName: f.fileName || 'tax-form', status: 'duplicate', formId: earlier });
            continue;
          }
          const fileId = newId();
          const key = storageKey(ctx.workspaceId, 'tax_form', fileId);
          await this.storage.put(key, f.bytes, f.mime);
          stored.push(key);
          await trx
            .insertInto('app.file')
            .values({
              workspace_id: ctx.workspaceId,
              id: fileId,
              // Its own kind (migration 0060), so the owner's storage can leave it out; reachable only through its form,
              // as payslips are. It's kept until 31 December of the tax year + 7 (a trigger on the form sets it, §8.5).
              kind: 'tax_form',
              storage_key: key,
              file_name: f.fileName || 'tax-form',
              mime: f.mime,
              bytes: f.bytes.length,
              sha256: f.digest,
              uploaded_by: ctx.userId,
            })
            .execute();
          const formId = newId();
          const info: StoredReadingInfo = {
            fileNames: [f.fileName || 'tax-form'],
            kindKnown: false,
            boxesRead: false,
            problem: null,
            droppedBoxes: 0,
            confirmedBy: null,
            match: { automatic: false, reason: null, candidates: [] },
            copyOfId: null,
            signal: null,
          };
          await trx
            .insertInto('app.tax_form')
            .values({
              workspace_id: ctx.workspaceId,
              id: formId,
              entity_id: personal,
              tax_year: year,
              // Until it's read: the kind is unknown (`reading.kindKnown`), and the column needs one.
              kind: 'w2',
              status: 'reading',
              source,
              file_ids: [fileId],
              sha256: f.digest,
              detected: JSON.stringify(info),
              created_by: ctx.userId,
            })
            .execute();
          const jobId = await this.queue.enqueue(trx, {
            ...ctx,
            queue: 'doc',
            type: 'taxform.read',
            payload: { workspaceId: ctx.workspaceId, formId, storageKey: key, members },
            then: {
              queue: 'ai',
              type: 'tax_form.match',
              payload: { workspaceId: ctx.workspaceId, formId, taxYearHint: year },
            },
          });
          await trx
            .updateTable('app.tax_form')
            .set({ job_id: jobId })
            .where('workspace_id', '=', ctx.workspaceId)
            .where('id', '=', formId)
            .execute();
          seen.set(f.digest, formId);
          out.push({ fileName: f.fileName || 'tax-form', status: 'reading', formId });
        }
      });
    } catch (err) {
      // Nothing was recorded: don't leave the bytes behind.
      await Promise.all(stored.map((k) => this.storage.delete(k).catch(() => {})));
      throw err;
    }
    return { files: out };
  }

  /** A form's original file (§8.3): only through a form the caller can read, and every look is in the audit log. */
  async file(
    ctx: Ctx,
    formId: string,
    fileId: string,
  ): Promise<{ bytes: Uint8Array; mime: string; name: string }> {
    const f = await this.db.run(ctx, async (trx) => {
      const form = await this.forms.row(trx, ctx, formId);
      if (form.deleted_at || !form.file_ids.includes(fileId)) throw notFound('File');
      const file = await trx
        .selectFrom('app.file')
        .select(['id', 'storage_key', 'sha256', 'mime', 'file_name'])
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', fileId)
        .executeTakeFirst();
      if (!file) throw notFound('File');
      await trx
        .insertInto('app.audit_log')
        .values({
          workspace_id: ctx.workspaceId,
          actor_user_id: ctx.userId,
          action: 'tax_form.file_viewed',
          subject_type: 'tax_form',
          subject_id: formId,
          diff: JSON.stringify({ fileId }),
        })
        .execute();
      return file;
    });
    // A person viewing it: a file only the vault holds opens there (ADR-0054 §5).
    return { bytes: await this.files.bytes(ctx, f, { vault: false }), mime: f.mime, name: f.file_name };
  }

  /** Members' names with the tokens the gateway gives them (AiService.runtime: MEMBER_1 is the first member made). */
  private async pseudonyms(trx: Trx, ctx: Ctx): Promise<{ name: string; token: string }[]> {
    const members = await trx
      .selectFrom('app.family_member')
      .select(['name'])
      .where('workspace_id', '=', ctx.workspaceId)
      .orderBy('created_at')
      .execute();
    return members.map((m, i) => ({ name: m.name, token: `MEMBER_${i + 1}` }));
  }

  // ----- tax_form.match ------------------------------------------------------------------------------------------------

  async match(job: Job): Promise<Record<string, unknown>> {
    if (!job.workspace_id || !job.created_by)
      throw new PermanentJobError('job.invalid', 'Job without workspace or user');
    const ctx = { workspaceId: job.workspace_id, userId: job.created_by };
    const p = job.payload as unknown as MatchPayload;
    const doc = p.previousResult;
    if (!doc || doc.kind !== 'taxform_text')
      throw new PermanentJobError('tax_form.no_reading', 'The document worker gave no reading');
    const form = await this.db.run(ctx, async (trx) => this.forms.row(trx, ctx, p.formId).catch(() => null));
    if (!form || form.status !== 'reading' || form.deleted_at) return { skipped: form?.status ?? 'gone' };

    // The AI reads the masked text: never images (the owner's decision 5).
    let extraction: TaxFormExtraction | null = null;
    let problem: TaxFormReadingProblem | null = doc.error ? 'unreadable' : null;
    if (!problem) {
      const outcome = await this.db.run({ ...ctx, actorType: 'worker' }, async (trx) => {
        const runtime = await this.ai.runtime(trx, ctx, { type: 'tax_form', id: form.id });
        // Local-mode readings aren't applied to rows yet (STATUS backlog #2): typed in until they are.
        if (!runtime.available || runtime.mode === 'local' || runtime.mode === 'off') return null;
        return this.ai.gateway.extractTaxForm(
          { pages: doc.pages.map((pg) => ({ page: pg.page, text: pg.text })), taxYearHint: p.taxYearHint },
          { ...runtime.ctx, parkLocal: false },
        );
      });
      if (!outcome) problem = 'ai_unavailable';
      else if (!outcome.ok)
        problem = ['off', 'budget', 'pending_local'].includes(outcome.reason)
          ? 'ai_unavailable'
          : 'ai_failed';
      else if (outcome.value.forms.length === 0) problem = 'no_form_found';
      else extraction = outcome.value;
    }
    const drafts = this.drafts(doc, extraction, problem, form.tax_year);
    const placed = await this.db.run({ ...ctx, actorType: 'worker' }, (trx) =>
      this.place(trx, ctx, form, drafts),
    );
    return { forms: placed.length, read: extraction !== null, problem };
  }

  /** The forms a file holds: what the AI read, else the titles the doc-worker found (to be typed in). */
  private drafts(
    doc: TaxFormTextResult,
    extraction: TaxFormExtraction | null,
    problem: TaxFormReadingProblem | null,
    yearHint: number,
  ): Draft[] {
    const idsOf = (pages: number[]): DocPage['identifiers'] => {
      const on = doc.pages.filter((pg) => pages.length === 0 || pages.includes(pg.page));
      const first = <K extends keyof DocPage['identifiers']>(k: K) =>
        on.map((pg) => pg.identifiers?.[k] ?? null).find((v) => v !== null) ?? null;
      return {
        personTinLast4: last4(first('personTinLast4')),
        issuerEin: ein(first('issuerEin')),
        issuerTinLast4: last4(first('issuerTinLast4')),
        accountLast4: last4(first('accountLast4')),
      };
    };
    const titled = doc.pages.flatMap((pg) =>
      pg.forms
        .filter((f) => isTaxFormKind(f.kind))
        .map((f) => ({ ...f, kind: f.kind as TaxFormKind, page: pg.page })),
    );
    if (extraction) {
      return extraction.forms.map((f) => {
        const title = titled.find(
          (t) => t.kind === f.kind && (f.pages.length === 0 || f.pages.includes(t.page)),
        );
        return {
          kind: f.kind,
          kindKnown: true,
          taxYear: f.taxYear ?? title?.taxYear ?? yearHint,
          corrected: f.corrected || (title?.corrected ?? false),
          issuerName: f.issuerName,
          personToken: f.person,
          pages: f.pages,
          boxes: f.boxes,
          droppedBoxes: f.droppedBoxes,
          ids: idsOf(f.pages),
          problem: null,
        };
      });
    }
    const unread = (
      kind: TaxFormKind,
      kindKnown: boolean,
      pages: number[],
      year: number | null,
      corrected: boolean,
    ) => ({
      kind,
      kindKnown,
      taxYear: year ?? yearHint,
      corrected,
      issuerName: null,
      personToken: null,
      pages,
      boxes: {},
      droppedBoxes: 0,
      ids: idsOf(pages),
      problem,
    });
    if (titled.length === 0) return [unread('w2', false, [], null, false)];
    return titled.map((t) => unread(t.kind, true, [t.page], t.taxYear, t.corrected));
  }

  /** Writes the forms: the first into the form made at upload, the rest as new forms of the same file. */
  private async place(trx: Trx, ctx: Ctx, form: TaxFormRow, drafts: Draft[]): Promise<string[]> {
    const pseudonyms = await trx
      .selectFrom('app.family_member')
      .select(['id', 'name', 'linked_user_id'])
      .where('workspace_id', '=', ctx.workspaceId)
      .orderBy('created_at')
      .execute();
    const { rows } = await sql<{ role: MemberRole | null }>`select app.current_member_role() as role`.execute(
      trx,
    );
    const role = rows[0]?.role ?? null;
    const prior = (form.detected as StoredReadingInfo | null) ?? null;
    const batch: string[] = [];
    for (const [i, d] of drafts.entries()) {
      const id = i === 0 ? form.id : newId();
      batch.push(id);
      const tokenMember = d.personToken
        ? (pseudonyms[Number(/^MEMBER_(\d+)$/.exec(d.personToken)?.[1]) - 1]?.id ?? null)
        : null;
      const memoryPerson = await this.learnedPerson(trx, ctx, d.ids.personTinLast4, pseudonyms);
      const hint = tokenMember ?? memoryPerson;
      const conflictingHints = tokenMember && memoryPerson && tokenMember !== memoryPerson;
      const signal = taxIssuerSignal({
        kind: d.kind,
        ein: d.ids.issuerEin,
        accountLast4: d.ids.accountLast4,
        issuerName: d.issuerName,
      });
      const candidates = await this.candidates(trx, ctx, d.kind, d.taxYear, role);
      const memory = memoryState(await readMemory(trx, ctx, 'tax_issuer', signal));
      const personName = hint ? (pseudonyms.find((m) => m.id === hint)?.name ?? null) : null;
      const decide = (personId: string | null) =>
        decideTaxFormMatch({
          kind: d.kind,
          year: d.taxYear,
          issuerName: d.issuerName,
          accountLast4: d.ids.accountLast4,
          personId,
          personName,
          candidates,
          signal,
          memory,
        });
      // A W-2's employer decides its person, so it's found without the person first; the person may then pick
      // between employers the name alone doesn't tell apart.
      let decision: TaxFormMatchDecision = decide(d.kind === 'w2' ? null : hint);
      if (!decision.automatic && d.kind === 'w2' && hint) decision = decide(hint);
      // The person (§4): a W-2's employer's member, then the token, the learned last four, the only login.
      let person: string | null = null;
      let conflict = Boolean(conflictingHints);
      if (decision.automatic && d.kind === 'w2') {
        const employer = candidates.find((c) => c.id === decision.targetId)!;
        if (hint && employer.memberId !== hint) {
          // The reading names one member, the employer another: a person decides, never a guess.
          conflict = true;
          decision = { automatic: false, targetId: null, reason: null, candidates: decision.candidates };
        } else person = employer.memberId;
      } else if (!conflict) {
        const logins = pseudonyms.filter((m) => m.linked_user_id);
        person = hint ?? (d.kind !== 'w2' && logins.length === 1 ? logins[0]!.id : null);
      }
      const targets = decision.automatic
        ? [d.kind === 'w2' ? { employerId: decision.targetId } : { accountId: decision.targetId }]
        : [];
      const where = await this.forms.place(trx, ctx, d.kind, targets, person);
      const copyOf =
        d.kindKnown && Object.keys(d.boxes).length
          ? await this.copyOf(trx, ctx, d, where.personMemberId, batch)
          : null;
      const replaces =
        d.corrected && !copyOf ? await this.corrects(trx, ctx, d, where.personMemberId, batch) : null;
      const reason =
        !d.kindKnown || Object.keys(d.boxes).length === 0
          ? 'unread'
          : copyOf
            ? 'probable_copy'
            : conflict
              ? 'person_conflict'
              : null;
      const info: StoredReadingInfo = {
        fileNames: prior?.fileNames ?? [],
        kindKnown: d.kindKnown,
        boxesRead: Object.keys(d.boxes).length > 0,
        problem: d.problem,
        droppedBoxes: d.droppedBoxes,
        confirmedBy: null,
        match: {
          automatic: decision.automatic,
          reason: decision.reason,
          candidates: decision.candidates.map((c): TaxFormCandidateDto => ({
            employerId: d.kind === 'w2' ? c.id : null,
            accountId: d.kind === 'w2' ? null : c.id,
            name: c.name,
            reason: c.reason,
          })),
        },
        copyOfId: copyOf,
        signal,
      };
      // Boxes as read are checked once more against the kind before they're stored.
      const boxes = Object.keys(d.boxes).length ? safeBoxes(d.kind, d.boxes) : {};
      const values = {
        entity_id: where.entityId,
        tax_year: d.taxYear,
        kind: d.kind,
        corrected: d.corrected,
        supersedes_id: replaces,
        issuer_name: d.issuerName,
        issuer_ein: d.ids.issuerEin,
        issuer_tin_last4: d.ids.issuerEin ? null : d.ids.issuerTinLast4,
        person_tin_last4: d.ids.personTinLast4,
        account_last4: d.kind === 'w2' ? null : d.ids.accountLast4,
        person_member_id: where.personMemberId,
        boxes: JSON.stringify(boxes),
        pages: d.pages.length ? d.pages : null,
        status: 'review' as const,
        reason,
        // What was read, kept until the reading is confirmed (§3): the boxes as read, never the text.
        reading: JSON.stringify({ boxes, droppedBoxes: d.droppedBoxes }),
        detected: JSON.stringify(info),
      };
      if (i === 0) {
        await trx
          .updateTable('app.tax_form')
          .set(values)
          .where('workspace_id', '=', ctx.workspaceId)
          .where('id', '=', id)
          .execute();
      } else {
        await trx
          .insertInto('app.tax_form')
          .values({
            ...values,
            workspace_id: ctx.workspaceId,
            id,
            source: form.source,
            file_ids: form.file_ids,
            sha256: form.sha256,
            job_id: form.job_id,
            created_by: form.created_by,
          })
          .execute();
      }
      await this.forms.writeTargets(trx, ctx, id, where.targets);
      if (replaces) await this.forms.supersede(trx, ctx, replaces);
      await this.forms.settleRead(trx, ctx, id);
    }
    return batch;
  }

  /** The member the person's last four digits were confirmed for before (once is enough: they're the household's). */
  private async learnedPerson(
    trx: Trx,
    ctx: Ctx,
    tin4: string | null,
    members: readonly { id: string }[],
  ): Promise<string | null> {
    if (!tin4) return null;
    const hash = await this.crypto.keyedHash(trx, ctx.workspaceId, 'tax_person', tin4);
    const m = await readMemory(trx, ctx, 'tax_person', `tin4:${hash}`);
    return m && m.confirmations >= 1 && members.some((x) => x.id === m.target_id) ? m.target_id : null;
  }

  /**
   * The employers or accounts a form could be from (§4), as the uploader sees them: a W-2's employers (of type
   * `employer`), a 1099's accounts outside liabilities, a 1098's mortgages with a loan schedule. `active` is pay,
   * interest, dividends or mortgage interest in the year. An archived one counts when it was active that year.
   */
  private async candidates(
    trx: Trx,
    ctx: Ctx,
    kind: TaxFormKind,
    year: number,
    role: MemberRole | null,
  ): Promise<TaxIssuerCandidate[]> {
    const activity = await expectedInputs(trx, ctx, year);
    if (kind === 'w2') {
      // Accountants don't match a W-2 to an employer, by hand or automatically (an owner's decision).
      if (role && !W2_EMPLOYER_MATCHERS.includes(role)) return [];
      const employers = await trx
        .selectFrom('app.employer')
        .select(['id', 'name', 'member_id', 'archived_at'])
        .where('workspace_id', '=', ctx.workspaceId)
        .where('type', '=', 'employer')
        .execute();
      const paid = new Map(activity.employers.map((e) => [e.id, e.payslips]));
      return employers
        .filter((e) => !e.archived_at || (paid.get(e.id) ?? 0) > 0)
        .map((e) => ({
          id: e.id,
          name: e.name,
          memberId: e.member_id,
          last4: null,
          institution: null,
          active: (paid.get(e.id) ?? 0) > 0,
        }));
    }
    const accounts = await trx
      .selectFrom('app.bank_account as b')
      .innerJoin('app.ledger_account as a', (j) =>
        j.onRef('a.workspace_id', '=', 'b.workspace_id').onRef('a.id', '=', 'b.ledger_account_id'),
      )
      .select([
        'a.id',
        'a.name',
        'a.type',
        'a.archived_at',
        'b.kind',
        'b.last4',
        'b.institution',
        'b.default_member_id',
      ])
      .where('b.workspace_id', '=', ctx.workspaceId)
      .$if(kind === '1098', (q) =>
        q
          .where('b.kind', '=', 'mortgage')
          .where(({ exists, selectFrom }) =>
            exists(
              selectFrom('app.loan_schedule as l')
                .select('l.id')
                .whereRef('l.workspace_id', '=', 'b.workspace_id')
                .whereRef('l.loan_account_id', '=', 'b.ledger_account_id'),
            ),
          ),
      )
      .$if(kind !== '1098', (q) => q.where('a.type', '=', 'asset'))
      .execute();
    const income = new Map(activity.accounts.map((a) => [a.id, a]));
    return accounts
      .map((a) => {
        const x = income.get(a.id);
        const active =
          kind === '1099_int'
            ? (x?.interest ?? 0n) > 0n
            : kind === '1099_div'
              ? (x?.dividends ?? 0n) > 0n
              : (x?.mortgageInterest ?? 0n) > 0n;
        return { a, active };
      })
      .filter(({ a, active }) => !a.archived_at || active)
      .map(({ a, active }) => ({
        id: a.id,
        name: a.name,
        memberId: a.default_member_id,
        last4: a.last4,
        institution: a.institution,
        active,
      }));
  }

  /** A form already received with the same kind, year, issuer, person and boxes (§6): this one is a probable copy. */
  private async copyOf(
    trx: Trx,
    ctx: Ctx,
    d: Draft,
    person: string | null,
    batch: string[],
  ): Promise<string | null> {
    const same = await this.sameForms(trx, ctx, d, person, batch);
    const boxes = JSON.stringify(safeBoxes(d.kind, d.boxes));
    return same.find((f) => JSON.stringify(f.boxes) === boxes)?.id ?? null;
  }

  /** The form a corrected one replaces (§6): the latest of the same kind, year, issuer and person, still standing. */
  private async corrects(
    trx: Trx,
    ctx: Ctx,
    d: Draft,
    person: string | null,
    batch: string[],
  ): Promise<string | null> {
    const same = await this.sameForms(trx, ctx, d, person, batch);
    return same.find((f) => f.status !== 'dismissed')?.id ?? null;
  }

  private async sameForms(trx: Trx, ctx: Ctx, d: Draft, person: string | null, batch: string[]) {
    const rows = await trx
      .selectFrom('app.tax_form')
      .select(['id', 'boxes', 'status', 'issuer_ein', 'issuer_name', 'person_member_id', 'person_tin_last4'])
      .where('workspace_id', '=', ctx.workspaceId)
      .where('kind', '=', d.kind)
      .where('tax_year', '=', d.taxYear)
      .where('deleted_at', 'is', null)
      .where('status', 'not in', ['superseded', 'reading'])
      .where('id', 'not in', batch)
      .orderBy('created_at', 'desc')
      .execute();
    return rows.filter((f) => {
      const issuer =
        f.issuer_ein && d.ids.issuerEin
          ? f.issuer_ein === d.ids.issuerEin
          : issuerNamesAgree(f.issuer_name, d.issuerName);
      const who =
        f.person_member_id && person
          ? f.person_member_id === person
          : f.person_tin_last4 && d.ids.personTinLast4
            ? f.person_tin_last4 === d.ids.personTinLast4
            : !f.person_member_id && !person;
      return issuer && who;
    });
  }
}

/** Boxes valid for the kind; anything the domain refuses is left out whole (the gateway checked them already). */
function safeBoxes(kind: TaxFormKind, boxes: Record<string, unknown>): Record<string, unknown> {
  try {
    parseTaxFormBoxes(kind, boxes);
    return boxes;
  } catch {
    return {};
  }
}
