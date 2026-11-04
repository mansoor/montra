/**
 * `payslip.extract` (PAY-03): reads a payslip into a draft through the AI gateway, after the doc-worker's OCR unless
 * the workspace allows images to go to the provider. The result always waits for the user to confirm it.
 */
import { Inject, Injectable } from '@nestjs/common';
import { asCurrencyCode, calendarDate, isCurrencyCode, payslipGap } from '@montra/domain';
import type { ImagePart } from '@montra/ai-gateway';
import { AiService } from '../ai/ai.service.js';
import { Db } from '../db/database.js';
import { PermanentJobError, Worker, type Job } from '../jobs/queue.js';
import { toMinor } from '../receipts/receipts.service.js';
import { STORAGE_PORT, type StoragePort } from '../storage/storage.js';
import { PayslipsService } from './payslips.service.js';

/** Never send more than this to a model in one request. */
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

interface ExtractPayload {
  payslipId: string;
  previousResult?: { kind?: string; pages?: string[] };
}

@Injectable()
export class PayslipJobs {
  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(Worker) private readonly worker: Worker,
    @Inject(STORAGE_PORT) private readonly storage: StoragePort,
    @Inject(AiService) private readonly ai: AiService,
    @Inject(PayslipsService) private readonly payslips: PayslipsService,
  ) {}

  register(): void {
    this.worker.register('payslip.extract', (job) => this.extract(job));
  }

  async extract(job: Job): Promise<Record<string, unknown>> {
    if (!job.workspace_id || !job.created_by)
      throw new PermanentJobError('job.invalid', 'Job without workspace or user');
    const ctx = { workspaceId: job.workspace_id, userId: job.created_by };
    const p = job.payload as unknown as ExtractPayload;
    const { row, files, allowImages } = await this.db.run(ctx, async (trx) => {
      const row = await this.payslips.row(trx, ctx, p.payslipId);
      const files = await trx
        .selectFrom('app.file')
        .select(['id', 'storage_key', 'mime', 'bytes'])
        .where('workspace_id', '=', ctx.workspaceId)
        .where(
          'id',
          'in',
          row.attachment_ids.length ? row.attachment_ids : ['00000000-0000-0000-0000-000000000000'],
        )
        .execute();
      const runtime = await this.ai.runtime(trx, ctx);
      return {
        row,
        files: row.attachment_ids.map((id) => files.find((f) => f.id === id)!).filter(Boolean),
        allowImages: (runtime.mode === 'builtin' || runtime.mode === 'byok') && runtime.allowDocumentsToLlm,
      };
    });
    const images: ImagePart[] = [];
    let total = 0;
    for (const f of allowImages ? files : []) {
      total += Number(f.bytes);
      if (total > MAX_IMAGE_BYTES) break;
      images.push({
        mediaType: f.mime as ImagePart['mediaType'],
        data: Buffer.from(await this.storage.get(f.storage_key)).toString('base64'),
      });
    }
    const ocrText =
      p.previousResult?.kind === 'receipt_text' ? (p.previousResult.pages ?? []).join('\n\n') : null;

    return this.db.run({ ...ctx, actorType: 'worker' }, async (trx) => {
      const runtime = await this.ai.runtime(trx, ctx, { type: 'payslip', id: row.id });
      const res = await this.ai.gateway.extractPayslip(
        { images, ocrText, currencyHint: row.currency, locale: 'en-US' },
        { ...runtime.ctx, parkLocal: false },
      );
      const base = { mode: runtime.mode, provider: runtime.ctx.provider.id };
      if (!res.ok) {
        await trx
          .updateTable('app.payslip')
          .set({
            status: 'needs_review',
            extraction: JSON.stringify({
              ...base,
              warnings: ["This payslip couldn't be read: enter it yourself"],
            }),
          })
          .where('workspace_id', '=', ctx.workspaceId)
          .where('id', '=', row.id)
          .execute();
        return { read: false, reason: res.reason };
      }
      const x = res.value;
      const warnings: string[] = [];
      const currency = asCurrencyCode(row.currency);
      if (x.currency && isCurrencyCode(x.currency) && x.currency !== row.currency) {
        warnings.push(`This payslip is in ${x.currency}, and these books are in ${row.currency}`);
      }
      const lines = x.lines.flatMap((l) => {
        const amount = toMinor(l.amount, currency);
        if (amount === null) return [];
        const ytd = toMinor(l.ytd, currency);
        return [
          {
            section: l.section,
            code: l.code,
            label: l.label,
            amount: String(amount),
            ytd: ytd === null ? null : String(ytd),
          },
        ];
      });
      const net = toMinor(x.netPay, currency);
      if (net === null) warnings.push('No net pay found: enter it');
      const employer = await trx
        .selectFrom('app.employer')
        .select('name')
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', row.employer_id)
        .executeTakeFirstOrThrow();
      if (x.employer && !namesAgree(x.employer, employer.name)) {
        warnings.push(`This payslip names ${x.employer}, and you chose ${employer.name}`);
      }
      const amounts = lines.map((l) => ({ section: l.section, code: l.code, amount: BigInt(l.amount) }));
      if (net !== null && payslipGap(amounts, net) !== 0n) {
        warnings.push("The amounts read don't add up to the net pay: check them against the payslip");
      }
      if (x.confidence < 0.8) warnings.push('Low confidence reading: check every amount');
      await this.payslips.writeLines(trx, ctx, row.id, lines);
      await trx
        .updateTable('app.payslip')
        .set({
          status: 'needs_review',
          // The date the user entered wins over the one read.
          pay_date: row.pay_date ?? (x.payDate ? calendarDate(x.payDate) : null),
          period_start: x.periodStart,
          period_end: x.periodEnd,
          net_minor: net ?? 0n,
          gross_minor: amounts.filter((a) => a.section === 'earning').reduce((t, a) => t + a.amount, 0n),
          extraction: JSON.stringify({ ...base, model: res.meta.model, confidence: x.confidence, warnings }),
        })
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', row.id)
        .execute();
      return { read: true, lines: lines.length, warnings: warnings.length };
    });
  }
}

/** "ACME CORP" and "Acme Corporation Inc" are the same payer; a loose check, because it only raises a warning. */
function namesAgree(a: string, b: string): boolean {
  const words = (s: string) =>
    s
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 2);
  const other = new Set(words(b));
  return words(a).some((w) => other.has(w));
}
