/**
 * `scan.read` (ADR-0048 §3): reads a scanned document once and works out where it goes.
 *
 * - A statement arrives after the doc-worker's `doc.extract`, whose statement facts carry the account's last four
 *   digits ("account ending 1234"). The accounts with those digits are the candidates; one alone is picked. With no
 *   digits, the accounts imported into most recently are offered.
 * - A payslip is read with `extract_payslip` (after the doc-worker's OCR unless documents may go to the provider). The
 *   person comes from the pseudonym token the reading names (names never reach the provider), and the employer from
 *   the name printed, among the workspace's employers (that person's, when the person is known).
 *
 * The reading is kept on the scan until an import or payslip is made from it.
 */
import { Inject, Injectable } from '@nestjs/common';
import { asCurrencyCode, isCurrencyCode } from '@montra/domain';
import type { ScanPayslipDetectedDto, ScanStatementDetectedDto } from '@montra/schemas';
import { Db } from '../db/database.js';
import { PermanentJobError, Worker, type Job } from '../jobs/queue.js';
import { namesAgree, PayslipJobs, storableReading } from '../payslips/payslip-jobs.js';
import { toMinor } from '../receipts/receipts.service.js';
import { ScansService } from './scans.service.js';

interface ReadPayload {
  scanId: string;
  previousResult?: {
    kind?: string;
    pages?: string[];
    statement?: { accountLast4?: string | null } | null;
  } & Record<string, unknown>;
}

type JobCtx = { workspaceId: string; userId: string };

/** How many recent accounts to offer when a statement names none. */
const RECENT_ACCOUNTS = 5;

@Injectable()
export class ScanJobs {
  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(Worker) private readonly worker: Worker,
    @Inject(ScansService) private readonly scans: ScansService,
    @Inject(PayslipJobs) private readonly payslips: PayslipJobs,
  ) {}

  register(): void {
    this.worker.register('scan.read', (job) => this.read(job));
  }

  async read(job: Job): Promise<Record<string, unknown>> {
    if (!job.workspace_id || !job.created_by)
      throw new PermanentJobError('job.invalid', 'Job without workspace or user');
    const ctx = { workspaceId: job.workspace_id, userId: job.created_by };
    const p = job.payload as unknown as ReadPayload;
    const scan = await this.db.run(ctx, (trx) => this.scans.row(trx, ctx, p.scanId));
    if (scan.status !== 'reading') return { skipped: scan.status };
    if (scan.kind === 'statement') return this.statement(ctx, scan.id, p.previousResult ?? null);
    if (scan.kind === 'payslip') return this.payslip(ctx, scan.id, scan.file_ids, p.previousResult);
    throw new PermanentJobError('scan.kind', `No reader for ${scan.kind} scans yet`);
  }

  private async statement(
    ctx: JobCtx,
    scanId: string,
    result: ReadPayload['previousResult'] | null,
  ): Promise<Record<string, unknown>> {
    return this.db.run({ ...ctx, actorType: 'worker' }, async (trx) => {
      if (!result) {
        await this.scans.fail(trx, ctx, scanId, 'This statement could not be read');
        return { read: false };
      }
      const raw = result.statement?.accountLast4 ?? null;
      const last4 = raw && /^\d{4}$/.test(raw) ? raw : null;
      const accounts = await trx
        .selectFrom('app.ledger_account as a')
        .innerJoin('app.bank_account as b', (j) =>
          j.onRef('b.workspace_id', '=', 'a.workspace_id').onRef('b.ledger_account_id', '=', 'a.id'),
        )
        .select(['a.id', 'a.name', 'b.last4'])
        .where('a.workspace_id', '=', ctx.workspaceId)
        .where('a.archived_at', 'is', null)
        .where('a.type', 'in', ['asset', 'liability'])
        .execute();
      const byDigits = last4 ? accounts.filter((a) => a.last4 === last4) : [];
      let candidates: ScanStatementDetectedDto['candidates'] = byDigits.map((a) => ({
        accountId: a.id,
        name: a.name,
        last4: a.last4,
        reason: 'last4' as const,
      }));
      if (candidates.length === 0) {
        const recent = await trx
          .selectFrom('app.import_batch')
          .select('ledger_account_id')
          .where('workspace_id', '=', ctx.workspaceId)
          .groupBy('ledger_account_id')
          .orderBy((eb) => eb.fn.max('created_at'), 'desc')
          .limit(RECENT_ACCOUNTS)
          .execute();
        candidates = recent.flatMap((r) => {
          const a = accounts.find((x) => x.id === r.ledger_account_id);
          return a ? [{ accountId: a.id, name: a.name, last4: a.last4, reason: 'recent' as const }] : [];
        });
      }
      const detected: ScanStatementDetectedDto = {
        accountLast4: last4,
        accountId: byDigits.length === 1 ? byDigits[0]!.id : null,
        candidates,
      };
      await trx
        .updateTable('app.document_scan')
        .set({
          status: 'ready',
          result: JSON.stringify(result),
          detected: JSON.stringify(detected),
          updated_at: new Date(),
        })
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', scanId)
        .execute();
      return { read: true, last4: Boolean(last4), candidates: candidates.length };
    });
  }

  private async payslip(
    ctx: JobCtx,
    scanId: string,
    fileIds: string[],
    previousResult: ReadPayload['previousResult'],
  ): Promise<Record<string, unknown>> {
    const base = await this.db.run(ctx, (trx) =>
      trx
        .selectFrom('app.workspace')
        .select('base_currency')
        .where('id', '=', ctx.workspaceId)
        .executeTakeFirstOrThrow(),
    );
    const reading = await this.payslips.read(ctx, fileIds, base.base_currency, previousResult, {
      type: 'scan',
      id: scanId,
    });
    return this.db.run({ ...ctx, actorType: 'worker' }, async (trx) => {
      if (!reading.res.ok) {
        await this.scans.fail(
          trx,
          ctx,
          scanId,
          'This payslip could not be read: choose its employer yourself',
        );
        return { read: false, reason: reading.res.reason };
      }
      const x = reading.res.value;
      // The same order as the pseudonyms the gateway used (AiService.runtime): MEMBER_1 is the first member made.
      const members = await trx
        .selectFrom('app.family_member')
        .select(['id', 'name'])
        .where('workspace_id', '=', ctx.workspaceId)
        .orderBy('created_at')
        .execute();
      const token = x.employee ? /^MEMBER_(\d+)$/.exec(x.employee) : null;
      const member = token ? (members[Number(token[1]) - 1] ?? null) : null;
      const employers = await trx
        .selectFrom('app.employer')
        .select(['id', 'name', 'member_id'])
        .where('workspace_id', '=', ctx.workspaceId)
        .where('archived_at', 'is', null)
        .orderBy('name')
        .execute();
      const named = x.employer ? employers.filter((e) => namesAgree(x.employer!, e.name)) : [];
      const theirs = member ? named.filter((e) => e.member_id === member.id) : named;
      const fits = theirs.length ? theirs : named;
      const currency = x.currency && isCurrencyCode(x.currency) ? x.currency : base.base_currency;
      const net = toMinor(x.netPay, asCurrencyCode(currency));
      const detected: ScanPayslipDetectedDto = {
        employerName: x.employer,
        memberId: member?.id ?? null,
        employerId: fits.length === 1 ? fits[0]!.id : null,
        candidates: fits.map((e) => ({
          employerId: e.id,
          name: e.name,
          memberId: e.member_id,
          memberName: members.find((m) => m.id === e.member_id)?.name ?? '',
        })),
        payDate: x.payDate,
        net: net === null ? null : net.toString(),
        currency,
      };
      await trx
        .updateTable('app.document_scan')
        .set({
          status: 'ready',
          result: JSON.stringify(storableReading(reading)),
          detected: JSON.stringify(detected),
          updated_at: new Date(),
        })
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', scanId)
        .execute();
      return { read: true, employer: Boolean(detected.employerId), member: Boolean(member) };
    });
  }
}
