/**
 * Intake jobs (ADR-0051):
 *
 * - `intake.read`: a statement's signals and candidate accounts, from the doc-worker's reading (PDF, XLS, photo) or the
 *   file itself (CSV, XLSX, QIF, OFX). A learned signal starts the import straight away; one candidate is suggested;
 *   anything else waits in Review.
 * - `intake.settle`: after the import is parsed, commits it when it is clean, else puts the statement in Review.
 */
import { Inject, Injectable } from '@nestjs/common';
import type { Trx } from '@montra/db';
import {
  cleanImport,
  fileNameLast4,
  fileNamePattern,
  institutionKey,
  isLearned,
  ofxAccounts,
  readTextSheets,
  readXlsx,
  sheetFingerprint,
  statementSignal,
  type Sheet,
} from '@montra/importers';
import type { IntakeCandidateDto, IntakeReason } from '@montra/schemas';
import { Db } from '../db/database.js';
import { ImportsService } from '../imports/imports.service.js';
import { PermanentJobError, Worker, type Job } from '../jobs/queue.js';
import { STORAGE_PORT, type StoragePort } from '../storage/storage.js';
import { READ_JOB, SETTLE_JOB, type StoredDetected } from './intakes.service.js';
import { memoryState, readMemory } from './match-memory.js';

type Ctx = { workspaceId: string; userId: string };

/** How many recent accounts to offer when nothing identifies the account (as ADR-0048 §3). */
const RECENT_ACCOUNTS = 5;

interface Reading {
  kind?: string;
  sheets?: Sheet[];
  statement?: { accountLast4?: string | null; issuer?: string | null } | null;
}

@Injectable()
export class IntakeJobs {
  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(Worker) private readonly worker: Worker,
    @Inject(STORAGE_PORT) private readonly storage: StoragePort,
    @Inject(ImportsService) private readonly imports: ImportsService,
  ) {}

  register(): void {
    this.worker.register(READ_JOB, (job) => this.read(job));
    this.worker.register(SETTLE_JOB, (job) => this.settle(job));
  }

  private ctxOf(job: Job): Ctx {
    if (!job.workspace_id || !job.created_by)
      throw new PermanentJobError('job.invalid', 'Job without workspace or user');
    return { workspaceId: job.workspace_id, userId: job.created_by };
  }

  async read(job: Job): Promise<Record<string, unknown>> {
    const ctx = this.ctxOf(job);
    const p = job.payload as { intakeId: string; previousResult?: Reading };
    const { intake, file } = await this.db.run(ctx, async (trx) => {
      const intake = await trx
        .selectFrom('app.document_intake')
        .selectAll()
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', p.intakeId)
        .executeTakeFirst();
      const file = intake
        ? await trx
            .selectFrom('app.file')
            .select(['storage_key', 'file_name'])
            .where('workspace_id', '=', ctx.workspaceId)
            .where('id', '=', intake.file_ids[0]!)
            .executeTakeFirst()
        : undefined;
      return { intake, file };
    });
    if (!intake || intake.status !== 'reading' || !file) return { skipped: intake?.status ?? 'missing' };

    // What the file says about itself.
    const type = intake.file_type;
    const docRead = type === 'pdf' || type === 'xls' || type === 'image';
    const reading = docRead ? (p.previousResult ?? null) : null;
    let sheets: Sheet[] | null = reading?.sheets ?? null;
    let ofx: ReturnType<typeof ofxAccounts>[number] | null = null;
    let unreadable = docRead && !reading;
    if (!docRead) {
      try {
        const bytes = await this.storage.get(file.storage_key);
        if (type === 'xlsx') sheets = await readXlsx(bytes);
        else {
          sheets = readTextSheets(type === 'qif' || type === 'ofx' ? type : 'csv', bytes);
          if (type === 'ofx') ofx = ofxAccounts(new TextDecoder().decode(bytes))[0] ?? null;
        }
      } catch {
        unreadable = true;
      }
    }
    const printed = reading?.statement?.accountLast4 ?? null;
    const printedLast4 = printed && /^\d{4}$/.test(printed) ? printed : null;
    const issuer = reading?.statement?.issuer ?? null;
    const fingerprint =
      sheets && (type === 'csv' || type === 'xlsx' || type === 'xls' || type === 'qif')
        ? sheetFingerprint(sheets, type)
        : null;
    const signal = unreadable
      ? null
      : statementSignal({
          fileType: type,
          printedLast4,
          issuer,
          ofx,
          fileName: intake.file_name,
          fingerprint,
        });
    const last4 =
      printedLast4 ??
      (ofx ? ofx.acctId.slice(-4) : null) ??
      (docRead || type === 'ofx' ? null : fileNameLast4(intake.file_name));

    return this.db.run({ ...ctx, actorType: 'worker' }, async (trx) => {
      const accounts = await trx
        .selectFrom('app.ledger_account as a')
        .innerJoin('app.bank_account as b', (j) =>
          j.onRef('b.workspace_id', '=', 'a.workspace_id').onRef('b.ledger_account_id', '=', 'a.id'),
        )
        .select(['a.id', 'a.name', 'b.last4', 'b.institution'])
        .where('a.workspace_id', '=', ctx.workspaceId)
        .where('a.archived_at', 'is', null)
        .where('a.type', 'in', ['asset', 'liability'])
        .execute();
      const candidates: IntakeCandidateDto[] = [];
      const add = (a: (typeof accounts)[number], reason: IntakeCandidateDto['reason']) => {
        if (!candidates.some((c) => c.id === a.id))
          candidates.push({ id: a.id, name: a.name, last4: a.last4, reason });
      };
      const memory = await readMemory(trx, ctx, 'statement', signal);
      const remembered = memory ? accounts.find((a) => a.id === memory.target_id) : undefined;
      if (remembered && memory!.confirmations > 0) add(remembered, 'learned');
      const sameIssuer = (a: (typeof accounts)[number]) =>
        !!issuer && !!a.institution && institutionKey(a.institution) === institutionKey(issuer);
      if (last4) {
        const byDigits = accounts.filter((a) => a.last4 === last4);
        const narrowed =
          byDigits.length > 1 && byDigits.some(sameIssuer) ? byDigits.filter(sameIssuer) : byDigits;
        for (const a of narrowed) add(a, ofx ? 'account_id' : 'last4');
      } else if (issuer) {
        for (const a of accounts.filter(sameIssuer)) add(a, 'issuer');
      }
      if (fingerprint) {
        const profiles = await trx
          .selectFrom('app.import_profile')
          .select('ledger_account_id')
          .distinct()
          .where('workspace_id', '=', ctx.workspaceId)
          .where('fingerprint', '=', fingerprint)
          .where('ledger_account_id', 'is not', null)
          .execute();
        for (const pr of profiles) {
          const a = accounts.find((x) => x.id === pr.ledger_account_id);
          if (a) add(a, 'profile');
        }
      }
      const strong = candidates.length;
      if (strong === 0)
        for (const id of await this.recentAccounts(trx, ctx)) {
          const a = accounts.find((x) => x.id === id);
          if (a) add(a, 'recent');
        }

      const detected: StoredDetected = {
        ...((intake.detected ?? {}) as Partial<StoredDetected>),
        last4,
        issuer,
        fileNamePattern:
          type === 'csv' || type === 'xlsx' || type === 'xls' || type === 'qif'
            ? fileNamePattern(intake.file_name)
            : null,
        billerName: null,
        candidates,
      };
      const base = {
        signal,
        detected: JSON.stringify(detected),
        reading: reading ? JSON.stringify(reading) : null,
        updated_at: new Date(),
      };
      const update = (set: Record<string, unknown>) =>
        trx
          .updateTable('app.document_intake')
          .set({ ...base, ...set })
          .where('workspace_id', '=', ctx.workspaceId)
          .where('id', '=', intake.id)
          .execute();

      if (unreadable) {
        await update({ status: 'review', reason: 'unreadable' satisfies IntakeReason });
        return { read: false };
      }
      // Learned (ADR-0051 §3): imported into its account, and committed by `intake.settle` when it's clean.
      if (remembered && isLearned(memoryState(memory))) {
        const batchId = await this.imports.startBatch(
          trx,
          ctx,
          { fileId: intake.file_ids[0]!, accountId: remembered.id },
          {
            previousResult: (reading as Record<string, unknown> | null) ?? null,
            then: { queue: 'import', type: SETTLE_JOB, payload: { intakeId: intake.id } },
          },
        );
        await update({
          status: 'importing',
          target_id: remembered.id,
          automatic: true,
          commit_if_clean: true,
          import_batch_id: batchId,
        });
        return { automatic: true };
      }
      if (strong === 1) {
        await update({ status: 'suggested', reason: null, target_id: candidates[0]!.id });
        return { suggested: true };
      }
      await update({
        status: 'review',
        reason: (strong > 1 ? 'several' : 'no_match') satisfies IntakeReason,
        target_id: null,
      });
      return { review: true, candidates: candidates.length };
    });
  }

  /** The accounts imported into most recently. */
  private async recentAccounts(trx: Trx, ctx: Ctx): Promise<string[]> {
    const recent = await trx
      .selectFrom('app.import_batch')
      .select('ledger_account_id')
      .where('workspace_id', '=', ctx.workspaceId)
      .groupBy('ledger_account_id')
      .orderBy((eb) => eb.fn.max('created_at'), 'desc')
      .limit(RECENT_ACCOUNTS)
      .execute();
    return recent.map((r) => r.ledger_account_id);
  }

  async settle(job: Job): Promise<Record<string, unknown>> {
    const ctx = this.ctxOf(job);
    const p = job.payload as { intakeId: string };
    return this.db.run({ ...ctx, actorType: 'worker' }, async (trx) => {
      const intake = await trx
        .selectFrom('app.document_intake')
        .selectAll()
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', p.intakeId)
        .forUpdate()
        .executeTakeFirst();
      if (!intake || intake.status !== 'importing' || !intake.import_batch_id)
        return { skipped: intake?.status ?? 'missing' };
      const batch = await trx
        .selectFrom('app.import_batch')
        .select(['id', 'status', 'balance_check'])
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', intake.import_batch_id)
        .executeTakeFirst();
      if (!batch) return { skipped: 'no_batch' };
      const counts = await trx
        .selectFrom('app.import_row')
        .select(['status', (eb) => eb.fn.countAll<string>().as('n')])
        .where('workspace_id', '=', ctx.workspaceId)
        .where('import_batch_id', '=', batch.id)
        .groupBy('status')
        .execute();
      const n = (s: string) => Number(counts.find((c) => c.status === s)?.n ?? 0);
      const outcome = cleanImport({
        status: batch.status,
        balanceCheck: batch.balance_check,
        counts: {
          new: n('new'),
          match: n('match'),
          duplicate: n('duplicate'),
          probableDuplicate: n('probable_duplicate'),
          error: n('error'),
        },
      });
      const now = new Date();
      if (outcome.clean && intake.commit_if_clean) {
        await this.imports.enqueueCommit(trx, ctx, batch.id);
        await trx
          .updateTable('app.document_intake')
          .set({
            status: 'done',
            reason: null,
            reading: null,
            resolved_at: now,
            // Made by the memory: nobody resolved it. Confirmed from the phone: they did.
            resolved_by: intake.automatic ? null : ctx.userId,
            updated_at: now,
          })
          .where('workspace_id', '=', ctx.workspaceId)
          .where('id', '=', intake.id)
          .execute();
        return { committed: true };
      }
      await trx
        .updateTable('app.document_intake')
        .set({ status: 'review', reason: outcome.clean ? null : outcome.reason, updated_at: now })
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', intake.id)
        .execute();
      return { committed: false, reason: outcome.clean ? null : outcome.reason };
    });
  }
}
