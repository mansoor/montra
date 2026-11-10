/**
 * Employers and payslips (PAY-01..05, PAY-07, PAY-09; design 04 §14, ADR-0016). A payslip is a draft until the user
 * confirms it; confirming posts one restricted journal entry to a transaction that states only the bank fact (net
 * pay into the account), taking over the imported deposit when there is one, so it isn't counted twice.
 */
import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { newId, type EmployerRow, type PayslipRow, type Trx } from '@montra/db';
import {
  addDays,
  asCurrencyCode,
  buildPayslipDepositEntries,
  buildPayslipEntry,
  calendarDate,
  medianMinor,
  payslipTotals,
  SAVINGS_CODES,
  EMPLOYER_PLAN_ROUTES,
  employerPosted,
  PAYSLIP_PLAN_ROUTES,
  routeToPlan,
  type PlanType,
  type JournalEntryDraft,
  type PayslipPostingLine,
} from '@montra/domain';
import type {
  ConfirmPayslipRequest,
  CreateEmployerRequest,
  CreatePayslipRequest,
  DepositCandidateDto,
  DepositSplitInput,
  EmployerDto,
  PayslipDto,
  PayslipLineInput,
  UpdateEmployerRequest,
  UpdatePayslipRequest,
} from '@montra/schemas';
import { AiService, aiUnavailableWarning } from '../ai/ai.service.js';
import { payeeKeyOf } from '../categorization/categorizer.service.js';
import { AppError, notFound, unprocessable } from '../common/errors.js';
import { Db } from '../db/database.js';
import { JobQueue } from '../jobs/queue.js';
import { detectReceiptMedia } from '../receipts/receipts.service.js';
import { STORAGE_PORT, storageKey, type StoragePort } from '../storage/storage.js';
import { NOT_OWNED, TransactionPoster, type TransactionSpec } from '../transactions/poster.js';

type Ctx = { workspaceId: string; userId: string };

/** Payslips are kept as long as receipts: long enough for a tax question. */
const RETENTION_YEARS = 7;
/** PAY-04: a deposit is this pay within this many days of the pay date, for exactly the amount expected. */
const MATCH_DAYS = 3;
const PAYROLL_GROUP = 'Payroll taxes and deductions';

/** Where deductions post by default: a category in the payroll group, named for its code. */
const CATEGORY_NAMES: Record<string, string> = {
  fed_tax: 'Federal income tax',
  state_tax: 'State income tax',
  local_tax: 'Local income tax',
  social_security: 'Social Security',
  medicare: 'Medicare',
  health: 'Health insurance',
  dental: 'Dental insurance',
  vision: 'Vision insurance',
  union_dues: 'Union dues',
  loan: 'Payroll loan repayment',
};
const OTHER_DEDUCTION = 'Other payroll deductions';

export type EmployerUpdate = UpdateEmployerRequest;

@Injectable()
export class PayslipsService {
  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(STORAGE_PORT) private readonly storage: StoragePort,
    @Inject(JobQueue) private readonly queue: JobQueue,
    @Inject(AiService) private readonly ai: AiService,
    @Inject(TransactionPoster) private readonly poster: TransactionPoster,
  ) {}

  // ----- Employers (PAY-01) ------------------------------------------------------------------------------

  async createEmployer(ctx: Ctx, req: CreateEmployerRequest): Promise<EmployerDto> {
    return this.db.run(ctx, async (trx) => {
      const entityId = req.entityId ?? (await this.personalEntity(trx, ctx));
      await this.checkDepositAccount(trx, ctx, entityId, req.depositAccountId);
      await this.checkDeposits(trx, ctx, entityId, req.depositAccountId, req.deposits);
      const row = await trx
        .insertInto('app.employer')
        .values({
          workspace_id: ctx.workspaceId,
          entity_id: entityId,
          member_id: req.memberId,
          name: req.name,
          type: req.type,
          pay_frequency: req.payFrequency,
          deposit_account_id: req.depositAccountId,
          payee_key: payeeKeyOf(req.payee || req.name),
          created_by: ctx.userId,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await this.writeEmployerDeposits(trx, ctx, row.id, req.deposits);
      return this.employerDto(row, null, req.deposits);
    });
  }

  async listEmployers(ctx: Ctx, memberId?: string): Promise<EmployerDto[]> {
    return this.db.run(ctx, async (trx) => {
      const rows = await trx
        .selectFrom('app.employer')
        .selectAll()
        .where('workspace_id', '=', ctx.workspaceId)
        .$if(!!memberId, (q) => q.where('member_id', '=', memberId!))
        .orderBy('archived_at', (ob) => ob.nullsFirst())
        .orderBy('name')
        .execute();
      const last = await trx
        .selectFrom('app.payslip')
        .select(['employer_id', (eb) => eb.fn.max('pay_date').as('d')])
        .where('workspace_id', '=', ctx.workspaceId)
        .where('status', '=', 'posted')
        .groupBy('employer_id')
        .execute();
      const byEmployer = new Map(last.map((l) => [l.employer_id, l.d ? String(l.d) : null]));
      const plans = await trx
        .selectFrom('app.employer_deposit')
        .select(['employer_id', 'account_id', 'amount_minor'])
        .where('workspace_id', '=', ctx.workspaceId)
        .orderBy('sort_order')
        .execute();
      return rows.map((r) =>
        this.employerDto(
          r,
          byEmployer.get(r.id) ?? null,
          plans
            .filter((d) => d.employer_id === r.id)
            .map((d) => ({ accountId: d.account_id, amount: String(d.amount_minor) })),
        ),
      );
    });
  }

  async updateEmployer(ctx: Ctx, id: string, req: EmployerUpdate): Promise<EmployerDto> {
    return this.db.run(ctx, async (trx) => {
      const cur = await this.employer(trx, ctx, id);
      if (req.depositAccountId) await this.checkDepositAccount(trx, ctx, cur.entity_id, req.depositAccountId);
      const plan = req.deposits ?? (await this.employerPlan(trx, ctx, id));
      await this.checkDeposits(trx, ctx, cur.entity_id, req.depositAccountId ?? cur.deposit_account_id, plan);
      const row = await trx
        .updateTable('app.employer')
        .set({
          updated_at: new Date(),
          ...(req.name !== undefined ? { name: req.name } : {}),
          ...(req.type !== undefined ? { type: req.type } : {}),
          ...(req.payFrequency !== undefined ? { pay_frequency: req.payFrequency } : {}),
          ...(req.depositAccountId !== undefined ? { deposit_account_id: req.depositAccountId } : {}),
          ...(req.payee !== undefined ? { payee_key: req.payee ? payeeKeyOf(req.payee) : null } : {}),
          ...(req.retirementAccountId !== undefined
            ? { retirement_account_id: req.retirementAccountId }
            : {}),
          ...(req.archived !== undefined ? { archived_at: req.archived ? new Date() : null } : {}),
        })
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', id)
        .where('version', '=', BigInt(req.version))
        .returningAll()
        .executeTakeFirst();
      if (!row) throw conflict();
      if (req.deposits) await this.writeEmployerDeposits(trx, ctx, id, req.deposits);
      return this.employerDto(row, null, plan);
    });
  }

  private async employerPlan(trx: Trx, ctx: Ctx, employerId: string): Promise<DepositSplitInput[]> {
    const rows = await trx
      .selectFrom('app.employer_deposit')
      .select(['account_id', 'amount_minor'])
      .where('workspace_id', '=', ctx.workspaceId)
      .where('employer_id', '=', employerId)
      .orderBy('sort_order')
      .execute();
    return rows.map((d) => ({ accountId: d.account_id, amount: String(d.amount_minor) }));
  }

  private async writeEmployerDeposits(
    trx: Trx,
    ctx: Ctx,
    employerId: string,
    deposits: readonly DepositSplitInput[],
  ): Promise<void> {
    await trx
      .deleteFrom('app.employer_deposit')
      .where('workspace_id', '=', ctx.workspaceId)
      .where('employer_id', '=', employerId)
      .execute();
    if (!deposits.length) return;
    await trx
      .insertInto('app.employer_deposit')
      .values(
        deposits.map((d, i) => ({
          workspace_id: ctx.workspaceId,
          employer_id: employerId,
          account_id: d.accountId,
          amount_minor: BigInt(d.amount),
          sort_order: i,
        })),
      )
      .execute();
  }

  private async writePayslipDeposits(
    trx: Trx,
    ctx: Ctx,
    payslipId: string,
    deposits: readonly DepositSplitInput[],
  ): Promise<void> {
    await trx
      .deleteFrom('app.payslip_deposit')
      .where('workspace_id', '=', ctx.workspaceId)
      .where('payslip_id', '=', payslipId)
      .execute();
    if (!deposits.length) return;
    await trx
      .insertInto('app.payslip_deposit')
      .values(
        deposits.map((d, i) => ({
          workspace_id: ctx.workspaceId,
          payslip_id: payslipId,
          account_id: d.accountId,
          amount_minor: BigInt(d.amount),
          sort_order: i,
        })),
      )
      .execute();
  }

  private depositsOf(trx: Trx, ctx: Ctx, payslipId: string) {
    return trx
      .selectFrom('app.payslip_deposit')
      .selectAll()
      .where('workspace_id', '=', ctx.workspaceId)
      .where('payslip_id', '=', payslipId)
      .orderBy('sort_order')
      .execute();
  }

  /** A split goes to other bank accounts in the same books and currency, and never to the account that gets the rest. */
  private async checkDeposits(
    trx: Trx,
    ctx: Ctx,
    entityId: string,
    mainAccountId: string,
    deposits: readonly DepositSplitInput[],
  ): Promise<void> {
    if (!deposits.length) return;
    const entity = await trx
      .selectFrom('app.entity')
      .select('functional_currency')
      .where('workspace_id', '=', ctx.workspaceId)
      .where('id', '=', entityId)
      .executeTakeFirstOrThrow();
    for (const d of deposits) {
      if (d.accountId === mainAccountId) {
        throw unprocessable(
          'payslip.deposit_main',
          'The main account gets the rest, so it can’t be in the split too',
        );
      }
      await this.checkDepositAccount(trx, ctx, entityId, d.accountId);
      const account = await trx
        .selectFrom('app.ledger_account')
        .select('currency')
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', d.accountId)
        .executeTakeFirstOrThrow();
      if (account.currency !== entity.functional_currency) {
        throw unprocessable(
          'payslip.deposit_currency',
          'A split can only go to accounts in the same currency as the pay',
        );
      }
    }
  }

  private employerDto(
    r: EmployerRow,
    lastPayDate: string | null,
    deposits: readonly DepositSplitInput[] = [],
  ): EmployerDto {
    return {
      id: r.id,
      entityId: r.entity_id,
      memberId: r.member_id,
      name: r.name,
      type: r.type,
      payFrequency: r.pay_frequency,
      depositAccountId: r.deposit_account_id,
      deposits: deposits.map((d) => ({ accountId: d.accountId, amount: d.amount })),
      payee: r.payee_key,
      retirementAccountId: r.retirement_account_id,
      archived: r.archived_at !== null,
      lastPayDate: lastPayDate ? calendarDate(lastPayDate) : null,
      version: Number(r.version),
    };
  }

  private async employer(trx: Trx, ctx: Ctx, id: string): Promise<EmployerRow> {
    const row = await trx
      .selectFrom('app.employer')
      .selectAll()
      .where('workspace_id', '=', ctx.workspaceId)
      .where('id', '=', id)
      .executeTakeFirst();
    if (!row) throw notFound('Employer');
    return row;
  }

  private async personalEntity(trx: Trx, ctx: Ctx): Promise<string> {
    const e = await trx
      .selectFrom('app.entity')
      .select('id')
      .where('workspace_id', '=', ctx.workspaceId)
      .where('type', '=', 'personal')
      .executeTakeFirst();
    if (!e) throw notFound('Entity');
    return e.id;
  }

  private async checkDepositAccount(trx: Trx, ctx: Ctx, entityId: string, accountId: string) {
    const ok = await trx
      .selectFrom('app.bank_account as b')
      .innerJoin('app.ledger_account as a', 'a.id', 'b.ledger_account_id')
      .select('a.id')
      .where('a.workspace_id', '=', ctx.workspaceId)
      .where('a.entity_id', '=', entityId)
      .where('a.id', '=', accountId)
      .where('a.type', '=', 'asset')
      .executeTakeFirst();
    if (!ok) throw unprocessable('employer.account', 'Pay lands in a bank account of the same books');
  }

  // ----- Files (PAY-03, PAY-09): only reachable through a payslip the caller can read ---------------------

  async uploadFile(ctx: Ctx, bytes: Uint8Array, fileName: string) {
    const mediaType = detectReceiptMedia(bytes);
    if (!mediaType) {
      throw new AppError(415, 'payslip.unsupported_type', 'Upload a PDF, or a JPEG, PNG or WebP photo');
    }
    const id = newId();
    const digest = createHash('sha256').update(bytes).digest('hex');
    const key = storageKey(ctx.workspaceId, 'payslip', id);
    await this.storage.put(key, bytes, mediaType);
    await this.db.run(ctx, (trx) =>
      trx
        .insertInto('app.file')
        .values({
          workspace_id: ctx.workspaceId,
          id,
          kind: 'payslip',
          storage_key: key,
          file_name: fileName.replace(/[\\/\0]/g, '_').slice(0, 255) || 'payslip',
          mime: mediaType,
          bytes: bytes.length,
          sha256: digest,
          uploaded_by: ctx.userId,
          retain_until: sql<string>`(current_date + make_interval(years => ${RETENTION_YEARS}))::date`,
        })
        .execute(),
    );
    return { fileId: id, mediaType, bytes: bytes.length };
  }

  async file(ctx: Ctx, payslipId: string, fileId: string): Promise<{ bytes: Uint8Array; mime: string }> {
    const f = await this.db.run(ctx, async (trx) => {
      const p = await this.row(trx, ctx, payslipId);
      if (!p.attachment_ids.includes(fileId)) throw notFound('File');
      return trx
        .selectFrom('app.file')
        .select(['storage_key', 'mime'])
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', fileId)
        .executeTakeFirstOrThrow();
    });
    return { bytes: await this.storage.get(f.storage_key), mime: f.mime };
  }

  // ----- Drafts ---------------------------------------------------------------------------------------------

  async create(ctx: Ctx, req: CreatePayslipRequest): Promise<PayslipDto> {
    return this.db.run(ctx, async (trx) => {
      const employer = await this.employer(trx, ctx, req.employerId);
      const entity = await trx
        .selectFrom('app.entity')
        .select('functional_currency')
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', employer.entity_id)
        .executeTakeFirstOrThrow();
      if (req.fileIds.length) await this.checkFiles(trx, ctx, req.fileIds);
      const last = req.fromLast ? await this.lastPosted(trx, ctx, employer.id) : null;
      const row = await trx
        .insertInto('app.payslip')
        .values({
          workspace_id: ctx.workspaceId,
          entity_id: employer.entity_id,
          employer_id: employer.id,
          member_id: employer.member_id,
          status: req.fileIds.length ? 'processing' : 'needs_review',
          pay_date: req.payDate ?? null,
          currency: entity.functional_currency,
          attachment_ids: req.fileIds,
          gross_minor: last ? last.gross_minor : 0n,
          net_minor: last ? last.net_minor : 0n,
          extraction: last
            ? JSON.stringify({ warnings: ['Filled in from your last payslip: check the amounts'] })
            : null,
          created_by: ctx.userId,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await this.writePayslipDeposits(trx, ctx, row.id, await this.employerPlan(trx, ctx, employer.id));
      if (last) {
        const lines = await this.linesOf(trx, ctx, last.id);
        await this.writeLines(
          trx,
          ctx,
          row.id,
          lines.map((l) => ({
            section: l.section,
            code: l.code,
            label: l.label,
            amount: String(l.amount_minor),
            ytd: null,
            accountId: l.ledger_account_id,
          })),
        );
      }
      if (req.fileIds.length) await this.startExtraction(trx, ctx, row.id, req.fileIds);
      return this.dto(trx, ctx, row);
    });
  }

  private async checkFiles(trx: Trx, ctx: Ctx, ids: string[]) {
    const files = await trx
      .selectFrom('app.file')
      .select(['id', 'kind'])
      .where('workspace_id', '=', ctx.workspaceId)
      .where('id', 'in', ids)
      .where('deleted_at', 'is', null)
      .execute();
    if (files.length !== new Set(ids).size || files.some((f) => f.kind !== 'payslip')) {
      throw unprocessable('payslip.files_not_found', 'Upload the payslip files first (POST /payslips/files)');
    }
  }

  /**
   * Images go to the provider only with "Allow documents" on, in builtin or BYOK mode (PAY-09). Otherwise the
   * doc-worker reads them here and only masked text goes out. With AI off, the user fills it in.
   */
  private async startExtraction(trx: Trx, ctx: Ctx, payslipId: string, fileIds: string[]) {
    const runtime = await this.ai.runtime(trx, ctx, { type: 'payslip', id: payslipId });
    const extract = { workspaceId: ctx.workspaceId, payslipId };
    if (!runtime.available) {
      await trx
        .updateTable('app.payslip')
        .set({
          status: 'needs_review',
          extraction: JSON.stringify({
            mode: runtime.mode,
            warnings: [aiUnavailableWarning(runtime, 'enter the payslip yourself')],
          }),
        })
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', payslipId)
        .execute();
      return;
    }
    const imagesAllowed =
      (runtime.mode === 'builtin' || runtime.mode === 'byok') && runtime.allowDocumentsToLlm;
    if (imagesAllowed) {
      await this.queue.enqueue(trx, { ...ctx, queue: 'ai', type: 'payslip.extract', payload: extract });
      return;
    }
    const files = await trx
      .selectFrom('app.file')
      .select(['id', 'storage_key'])
      .where('workspace_id', '=', ctx.workspaceId)
      .where('id', 'in', fileIds)
      .execute();
    const byId = new Map(files.map((f) => [f.id, f.storage_key]));
    await this.queue.enqueue(trx, {
      ...ctx,
      queue: 'doc',
      type: 'receipt.ocr',
      payload: { workspaceId: ctx.workspaceId, storageKeys: fileIds.map((id) => byId.get(id)!) },
      then: { queue: 'ai', type: 'payslip.extract', payload: extract },
    });
  }

  async list(
    ctx: Ctx,
    opts: { memberId?: string; employerId?: string; status?: string },
  ): Promise<PayslipDto[]> {
    return this.db.run(ctx, async (trx) => {
      const rows = await trx
        .selectFrom('app.payslip')
        .selectAll()
        .where('workspace_id', '=', ctx.workspaceId)
        .$if(!!opts.memberId, (q) => q.where('member_id', '=', opts.memberId!))
        .$if(!!opts.employerId, (q) => q.where('employer_id', '=', opts.employerId!))
        .$if(!!opts.status, (q) => q.where('status', '=', opts.status as 'posted'))
        .orderBy('pay_date', (ob) => ob.desc().nullsFirst())
        .orderBy('created_at', 'desc')
        .limit(200)
        .execute();
      return Promise.all(rows.map((r) => this.dto(trx, ctx, r)));
    });
  }

  async get(ctx: Ctx, id: string): Promise<PayslipDto> {
    return this.db.run(ctx, async (trx) => this.dto(trx, ctx, await this.row(trx, ctx, id)));
  }

  /** PATCH: what the user checks. A posted payslip re-posts in the same transaction. */
  async update(ctx: Ctx, id: string, req: UpdatePayslipRequest): Promise<PayslipDto> {
    return this.db.run(ctx, async (trx) => {
      const cur = await this.row(trx, ctx, id);
      if (cur.status === 'rejected') throw unprocessable('payslip.rejected', 'This payslip was rejected');
      const set = {
        ...(req.payDate !== undefined ? { pay_date: req.payDate } : {}),
        ...(req.periodStart !== undefined ? { period_start: req.periodStart } : {}),
        ...(req.periodEnd !== undefined ? { period_end: req.periodEnd } : {}),
        ...(req.net !== undefined ? { net_minor: req.net } : {}),
      };
      if (req.lines) await this.writeLines(trx, ctx, id, req.lines);
      if (req.deposits) {
        // Each is its own transaction by then, perhaps a statement line already taken over.
        if (cur.status === 'posted') {
          throw unprocessable(
            'payslip.deposits_posted',
            'Delete this payslip and enter it again to change where the pay went',
          );
        }
        const employer = await this.employer(trx, ctx, cur.employer_id);
        await this.checkDeposits(trx, ctx, cur.entity_id, employer.deposit_account_id, req.deposits);
        await this.writePayslipDeposits(trx, ctx, id, req.deposits);
      }
      const lines = await this.linesOf(trx, ctx, id);
      const gross = payslipTotals(lines.map(toAmount)).gross;
      const row = await trx
        .updateTable('app.payslip')
        .set({
          ...set,
          gross_minor: gross,
          status: cur.status === 'processing' ? 'needs_review' : cur.status,
          match_candidates: null,
        })
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', id)
        .where('version', '=', BigInt(req.version))
        .returningAll()
        .executeTakeFirst();
      if (!row) throw conflict();
      if (row.status === 'posted') await this.repostPosted(trx, ctx, row);
      return this.dto(trx, ctx, row);
    });
  }

  async writeLines(trx: Trx, ctx: Ctx, payslipId: string, lines: readonly PayslipLineInput[]): Promise<void> {
    await trx
      .deleteFrom('app.payslip_line')
      .where('workspace_id', '=', ctx.workspaceId)
      .where('payslip_id', '=', payslipId)
      .execute();
    if (!lines.length) return;
    await trx
      .insertInto('app.payslip_line')
      .values(
        lines.map((l, i) => ({
          workspace_id: ctx.workspaceId,
          payslip_id: payslipId,
          line_no: i + 1,
          section: l.section,
          code: l.code,
          label: l.label,
          amount_minor: l.amount,
          ytd_minor: l.ytd ?? null,
          ledger_account_id: l.accountId ?? null,
        })),
      )
      .execute();
  }

  // ----- Confirm: post, take over the deposit, update the income pattern ------------------------------------

  /**
   * Posts the payslip (PAY-05). With one candidate deposit it takes it over (PAY-04). With several it posts nothing
   * and returns them, so the user chooses and confirms again; a null choice means none of them. With a split (ADR-0022)
   * each account goes through this separately: its own deposit, its own transaction.
   */
  async confirm(ctx: Ctx, id: string, req: ConfirmPayslipRequest): Promise<PayslipDto> {
    return this.db.run(ctx, async (trx) => {
      const p = await this.row(trx, ctx, id);
      if (p.status === 'posted') return this.dto(trx, ctx, p);
      if (p.status === 'rejected') throw unprocessable('payslip.rejected', 'This payslip was rejected');
      if (BigInt(p.version) !== BigInt(req.version)) throw conflict();
      if (!p.pay_date) throw unprocessable('payslip.no_date', 'Enter the pay date first');
      const employer = await this.employer(trx, ctx, p.employer_id);
      const others = await this.depositsOf(trx, ctx, id);
      const main = this.mainAmount(p, others);

      const targets = [
        { accountId: employer.deposit_account_id, amount: main, choice: req.depositTransactionId },
        ...others.map((d) => ({
          accountId: d.account_id,
          amount: BigInt(d.amount_minor),
          choice: req.otherDeposits?.find((o) => o.accountId === d.account_id)?.transactionId,
        })),
      ];
      const chosen = new Map<string, string | null>();
      const asks: DepositCandidateDto[] = [];
      for (const target of targets) {
        if (target.choice !== undefined) {
          chosen.set(target.accountId, target.choice);
          continue;
        }
        const candidates = await this.depositCandidates(trx, ctx, p, target.accountId, target.amount);
        if (candidates.length > 1) asks.push(...candidates);
        else chosen.set(target.accountId, candidates[0]?.transactionId ?? null);
      }
      if (asks.length > 0) {
        const row = await trx
          .updateTable('app.payslip')
          .set({ match_candidates: JSON.stringify(asks) })
          .where('workspace_id', '=', ctx.workspaceId)
          .where('id', '=', id)
          .returningAll()
          .executeTakeFirstOrThrow();
        return this.dto(trx, ctx, row);
      }

      const posted = await this.postDeposit(trx, ctx, p, employer, {
        accountId: employer.deposit_account_id,
        amount: main,
        existing: chosen.get(employer.deposit_account_id) ?? null,
        entryAt: (date) => this.entryOf(trx, ctx, p, employer, date),
      });
      for (const d of others) {
        const done = await this.postDeposit(trx, ctx, p, employer, {
          accountId: d.account_id,
          amount: BigInt(d.amount_minor),
          existing: chosen.get(d.account_id) ?? null,
          entryAt: (date) => this.depositEntryOf(trx, ctx, p, employer, d.account_id, date),
        });
        await trx
          .updateTable('app.payslip_deposit')
          .set({
            transaction_id: done.transactionId,
            deposit_spec: done.depositSpec ? JSON.stringify(done.depositSpec) : null,
          })
          .where('workspace_id', '=', ctx.workspaceId)
          .where('id', '=', d.id)
          .execute();
      }
      const employerMoney = employerPosted(
        (await this.entryInput(trx, ctx, p, employer, calendarDate(p.pay_date!))).lines,
      );
      const row = await trx
        .updateTable('app.payslip')
        .set({
          status: 'posted',
          employer_posted_minor: employerMoney,
          transaction_id: posted.transactionId,
          deposit_spec: posted.depositSpec ? JSON.stringify(posted.depositSpec) : null,
          match_candidates: null,
        })
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirstOrThrow();
      await this.updateIncomePattern(trx, ctx, row, employer);
      return this.dto(trx, ctx, row);
    });
  }

  /** What's left for the employer's own account. Something has to be, or there'd be no main transaction to hang the payslip on. */
  private mainAmount(p: PayslipRow, others: readonly { amount_minor: unknown }[]): bigint {
    const split = others.reduce((t, d) => t + BigInt(d.amount_minor as bigint), 0n);
    const main = BigInt(p.net_minor) - split;
    if (others.length > 0 && main <= 0n) {
      throw unprocessable(
        'payslip.deposits_too_big',
        'The split adds up to all of the net pay or more. It has to leave something for the main account',
      );
    }
    return main;
  }

  /** One deposit: takes over the imported line if there is one, keeping its date (DE-10), or adds its own transaction. */
  private async postDeposit(
    trx: Trx,
    ctx: Ctx,
    p: PayslipRow,
    employer: EmployerRow,
    target: {
      accountId: string;
      amount: bigint;
      existing: string | null;
      entryAt: (date: ReturnType<typeof calendarDate>) => Promise<JournalEntryDraft>;
    },
  ): Promise<{ transactionId: string; depositSpec: unknown }> {
    if (target.existing) {
      const t = await trx
        .selectFrom('app.transaction')
        .select(['spec', 'source', 'txn_date'])
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', target.existing)
        .executeTakeFirst();
      if (!t) throw notFound('Deposit');
      const taken = t.spec as unknown as { accountId?: string };
      if (taken.accountId !== target.accountId) {
        throw unprocessable('payslip.deposit_account', 'That deposit went to a different account');
      }
      const entry = await target.entryAt(calendarDate(String(t.txn_date)));
      await trx
        .updateTable('app.transaction')
        .set({
          spec: JSON.stringify(this.specOf(p, employer, entry, target.accountId, target.amount)),
          review_state: 'reviewed',
          categorization: null,
        })
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', target.existing)
        .execute();
      // A statement line stays cleared when the payslip takes it over (DE-08).
      await this.poster.repost(trx, ctx, target.existing, [entry], {
        ...(t.source === 'import' ? { clearedAccountId: target.accountId } : {}),
      });
      return { transactionId: target.existing, depositSpec: t.spec };
    }
    const transactionId = newId();
    const entry = await target.entryAt(calendarDate(p.pay_date!));
    await trx
      .insertInto('app.transaction')
      .values({
        workspace_id: ctx.workspaceId,
        id: transactionId,
        primary_entity_id: p.entity_id,
        txn_date: p.pay_date!,
        payee_raw: employer.name,
        payee_key: employer.payee_key,
        description: employer.name,
        status: 'posted',
        source: 'payslip',
        review_state: 'reviewed',
        spec: JSON.stringify(this.specOf(p, employer, entry, target.accountId, target.amount)),
        posted_at: new Date(),
        created_by: ctx.userId,
      })
      .execute();
    await this.poster.repost(trx, ctx, transactionId, [entry], { fresh: true });
    return { transactionId, depositSpec: null };
  }

  private async repostPosted(trx: Trx, ctx: Ctx, p: PayslipRow): Promise<void> {
    if (!p.transaction_id || !p.pay_date) return;
    const employer = await this.employer(trx, ctx, p.employer_id);
    const others = await this.depositsOf(trx, ctx, p.id);
    const repost = async (
      transactionId: string,
      taken: boolean,
      accountId: string,
      amount: bigint,
      entryAt: (date: ReturnType<typeof calendarDate>) => Promise<JournalEntryDraft>,
    ) => {
      const t = await trx
        .selectFrom('app.transaction')
        .select('txn_date')
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', transactionId)
        .executeTakeFirstOrThrow();
      // A taken-over deposit keeps the statement's date; a payslip's own transaction follows the pay date.
      const date = calendarDate(taken ? String(t.txn_date) : p.pay_date!);
      const entry = await entryAt(date);
      await trx
        .updateTable('app.transaction')
        .set({ spec: JSON.stringify(this.specOf(p, employer, entry, accountId, amount)), txn_date: date })
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', transactionId)
        .execute();
      await this.poster.repost(trx, ctx, transactionId, [entry]);
    };
    await repost(
      p.transaction_id,
      Boolean(p.deposit_spec),
      employer.deposit_account_id,
      this.mainAmount(p, others),
      (date) => this.entryOf(trx, ctx, p, employer, date),
    );
    for (const d of others) {
      if (!d.transaction_id) continue;
      await repost(d.transaction_id, Boolean(d.deposit_spec), d.account_id, BigInt(d.amount_minor), (date) =>
        this.depositEntryOf(trx, ctx, p, employer, d.account_id, date),
      );
    }
    await this.updateIncomePattern(trx, ctx, p, employer);
  }

  /** PAY-05's entry for this payslip. Refuses one that doesn't add up, or isn't in the books' currency. */
  private async entryOf(
    trx: Trx,
    ctx: Ctx,
    p: PayslipRow,
    employer: EmployerRow,
    date: ReturnType<typeof calendarDate>,
  ): Promise<JournalEntryDraft> {
    return buildPayslipEntry(await this.entryInput(trx, ctx, p, employer, date));
  }

  /** The entry for one other account in a split (ADR-0022). */
  private async depositEntryOf(
    trx: Trx,
    ctx: Ctx,
    p: PayslipRow,
    employer: EmployerRow,
    accountId: string,
    date: ReturnType<typeof calendarDate>,
  ): Promise<JournalEntryDraft> {
    const built = buildPayslipDepositEntries(await this.entryInput(trx, ctx, p, employer, date));
    return built.find((d) => d.accountId === accountId)!.entry;
  }

  private async entryInput(
    trx: Trx,
    ctx: Ctx,
    p: PayslipRow,
    employer: EmployerRow,
    date: ReturnType<typeof calendarDate>,
  ) {
    const lines = await this.linesOf(trx, ctx, p.id);
    if (!lines.some((l) => l.section === 'earning')) {
      throw unprocessable('payslip.no_earnings', 'Enter what was earned before confirming');
    }
    const entity = await trx
      .selectFrom('app.entity')
      .select('functional_currency')
      .where('workspace_id', '=', ctx.workspaceId)
      .where('id', '=', p.entity_id)
      .executeTakeFirstOrThrow();
    if (p.currency !== entity.functional_currency) {
      throw unprocessable('payslip.currency', 'Payslips in another currency are not supported yet');
    }
    const posting: PayslipPostingLine[] = [];
    for (const l of lines) {
      if (l.section === 'employer') {
        // Stays on the payslip unless an account takes the employer's contributions (ADR-0025).
        const into = await this.employerAccount(trx, ctx, employer, l.code);
        posting.push({
          ...toAmount(l),
          label: l.label,
          accountId: into ?? employer.deposit_account_id,
          ...(into
            ? { contraAccountId: await this.employerIncome(trx, ctx, employer.entity_id, p.currency) }
            : {}),
        });
        continue;
      }
      posting.push({
        ...toAmount(l),
        label: l.label,
        accountId: l.ledger_account_id ?? (await this.defaultAccount(trx, ctx, l, employer, p.currency)),
      });
    }
    const others = await this.depositsOf(trx, ctx, p.id);
    this.mainAmount(p, others);
    return {
      entityId: p.entity_id,
      currency: asCurrencyCode(p.currency),
      date,
      description: employer.name,
      memberId: p.member_id,
      depositAccountId: employer.deposit_account_id,
      net: BigInt(p.net_minor),
      lines: posting,
      otherDeposits: others.map((d) => ({ accountId: d.account_id, amount: BigInt(d.amount_minor) })),
    };
  }

  /** The transaction states only the bank fact (ADR-0016): anyone who can read the account can read this. */
  private specOf(
    p: PayslipRow,
    employer: EmployerRow,
    entry: JournalEntryDraft,
    accountId: string,
    amount: bigint,
  ): TransactionSpec {
    const income = entry.postings.find((x) => x.amount < 0n)?.accountId;
    if (!income) throw unprocessable('payslip.no_earnings', 'Enter what was earned before confirming');
    const value = String(amount);
    return {
      type: 'standard',
      accountId,
      amount: value,
      currency: p.currency,
      description: employer.name,
      memberId: p.member_id,
      uncategorized: false,
      splits: [{ accountId: income, amount: value, memberId: p.member_id }],
      payslipId: p.id,
      employerId: employer.id,
    };
  }

  /** PAY-04: exactly this amount, into this account, within ±3 days, and not already a payslip. */
  private async depositCandidates(
    trx: Trx,
    ctx: Ctx,
    p: PayslipRow,
    accountId: string,
    amount: bigint,
  ): Promise<DepositCandidateDto[]> {
    const date = calendarDate(p.pay_date!);
    const { rows } = await sql<{ id: string; d: string; payee: string | null; amount: string }>`
      select t.id, t.txn_date::text as d, coalesce(t.payee_raw, t.description) as payee, t.spec->>'amount' as amount
        from app.transaction t
       where t.workspace_id = ${ctx.workspaceId} and t.primary_entity_id = ${p.entity_id}
         and t.status = 'posted' and t.deleted_at is null and t.spec->>'type' = 'standard'
         and (t.spec->>'amount')::bigint > 0
         and t.txn_date between ${addDays(date, -MATCH_DAYS)} and ${addDays(date, MATCH_DAYS)}
         and t.spec->>'accountId' = ${accountId}
         and (t.spec->>'amount')::bigint = ${String(amount)}::bigint
         and ${NOT_OWNED}
       order by abs(t.txn_date - ${date}::date), t.id`.execute(trx);
    return rows.map((r) => ({
      accountId,
      transactionId: r.id,
      date: calendarDate(r.d),
      amount: r.amount,
      payee: r.payee,
    }));
  }

  /**
   * Taxes and non-savings deductions post to categories in a system group, kept out of budgets; retirement and
   * health savings to an investment account, so they count in net worth; earnings to Salary.
   */
  private async defaultAccount(
    trx: Trx,
    ctx: Ctx,
    line: { section: string; code: string; label: string },
    employer: EmployerRow,
    currency: string,
  ): Promise<string> {
    if (line.section === 'earning') return this.incomeCategory(trx, ctx, employer.entity_id, currency);
    if (SAVINGS_CODES.has(line.code)) {
      const plan = routeToPlan(PAYSLIP_PLAN_ROUTES[line.code], await this.planAccounts(trx, ctx, employer));
      return plan?.id ?? this.savingsAccount(trx, ctx, employer, currency);
    }
    return this.payrollCategory(trx, ctx, employer.entity_id, currency, line.code);
  }

  /** The investment accounts this employer's payslips pay into, by plan (ADR-0025). */
  private async planAccounts(trx: Trx, ctx: Ctx, employer: EmployerRow) {
    const rows = await trx
      .selectFrom('app.bank_account as b')
      .innerJoin('app.ledger_account as a', (j) =>
        j.onRef('a.workspace_id', '=', 'b.workspace_id').onRef('a.id', '=', 'b.ledger_account_id'),
      )
      .select(['a.id', 'b.plan_type', 'b.employer_contributions'])
      .where('b.workspace_id', '=', ctx.workspaceId)
      .where('b.employer_id', '=', employer.id)
      .where('a.archived_at', 'is', null)
      .orderBy('a.created_at')
      .execute();
    return rows.map((r) => ({
      id: r.id,
      planType: r.plan_type as PlanType | null,
      employerContributions: r.employer_contributions,
    }));
  }

  /** Where an employer contribution posts: an account of a fitting plan that takes them, or nowhere. */
  private async employerAccount(
    trx: Trx,
    ctx: Ctx,
    employer: EmployerRow,
    code: string,
  ): Promise<string | null> {
    const accounts = (await this.planAccounts(trx, ctx, employer)).filter((a) => a.employerContributions);
    return routeToPlan(EMPLOYER_PLAN_ROUTES[code], accounts)?.id ?? null;
  }

  /** The income an employer's contributions are credited to. Budgets leave it out of take-home pay (ADR-0025). */
  private async employerIncome(trx: Trx, ctx: Ctx, entityId: string, currency: string): Promise<string> {
    const existing = await trx
      .selectFrom('app.ledger_account')
      .select('id')
      .where('workspace_id', '=', ctx.workspaceId)
      .where('entity_id', '=', entityId)
      .where('subtype', '=', 'payroll:employer')
      .executeTakeFirst();
    if (existing) return existing.id;
    const id = newId();
    await trx
      .insertInto('app.ledger_account')
      .values({
        workspace_id: ctx.workspaceId,
        id,
        entity_id: entityId,
        type: 'income',
        subtype: 'payroll:employer',
        name: 'Employer contributions',
        currency,
        is_category: true,
      })
      .execute();
    return id;
  }

  private async incomeCategory(trx: Trx, ctx: Ctx, entityId: string, currency: string): Promise<string> {
    const all = await trx
      .selectFrom('app.ledger_account')
      .select(['id', 'name'])
      .where('workspace_id', '=', ctx.workspaceId)
      .where('entity_id', '=', entityId)
      .where('type', '=', 'income')
      .where('is_category', '=', true)
      .where('archived_at', 'is', null)
      .where('system_role', 'is', null)
      .execute();
    const salary = all.find((c) => c.name === 'Salary') ?? all[0];
    if (salary) return salary.id;
    const id = newId();
    await trx
      .insertInto('app.ledger_account')
      .values({
        workspace_id: ctx.workspaceId,
        id,
        entity_id: entityId,
        type: 'income',
        subtype: 'category',
        name: 'Salary',
        currency,
        is_category: true,
      })
      .execute();
    return id;
  }

  private async payrollCategory(
    trx: Trx,
    ctx: Ctx,
    entityId: string,
    currency: string,
    code: string,
  ): Promise<string> {
    const known = CATEGORY_NAMES[code] !== undefined;
    const subtype = `payroll:${known ? code : 'other'}`;
    const existing = await trx
      .selectFrom('app.ledger_account')
      .select('id')
      .where('workspace_id', '=', ctx.workspaceId)
      .where('entity_id', '=', entityId)
      .where('subtype', '=', subtype)
      .executeTakeFirst();
    if (existing) return existing.id;
    let group = await trx
      .selectFrom('app.category_group')
      .select('id')
      .where('workspace_id', '=', ctx.workspaceId)
      .where('entity_id', '=', entityId)
      .where('kind', '=', 'system')
      .where('name', '=', PAYROLL_GROUP)
      .executeTakeFirst();
    if (!group) {
      group = await trx
        .insertInto('app.category_group')
        .values({
          workspace_id: ctx.workspaceId,
          id: newId(),
          entity_id: entityId,
          name: PAYROLL_GROUP,
          kind: 'system',
          sort_order: 95,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
    }
    const id = newId();
    await trx
      .insertInto('app.ledger_account')
      .values({
        workspace_id: ctx.workspaceId,
        id,
        entity_id: entityId,
        type: 'expense',
        subtype,
        name: CATEGORY_NAMES[code] ?? OTHER_DEDUCTION,
        currency,
        is_category: true,
        category_group_id: group.id,
      })
      .execute();
    return id;
  }

  private async savingsAccount(trx: Trx, ctx: Ctx, employer: EmployerRow, currency: string): Promise<string> {
    if (employer.retirement_account_id) return employer.retirement_account_id;
    // The caller's copy can be older than this transaction: one payslip builds its entries more than once, and the
    // first build may already have made the account.
    const current = await trx
      .selectFrom('app.employer')
      .select('retirement_account_id')
      .where('workspace_id', '=', ctx.workspaceId)
      .where('id', '=', employer.id)
      .executeTakeFirst();
    if (current?.retirement_account_id) {
      employer.retirement_account_id = current.retirement_account_id;
      return current.retirement_account_id;
    }
    const id = newId();
    await trx
      .insertInto('app.ledger_account')
      .values({
        workspace_id: ctx.workspaceId,
        id,
        entity_id: employer.entity_id,
        type: 'asset',
        subtype: 'investment',
        name: `${employer.name} retirement`.slice(0, 200),
        currency,
      })
      .execute();
    await trx
      .insertInto('app.bank_account')
      .values({
        workspace_id: ctx.workspaceId,
        ledger_account_id: id,
        kind: 'investment',
        default_member_id: employer.member_id,
      })
      .execute();
    await trx
      .updateTable('app.employer')
      .set({ retirement_account_id: id })
      .where('workspace_id', '=', ctx.workspaceId)
      .where('id', '=', employer.id)
      .execute();
    employer.retirement_account_id = id;
    return id;
  }

  /**
   * PAY-07: one expected-income row per employer, at the median net of the last three payslips. It stays anchored on
   * the first pay date, because budgets walk every past period, and moving the anchor would rewrite their income.
   * A row the user already entered for this payer is adopted rather than doubled.
   */
  private async updateIncomePattern(trx: Trx, ctx: Ctx, p: PayslipRow, employer: EmployerRow): Promise<void> {
    const recent = await trx
      .selectFrom('app.payslip')
      .select('net_minor')
      .where('workspace_id', '=', ctx.workspaceId)
      .where('employer_id', '=', employer.id)
      .where('status', '=', 'posted')
      .orderBy('pay_date', 'desc')
      .limit(3)
      .execute();
    const amount = medianMinor(recent.map((r) => BigInt(r.net_minor)));
    if (amount <= 0n) return;
    const q = trx.selectFrom('app.expected_income').select('id').where('workspace_id', '=', ctx.workspaceId);
    const existing =
      (await q.where('employer_id', '=', employer.id).executeTakeFirst()) ??
      (employer.payee_key
        ? await q
            .where('entity_id', '=', employer.entity_id)
            .where('employer_id', 'is', null)
            .where('payee_key', '=', employer.payee_key)
            .executeTakeFirst()
        : undefined);
    if (existing) {
      await trx
        .updateTable('app.expected_income')
        .set({ amount_minor: amount, employer_id: employer.id, member_id: employer.member_id })
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', existing.id)
        .execute();
      return;
    }
    await trx
      .insertInto('app.expected_income')
      .values({
        workspace_id: ctx.workspaceId,
        entity_id: employer.entity_id,
        member_id: employer.member_id,
        employer_id: employer.id,
        name: employer.name,
        source_type: employer.type === 'employer' ? 'salary' : 'other',
        amount_minor: amount,
        currency: p.currency,
        cadence: employer.pay_frequency,
        next_date: p.pay_date!,
        account_id: employer.deposit_account_id,
        payee_key: employer.payee_key,
      })
      .execute();
  }

  // ----- Delete --------------------------------------------------------------------------------------------

  /** Removes the payslip. Whatever it took over goes back to being a plain deposit; otherwise its entries go too. */
  async remove(ctx: Ctx, id: string): Promise<void> {
    await this.db.run(ctx, async (trx) => {
      const p = await this.row(trx, ctx, id);
      const others = await this.depositsOf(trx, ctx, id);
      await trx
        .updateTable('app.payslip')
        .set({ transaction_id: null })
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', id)
        .execute();
      await trx
        .updateTable('app.payslip_deposit')
        .set({ transaction_id: null })
        .where('workspace_id', '=', ctx.workspaceId)
        .where('payslip_id', '=', id)
        .execute();
      const release = async (transactionId: string | null, spec: unknown) => {
        if (transactionId && spec) {
          await this.poster.restoreTaken(trx, ctx, transactionId, spec as unknown as TransactionSpec);
        } else if (transactionId) {
          await this.poster.unpost(trx, ctx, transactionId);
          await trx
            .updateTable('app.transaction')
            .set({ status: 'void', deleted_at: new Date() })
            .where('workspace_id', '=', ctx.workspaceId)
            .where('id', '=', transactionId)
            .execute();
        }
      };
      await release(p.transaction_id, p.deposit_spec);
      for (const d of others) await release(d.transaction_id, d.deposit_spec);
      await trx
        .deleteFrom('app.payslip')
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', id)
        .execute();
    });
  }

  // ----- Reading -------------------------------------------------------------------------------------------

  async row(trx: Trx, ctx: Ctx, id: string): Promise<PayslipRow> {
    const row = await trx
      .selectFrom('app.payslip')
      .selectAll()
      .where('workspace_id', '=', ctx.workspaceId)
      .where('id', '=', id)
      .executeTakeFirst();
    if (!row) throw notFound('Payslip');
    return row;
  }

  linesOf(trx: Trx, ctx: Ctx, id: string) {
    return trx
      .selectFrom('app.payslip_line')
      .selectAll()
      .where('workspace_id', '=', ctx.workspaceId)
      .where('payslip_id', '=', id)
      .orderBy('line_no')
      .execute();
  }

  private lastPosted(trx: Trx, ctx: Ctx, employerId: string) {
    return trx
      .selectFrom('app.payslip')
      .selectAll()
      .where('workspace_id', '=', ctx.workspaceId)
      .where('employer_id', '=', employerId)
      .where('status', '=', 'posted')
      .orderBy('pay_date', 'desc')
      .executeTakeFirst();
  }

  async dto(trx: Trx, ctx: Ctx, p: PayslipRow): Promise<PayslipDto> {
    const lines = await this.linesOf(trx, ctx, p.id);
    const totals = payslipTotals(lines.map(toAmount));
    const others = await this.depositsOf(trx, ctx, p.id);
    const split = others.reduce((t, d) => t + BigInt(d.amount_minor), 0n);
    const x = (p.extraction ?? null) as {
      provider?: string;
      model?: string;
      confidence?: number;
      warnings?: string[];
    } | null;
    return {
      id: p.id,
      entityId: p.entity_id,
      employerId: p.employer_id,
      memberId: p.member_id,
      status: p.status,
      payDate: p.pay_date ? calendarDate(String(p.pay_date)) : null,
      periodStart: p.period_start ? calendarDate(String(p.period_start)) : null,
      periodEnd: p.period_end ? calendarDate(String(p.period_end)) : null,
      currency: asCurrencyCode(p.currency),
      gross: String(p.gross_minor),
      net: String(p.net_minor),
      gap: String(totals.computedNet - BigInt(p.net_minor)),
      lines: lines.map((l) => ({
        id: l.id,
        lineNo: l.line_no,
        section: l.section,
        code: l.code,
        label: l.label,
        amount: String(l.amount_minor),
        ytd: l.ytd_minor !== null ? String(l.ytd_minor) : null,
        accountId: l.ledger_account_id,
      })),
      fileIds: p.attachment_ids,
      extraction: x
        ? {
            provider: x.provider ?? null,
            model: x.model ?? null,
            confidence: x.confidence ?? null,
            warnings: x.warnings ?? [],
          }
        : null,
      transactionId: p.transaction_id,
      matchedDeposit: p.deposit_spec !== null,
      // From before splits, a stored list has no accounts. Confirming again asks afresh.
      matchCandidates: ((p.match_candidates ?? []) as DepositCandidateDto[]).filter((c) => c.accountId),
      mainDeposit: String(BigInt(p.net_minor) - split),
      deposits: others.map((d) => ({
        accountId: d.account_id,
        amount: String(d.amount_minor),
        transactionId: d.transaction_id,
        matchedDeposit: d.deposit_spec !== null,
      })),
      version: Number(p.version),
    };
  }
}

const toAmount = (l: { section: string; code: string; amount_minor: unknown }) => ({
  section: l.section as PayslipPostingLine['section'],
  code: l.code,
  amount: BigInt(l.amount_minor as bigint),
});

const conflict = () =>
  new AppError(409, 'version.conflict', 'This payslip was changed by someone else; reload and try again');
