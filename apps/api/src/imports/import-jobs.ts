/**
 * Import worker jobs (design 04 §3): parse → stage preview rows, commit → post atomically, undo → void.
 * Each job runs in the workspace's RLS context as the user who started it.
 */
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { newId, type Trx } from '@montra/db';
import {
  addDays,
  asCurrencyCode,
  calendarDate,
  isCalendarDate,
  type CalendarDate,
  type CurrencyCode,
} from '@montra/domain';
import {
  analyze,
  classifyRows,
  decodeText,
  detectDecimalSeparator,
  displayName,
  matchMerchant,
  normalizeDescription,
  parseAmount,
  parseDelimited,
  readXlsx,
  type ColumnMapping,
  type MerchantRef,
  type Sheet,
} from '@montra/importers';
import { Db } from '../db/database.js';
import { LedgerService } from '../ledger/ledger.service.js';
import { STORAGE_PORT, type StoragePort } from '../storage/storage.js';
import { TransactionPoster, type TransactionSpec } from '../transactions/poster.js';
import { TransactionsService } from '../transactions/transactions.service.js';
import { JobQueue, PermanentJobError, Worker, type Job, type JobContext } from '../jobs/queue.js';
import { effectiveDecision } from './imports.service.js';
import { Categorizer, type StoredCategorization } from '../categorization/categorizer.service.js';
import { MerchantDirectory } from '../categorization/merchants.js';
import { AiService } from '../ai/ai.service.js';

/** What parse stores in `import_row.suggestion`: the pipeline decision plus what commit needs. */
export interface RowSuggestion extends StoredCategorization {
  categoryId: string | null;
  memberId: string | null;
  tags: string[];
  renamePayee: string | null;
  autoApply: boolean;
  merchantId: string | null;
  /** Set when the user picked the category in the preview. */
  userSet?: boolean;
}

type Ctx = { workspaceId: string; userId: string };

interface ParsePayload {
  batchId: string;
  accountFilter?: string | null;
  override?: ColumnMapping;
  saveProfile?: boolean;
  previousResult?: {
    kind: 'grid' | 'ocr_text';
    sheets?: Sheet[];
    /** Scanned PDFs (ADR-0012 §9): redacted OCR text per page from the doc-worker. */
    pages?: string[];
    statement?: {
      openingBalance?: string | null;
      closingBalance?: string | null;
      periodStart?: string | null;
      periodEnd?: string | null;
    } | null;
  };
}

const UNDO_DAYS = 30;
const SAMPLE_ROWS = 25;
const DAY_FIRST_LOCALES = /^(en-(GB|IE|AU|NZ|IN|ZA)|de|fr|es|it|nl|pt|da|sv|nb|fi|pl|cs|tr|ru)/;

@Injectable()
export class ImportJobs {
  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(Worker) private readonly worker: Worker,
    @Inject(STORAGE_PORT) private readonly storage: StoragePort,
    @Inject(LedgerService) private readonly ledger: LedgerService,
    @Inject(TransactionsService) private readonly transactions: TransactionsService,
    @Inject(TransactionPoster) private readonly poster: TransactionPoster,
    @Inject(Categorizer) private readonly categorizer: Categorizer,
    @Inject(MerchantDirectory) private readonly merchants: MerchantDirectory,
    @Inject(AiService) private readonly ai: AiService,
    @Inject(JobQueue) private readonly queue: JobQueue,
  ) {}

  register(): void {
    this.worker.register('import.parse', (job) => this.parse(job));
    this.worker.register('import.commit', (job, c) => this.commit(job, c));
    this.worker.register('import.undo', (job) => this.undo(job));
  }

  private ctxOf(job: Job): Ctx {
    if (!job.workspace_id || !job.created_by)
      throw new PermanentJobError('job.invalid', 'Job without workspace or user');
    return { workspaceId: job.workspace_id, userId: job.created_by };
  }

  // ------------------------------------------------------------------------------------------------------
  // Parse: grid → mapping → rows → dedupe/match → preview (IMP-03..07, IMP-10)
  // ------------------------------------------------------------------------------------------------------
  async parse(job: Job): Promise<Record<string, unknown>> {
    const ctx = this.ctxOf(job);
    const p = job.payload as unknown as ParsePayload;
    return this.db.run({ ...ctx, actorType: 'worker' }, async (trx) => {
      const batch = await trx
        .selectFrom('app.import_batch')
        .selectAll()
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', p.batchId)
        .forUpdate()
        .executeTakeFirst();
      if (!batch) throw new PermanentJobError('import.not_found', 'Import batch not found');
      const file = await trx
        .selectFrom('app.file')
        .selectAll()
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', batch.file_id)
        .executeTakeFirstOrThrow();
      const account = await this.ledger.accountRef(trx, ctx.workspaceId, batch.ledger_account_id);
      const currency = asCurrencyCode(batch.currency);

      const ocr = p.previousResult?.kind === 'ocr_text' ? await this.ocrTable(trx, ctx, batch.id, currency, p) : null;
      const sheets = ocr ? ocr.sheets : await this.sheets(batch.file_type, file.storage_key, p);
      const statement = ocr ? ocr.statement : (p.previousResult?.statement ?? null);
      const decimal = detectDecimalSeparator(
        [statement?.openingBalance ?? '', statement?.closingBalance ?? ''].filter(Boolean),
      );
      const statementBalances = statement
        ? {
            opening: statement.openingBalance
              ? parseAmount(statement.openingBalance, currency, decimal)
              : null,
            closing: statement.closingBalance
              ? parseAmount(statement.closingBalance, currency, decimal)
              : null,
            periodStart:
              statement.periodStart && isCalendarDate(statement.periodStart) ? statement.periodStart : null,
            periodEnd:
              statement.periodEnd && isCalendarDate(statement.periodEnd) ? statement.periodEnd : null,
          }
        : undefined;

      const profiles = await trx
        .selectFrom('app.import_profile')
        .select(['id', 'fingerprint', 'mapping', 'ledger_account_id'])
        .where('workspace_id', '=', ctx.workspaceId)
        .orderBy('last_used_at', 'desc')
        .execute();
      // Profiles saved for this account win over profiles of the same shape saved for other accounts.
      const ordered = [
        ...profiles.filter((x) => x.ledger_account_id === account.id),
        ...profiles.filter((x) => x.ledger_account_id !== account.id),
      ];
      const user = await trx
        .selectFrom('app.app_user')
        .select('locale')
        .where('id', '=', ctx.userId)
        .executeTakeFirst();
      const analysis = analyze(
        sheets,
        {
          fileType: batch.file_type,
          currency,
          accountType: account.type === 'liability' ? 'liability' : 'asset',
          preferDayFirst: DAY_FIRST_LOCALES.test(user?.locale ?? 'en-US'),
          profiles: ordered.map((x) => ({
            id: x.id,
            fingerprint: x.fingerprint,
            mapping: x.mapping as unknown as ColumnMapping,
          })),
          accountFilter: p.accountFilter ?? undefined,
          statement: statementBalances,
        },
        p.override,
      );
      const { parsed, proposal } = analysis;

      // Candidates for dedupe and matching on this account, around the file's date range.
      const range =
        parsed.minDate && parsed.maxDate
          ? { from: addDays(parsed.minDate, -3), to: addDays(parsed.maxDate, 3) }
          : null;
      const { imported, manual, covered } = range
        ? await this.candidates(trx, ctx, account.id, batch.id, range)
        : { imported: [], manual: [], covered: [] };
      const classes = classifyRows(account.id, parsed.rows, imported, manual, covered);
      const decisions = await this.categorizeRows(trx, ctx, batch.id, account.id, parsed.rows, classes);

      await trx
        .deleteFrom('app.import_row')
        .where('workspace_id', '=', ctx.workspaceId)
        .where('import_batch_id', '=', batch.id)
        .execute();
      const values = [
        ...parsed.rows.map((r, i) => {
          const c = classes[i]!;
          const s = decisions.get(i) ?? null;
          return {
            workspace_id: ctx.workspaceId,
            id: newId(),
            import_batch_id: batch.id,
            row_no: r.rowNo,
            raw: JSON.stringify(r.raw),
            txn_date: r.date,
            amount_minor: r.amount,
            description: r.description,
            payee_raw: r.payee,
            normalized_desc: r.normalizedDescription,
            balance_minor: r.balance,
            ordinal: c.ordinal,
            dedupe_key: c.dedupeKey,
            status: c.status,
            match_transaction_id: c.status === 'match' ? c.transactionId : null,
            duplicate_of_transaction_id:
              c.status === 'duplicate' || c.status === 'probable_duplicate' ? c.transactionId : null,
            score: c.score === null ? null : String(c.score),
            suggestion: s ? JSON.stringify(s) : null,
            category_id: s?.autoApply ? s.categoryId : null,
            member_id: s?.autoApply ? s.memberId : null,
          };
        }),
        ...parsed.errors.map((e) => ({
          workspace_id: ctx.workspaceId,
          id: newId(),
          import_batch_id: batch.id,
          row_no: e.rowNo,
          raw: JSON.stringify(e.raw),
          status: 'error' as const,
          error: e.error,
        })),
      ];
      for (let i = 0; i < values.length; i += 500) {
        await trx
          .insertInto('app.import_row')
          .values(values.slice(i, i + 500))
          .execute();
      }

      const needsMapping = proposal.confidence < 0.75 || parsed.rows.length === 0;
      const sheet = analysis.sheet;
      await trx
        .updateTable('app.import_batch')
        .set({
          status: needsMapping ? 'needs_mapping' : 'preview',
          fingerprint: analysis.fingerprint,
          mapping: JSON.stringify(proposal.mapping),
          mapping_source: proposal.source,
          mapping_confidence: proposal.confidence.toFixed(3),
          profile_id: proposal.profileId ?? null,
          rows_read: parsed.read,
          rows_skipped: parsed.skipped.filter((s) => s.reason !== 'blank').length,
          rows_failed: parsed.errors.length,
          min_date: parsed.minDate,
          max_date: parsed.maxDate,
          statement_opening_minor: statementBalances?.opening ?? parsed.opening,
          statement_closing_minor: statementBalances?.closing ?? parsed.closing,
          balance_check: analysis.balance.status,
          balance_gap_minor: analysis.balance.gap,
          warnings: JSON.stringify(proposal.warnings),
          error: null,
          analysis: JSON.stringify({
            header: proposal.header,
            sample: sheet.rows.slice(0, SAMPLE_ROWS),
            accounts: proposal.accounts ?? [],
            templateId: proposal.templateId ?? null,
            accountColumn: proposal.accountColumn ?? null,
            accountFilter: p.accountFilter ?? null,
            saveProfile: p.saveProfile ?? true,
            // Spreadsheet/PDF grids are kept so a mapping change doesn't need another extraction.
            ...(p.previousResult ? { sheets, statement } : {}),
          }),
        })
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', batch.id)
        .execute();
      return {
        rows: parsed.rows.length,
        errors: parsed.errors.length,
        status: needsMapping ? 'needs_mapping' : 'preview',
      };
    });
  }

  private async sheets(fileType: string, storageKey: string, p: ParsePayload): Promise<Sheet[]> {
    if (p.previousResult?.kind === 'grid' && p.previousResult.sheets) return p.previousResult.sheets;
    if (fileType === 'xls' || fileType === 'pdf')
      throw new PermanentJobError('import.no_grid', 'The document has not been extracted');
    const bytes = await this.storage.get(storageKey);
    if (fileType === 'xlsx') {
      try {
        return await readXlsx(bytes);
      } catch (err) {
        throw new PermanentJobError('doc.corrupt', `Unreadable spreadsheet: ${(err as Error).message}`);
      }
    }
    return [parseDelimited(decodeText(bytes).text)];
  }

  private async candidates(
    trx: Trx,
    ctx: Ctx,
    accountId: string,
    batchId: string,
    range: { from: CalendarDate; to: CalendarDate },
  ) {
    const rows = await sql<{
      id: string;
      txn_date: string;
      source: string;
      status: string;
      dedupe_key: string | null;
      text: string;
      amount: bigint | null;
      spec: TransactionSpec | null;
      matched: boolean;
    }>`
      select distinct on (t.id) t.id, t.txn_date, t.source, t.status, t.dedupe_key, t.spec,
             coalesce(t.raw_description, nullif(t.payee_raw, ''), t.description) as text,
             p.amount_minor as amount,
             exists (select 1 from app.transaction_source s where s.workspace_id = t.workspace_id and s.transaction_id = t.id) as matched
        from app.transaction t
        left join app.journal_entry je on je.workspace_id = t.workspace_id and je.transaction_id = t.id
        left join app.posting p on p.workspace_id = je.workspace_id and p.journal_entry_id = je.id and p.ledger_account_id = ${accountId}
       where t.workspace_id = ${ctx.workspaceId}
         and t.deleted_at is null and t.status <> 'void'
         and t.txn_date between ${range.from} and ${range.to}
         and (p.id is not null
              or (t.status = 'scheduled' and ${accountId} in (t.spec ->> 'accountId', t.spec ->> 'fromAccountId', t.spec ->> 'toAccountId')))
       order by t.id, je.posted_at`.execute(trx);
    const imported = [];
    const manual = [];
    for (const r of rows.rows) {
      const date = calendarDate(r.txn_date);
      const key = normalizeDescription(r.text ?? '');
      // Imported transactions, and manual ones an earlier import already confirmed (they carry its dedupe key),
      // are duplicate candidates; everything else may be matched.
      if (r.source === 'import' || r.source === 'feed' || r.matched) {
        if (r.amount !== null)
          imported.push({
            transactionId: r.id,
            date,
            amount: BigInt(r.amount),
            normalizedDescription: key,
            dedupeKey: r.dedupe_key,
          });
        continue;
      }
      let amount = r.amount === null ? null : BigInt(r.amount);
      if (amount === null && r.spec) {
        if (r.spec.type === 'standard') amount = BigInt(r.spec.amount);
        else amount = r.spec.fromAccountId === accountId ? -BigInt(r.spec.amount) : BigInt(r.spec.amount);
      }
      if (amount !== null) manual.push({ transactionId: r.id, date, amount, normalizedDescription: key });
    }
    const covered = await trx
      .selectFrom('app.import_batch')
      .select(['min_date', 'max_date'])
      .where('workspace_id', '=', ctx.workspaceId)
      .where('ledger_account_id', '=', accountId)
      .where('status', '=', 'committed')
      .where('id', '<>', batchId)
      .where('min_date', 'is not', null)
      .execute();
    return {
      imported,
      manual,
      covered: covered.map((c) => ({ min: calendarDate(c.min_date!), max: calendarDate(c.max_date!) })),
    };
  }

  /**
   * The categorization pipeline (04 §5) over the rows that will be imported: rules, transfers, history,
   * the file's own category, known merchants, then AI. Duplicates and matches keep their existing entry.
   */
  private async categorizeRows(
    trx: Trx,
    ctx: Ctx,
    batchId: string,
    accountId: string,
    rows: ReadonlyArray<{
      date: CalendarDate;
      amount: bigint;
      description: string;
      payee: string | null;
      category: string | null;
      normalizedDescription: string;
    }>,
    classes: ReadonlyArray<{ status: string }>,
  ): Promise<Map<number, RowSuggestion>> {
    const account = await this.categorizer.accountInfo(trx, ctx, accountId);
    const prepared = await this.categorizer.prepare(trx, ctx);
    const merchants = await this.merchants.load(trx);
    const byName = new Map<string, string>();
    for (const c of prepared.categories)
      if (c.entityId === account.entityId) byName.set(c.name.toLowerCase(), c.id);
    const items = [];
    const merchantOf = new Map<number, string>();
    for (const [i, r] of rows.entries()) {
      const status = classes[i]!.status;
      if (status !== 'new' && status !== 'probable_duplicate') continue;
      let fileCategoryId: string | null = null;
      if (r.category) {
        const leaf = r.category.split(/[:/>]/).at(-1)!.trim().toLowerCase();
        fileCategoryId = byName.get(r.category.toLowerCase()) ?? byName.get(leaf) ?? null;
      }
      const m = merchants.match(r.normalizedDescription);
      if (m) merchantOf.set(i, m.id);
      items.push(
        this.categorizer.item(account, {
          id: String(i),
          payee: r.payee ?? (m ? m.displayName : null),
          payeeKey: (r.payee ? normalizeDescription(r.payee) : r.normalizedDescription) || null,
          description: r.description,
          rawDescription: r.description,
          amountMinor: r.amount,
          date: r.date,
          fileCategoryId,
          fileCategoryName: r.category,
          merchant: m
            ? {
                id: m.id,
                name: m.displayName,
                categoryId: m.categoryHint ? (byName.get(m.categoryHint.toLowerCase()) ?? null) : null,
              }
            : null,
        }),
      );
    }
    const { decisions } = await this.categorizer.categorize(trx, ctx, account, items, {
      useAi: true,
      prepared,
      subject: { type: 'import_batch', id: batchId },
    });
    const out = new Map<number, RowSuggestion>();
    for (const d of decisions) {
      const i = Number(d.id);
      out.set(i, {
        ...this.categorizer.stored(d),
        categoryId: d.categoryId,
        memberId: d.memberId,
        tags: d.tags,
        renamePayee: d.renamePayee,
        autoApply: d.autoApply && Boolean(d.categoryId),
        merchantId: merchantOf.get(i) ?? null,
      });
    }
    return out;
  }

  /**
   * Scanned PDF (ADR-0012 §9): the doc-worker sends redacted OCR text; `extract_statement_table` turns it
   * into rows, which then go through the same mapping, balance check and preview as any grid.
   */
  private async ocrTable(
    trx: Trx,
    ctx: Ctx,
    batchId: string,
    currency: CurrencyCode,
    p: ParsePayload,
  ): Promise<{ sheets: Sheet[]; statement: NonNullable<ParsePayload['previousResult']>['statement'] }> {
    const runtime = await this.ai.runtime(trx, ctx, { type: 'import_batch', id: batchId });
    if (!runtime.available)
      throw new PermanentJobError(
        'pdf.needs_ai',
        'This PDF is a scan. Reading scanned statements needs AI — turn it on in Settings → AI, or upload the CSV export instead.',
      );
    const res = await this.ai.gateway.extractStatementTable(
      { pages: p.previousResult?.pages ?? [], currency },
      runtime.ctx,
    );
    if (!res.ok)
      throw new PermanentJobError(
        res.reason === 'budget' ? 'ai.budget_exhausted' : 'pdf.extract_failed',
        res.reason === 'budget'
          ? "This month's AI budget is used up, so the scan can't be read. Raise the budget or upload a CSV."
          : `The scanned statement couldn't be read (${res.reason}). Try a clearer scan or the CSV export.`,
      );
    const t = res.value;
    const rows = [
      ['Date', 'Description', 'Amount', 'Balance'],
      ...t.rows.map((r) => [r.date, r.description, r.amount, r.balance ?? '']),
    ];
    const st = p.previousResult?.statement ?? null;
    return {
      sheets: [{ name: 'Statement', rows }],
      statement: {
        openingBalance: st?.openingBalance ?? t.opening,
        closingBalance: st?.closingBalance ?? t.closing,
        periodStart: st?.periodStart ?? t.periodStart,
        periodEnd: st?.periodEnd ?? t.periodEnd,
      },
    };
  }

  // ------------------------------------------------------------------------------------------------------
  // Commit: one atomic transaction for the whole batch (IMP-08)
  // ------------------------------------------------------------------------------------------------------
  async commit(job: Job, jc: JobContext): Promise<Record<string, unknown>> {
    const ctx = this.ctxOf(job);
    const { batchId } = job.payload as { batchId: string };
    try {
      return await this.db.run({ ...ctx, actorType: 'worker' }, async (trx) => {
        const batch = await trx
          .selectFrom('app.import_batch')
          .selectAll()
          .where('workspace_id', '=', ctx.workspaceId)
          .where('id', '=', batchId)
          .forUpdate()
          .executeTakeFirstOrThrow();
        if (batch.status !== 'committing')
          throw new PermanentJobError('import.not_committing', `Import is ${batch.status}`);
        this.ledger.enableCache(trx);
        const rows = await trx
          .selectFrom('app.import_row')
          .selectAll()
          .where('workspace_id', '=', ctx.workspaceId)
          .where('import_batch_id', '=', batchId)
          .orderBy('row_no')
          .execute();
        const merchants = new Map(
          (await trx.selectFrom('ref.merchant').select(['id', 'display_name']).execute()).map((m) => [
            m.id,
            m.display_name,
          ]),
        );
        const currency = batch.currency as CurrencyCode;
        let added = 0;
        let matched = 0;
        let skipped = batch.rows_skipped;
        let failed = 0;
        const sources: { transaction_id: string; import_row_id: string }[] = [];
        const outcomes: { id: string; outcome: string; transaction_id: string | null }[] = [];
        const payees = new Map<string, string>();
        for (const [i, row] of rows.entries()) {
          if (i % 200 === 0) await jc.progress((i / rows.length) * 100).catch(() => {});
          const decision = effectiveDecision(row);
          let outcome: 'added' | 'matched' | 'skipped' | 'failed';
          let transactionId: string | null = null;
          if (decision === 'fail') {
            outcome = 'failed';
            failed++;
          } else if (decision === 'skip') {
            outcome = 'skipped';
            skipped++;
          } else if (decision === 'match' && row.match_transaction_id) {
            transactionId = row.match_transaction_id;
            await this.confirmMatch(trx, ctx, batch.ledger_account_id, batch.id, row, currency);
            outcome = 'matched';
            matched++;
          } else {
            const suggestion = row.suggestion as RowSuggestion | null;
            const key = row.normalized_desc ?? '';
            const name =
              suggestion?.renamePayee ||
              (suggestion?.merchantId && merchants.get(suggestion.merchantId)) ||
              (row.payee_raw ?? (key ? displayName(key) : (row.description ?? '')));
            // ADR-0012 §7: a category the user picked is reviewed; a confident pipeline result is
            // auto-applied; anything else is posted uncategorized with the suggestion for review.
            const chosen = row.category_id;
            const userSet = Boolean(chosen && suggestion?.userSet);
            const apply = Boolean(chosen && (userSet || suggestion?.autoApply));
            const categorization: StoredCategorization | null = userSet
              ? {
                  step: 'user',
                  confidence: 1,
                  explanation: 'Chosen during import',
                  ruleId: null,
                  suggested: suggestion?.suggested ?? null,
                }
              : suggestion
                ? {
                    step: suggestion.step,
                    confidence: suggestion.confidence,
                    explanation: suggestion.explanation,
                    ruleId: suggestion.ruleId,
                    suggested: suggestion.suggested,
                    transfer: suggestion.transfer ?? null,
                  }
                : null;
            const memberId = row.member_id ?? (apply && !userSet ? (suggestion?.memberId ?? null) : null);
            const rowPayeeKey = (row.payee_raw ? normalizeDescription(row.payee_raw) : key) || null;
            let payeeId = key ? (payees.get(key) ?? null) : null;
            if (key && !payeeId) {
              payeeId = await this.payeeId(trx, ctx, key, name);
              payees.set(key, payeeId);
            }
            transactionId = await this.transactions.createInTrx(trx, ctx, {
              date: row.txn_date!,
              accountId: batch.ledger_account_id,
              amount: { amount: row.amount_minor!.toString(), currency },
              payee: name || null,
              payeeId,
              description: row.description ?? '',
              categoryId: apply ? chosen! : undefined,
              memberId,
              tags: apply && !userSet ? (suggestion?.tags ?? []) : [],
              source: 'import',
              reviewState: userSet ? 'reviewed' : 'auto_applied',
              payeeKey: rowPayeeKey,
              categorization,
              dedupeKey: row.dedupe_key,
              statementDate: row.txn_date,
              rawDescription: row.description,
              clearedAccountId: batch.ledger_account_id,
            });
            if (userSet) {
              const { learned } = await this.categorizer.learn(trx, ctx, {
                transactionId,
                payee: name || null,
                payeeKey: rowPayeeKey,
                amountMinor: row.amount_minor!,
                currency,
                categoryId: chosen,
                memberId,
                previous: categorization && { ...categorization, step: suggestion?.step ?? 'none' },
                previousCategoryId: null,
              });
              await this.transactions.setCategorization(trx, ctx, transactionId, {
                ...categorization!,
                learned,
              });
            }
            sources.push({ transaction_id: transactionId, import_row_id: row.id });
            outcome = 'added';
            added++;
          }
          outcomes.push({ id: row.id, outcome, transaction_id: transactionId });
        }
        // Row bookkeeping in bulk: one statement per 1,000 rows instead of two per row.
        for (let k = 0; k < sources.length; k += 1000) {
          await trx
            .insertInto('app.transaction_source')
            .values(
              sources.slice(k, k + 1000).map((x) => ({
                workspace_id: ctx.workspaceId,
                ...x,
                import_batch_id: batch.id,
                ledger_account_id: batch.ledger_account_id,
                role: 'created' as const,
              })),
            )
            .execute();
        }
        for (let k = 0; k < outcomes.length; k += 1000) {
          const chunk = outcomes.slice(k, k + 1000);
          await sql`
            update app.import_row r set outcome = v.outcome, transaction_id = v.transaction_id::uuid
              from (select * from unnest(${chunk.map((o) => o.id)}::uuid[], ${chunk.map((o) => o.outcome)}::text[],
                                         ${chunk.map((o) => o.transaction_id)}::text[]) as t(id, outcome, transaction_id)) v
             where r.workspace_id = ${ctx.workspaceId} and r.id = v.id`.execute(trx);
        }
        const now = new Date();
        await trx
          .updateTable('app.import_batch')
          .set({
            status: 'committed',
            rows_added: added,
            rows_matched: matched,
            rows_skipped: skipped,
            rows_failed: failed,
            committed_at: now,
            undo_until: new Date(now.getTime() + UNDO_DAYS * 86_400_000),
          })
          .where('workspace_id', '=', ctx.workspaceId)
          .where('id', '=', batch.id)
          .execute();
        await this.saveProfile(trx, ctx, batch);
        // AI-08/09: refresh recurring proposals and anomaly flags with the new rows.
        if (added > 0)
          await this.queue.enqueue(trx, { ...ctx, queue: 'ai', type: 'insights.detect', payload: { batchId } });
        return { added, matched, skipped, failed };
      });
    } catch (err) {
      // The commit rolled back as a whole: put the batch back in preview with the reason (UP-01: no partial import).
      await this.db.run(ctx, (trx) =>
        trx
          .updateTable('app.import_batch')
          .set({ status: 'preview', error: `Commit failed: ${(err as Error).message}`.slice(0, 1000) })
          .where('workspace_id', '=', ctx.workspaceId)
          .where('id', '=', batchId)
          .execute(),
      );
      throw new PermanentJobError('import.commit_failed', (err as Error).message);
    }
  }

  /** The imported row confirms an existing manual or scheduled entry instead of creating a new one. */
  private async confirmMatch(
    trx: Trx,
    ctx: Ctx,
    accountId: string,
    batchId: string,
    row: {
      id: string;
      txn_date: string | null;
      amount_minor: bigint | null;
      description: string | null;
      dedupe_key: string | null;
      match_transaction_id: string | null;
    },
    currency: CurrencyCode,
  ) {
    const id = row.match_transaction_id!;
    const t = await trx
      .selectFrom('app.transaction')
      .selectAll()
      .where('workspace_id', '=', ctx.workspaceId)
      .where('id', '=', id)
      .forUpdate()
      .executeTakeFirstOrThrow();
    const cleared = await this.accountPostings(trx, ctx, id, accountId);
    const before = {
      status: t.status,
      txnDate: t.txn_date,
      spec: t.spec,
      statementDate: t.statement_date,
      rawDescription: t.raw_description,
      dedupeKey: t.dedupe_key,
      cleared: cleared.map((p) => ({ id: p.id, cleared: p.cleared })),
    };
    if (t.status === 'scheduled') {
      await this.transactions.confirmInTrx(trx, ctx, id, {
        amount: { amount: row.amount_minor!.toString(), currency },
        date: calendarDate(row.txn_date!),
      });
    }
    await trx
      .updateTable('app.transaction')
      .set({ statement_date: row.txn_date, raw_description: row.description, dedupe_key: row.dedupe_key })
      .where('workspace_id', '=', ctx.workspaceId)
      .where('id', '=', id)
      .execute();
    await this.markCleared(trx, ctx, id, accountId);
    await trx
      .insertInto('app.transaction_source')
      .values({
        workspace_id: ctx.workspaceId,
        transaction_id: id,
        import_row_id: row.id,
        import_batch_id: batchId,
        ledger_account_id: accountId,
        role: 'matched',
        before_image: JSON.stringify(before),
      })
      .execute();
  }

  private async accountPostings(trx: Trx, ctx: Ctx, transactionId: string, accountId: string) {
    return trx
      .selectFrom('app.posting as p')
      .innerJoin('app.journal_entry as je', (j) =>
        j.onRef('je.workspace_id', '=', 'p.workspace_id').onRef('je.id', '=', 'p.journal_entry_id'),
      )
      .select(['p.id', 'p.cleared'])
      .where('p.workspace_id', '=', ctx.workspaceId)
      .where('je.transaction_id', '=', transactionId)
      .where('p.ledger_account_id', '=', accountId)
      .execute();
  }

  /** Statement lines are cleared by definition (DE-08); reconciliation later locks them. */
  private async markCleared(trx: Trx, ctx: Ctx, transactionId: string, accountId: string) {
    const ids = (await this.accountPostings(trx, ctx, transactionId, accountId))
      .filter((p) => p.cleared === 'uncleared')
      .map((p) => p.id);
    if (ids.length)
      await trx
        .updateTable('app.posting')
        .set({ cleared: 'cleared' })
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', 'in', ids)
        .execute();
  }

  private async payeeId(trx: Trx, ctx: Ctx, key: string, name: string): Promise<string> {
    const row = await trx
      .insertInto('app.payee')
      .values({
        workspace_id: ctx.workspaceId,
        id: newId(),
        display_name: name || displayName(key),
        normalized_key: key,
      })
      .onConflict((oc) =>
        oc.columns(['workspace_id', 'normalized_key']).doUpdateSet({ updated_at: new Date() }),
      )
      .returning('id')
      .executeTakeFirstOrThrow();
    return row.id;
  }

  /** Remembers the mapping for files of the same shape on this account (IMP-04). */
  private async saveProfile(
    trx: Trx,
    ctx: Ctx,
    batch: {
      fingerprint: string | null;
      mapping: unknown;
      ledger_account_id: string;
      file_name: string;
      analysis: unknown;
      mapping_source: string | null;
    },
  ) {
    const opts = batch.analysis as { saveProfile?: boolean } | null;
    if (!batch.fingerprint || !batch.mapping || opts?.saveProfile === false) return;
    await sql`
      insert into app.import_profile (workspace_id, id, name, fingerprint, mapping, ledger_account_id, use_count, last_used_at)
      values (${ctx.workspaceId}, ${newId()}, ${batch.file_name.slice(0, 200)}, ${batch.fingerprint}, ${JSON.stringify(batch.mapping)}::jsonb,
              ${batch.ledger_account_id}, 1, now())
      on conflict (workspace_id, fingerprint, coalesce(ledger_account_id, '00000000-0000-0000-0000-000000000000'))
      do update set mapping = excluded.mapping, use_count = app.import_profile.use_count + 1, last_used_at = now(), updated_at = now()`.execute(
      trx,
    );
  }

  // ------------------------------------------------------------------------------------------------------
  // Undo (IMP-09): void what the batch created, restore what it matched; protected entries are reported.
  // ------------------------------------------------------------------------------------------------------
  async undo(job: Job): Promise<Record<string, unknown>> {
    const ctx = this.ctxOf(job);
    const { batchId } = job.payload as { batchId: string };
    return this.db.run({ ...ctx, actorType: 'worker' }, async (trx) => {
      const sources = await trx
        .selectFrom('app.transaction_source')
        .selectAll()
        .where('workspace_id', '=', ctx.workspaceId)
        .where('import_batch_id', '=', batchId)
        .execute();
      let voided = 0;
      let restored = 0;
      const kept: { transactionId: string; reason: string }[] = [];
      for (const s of sources) {
        const protection = await this.poster.protection(trx, ctx, s.transaction_id);
        if (protection === 'reconciled') {
          kept.push({ transactionId: s.transaction_id, reason: 'reconciled' });
          continue;
        }
        if (s.role === 'created') {
          await this.poster.unpost(trx, ctx, s.transaction_id);
          await trx
            .updateTable('app.transaction')
            .set({ status: 'void', deleted_at: new Date() })
            .where('workspace_id', '=', ctx.workspaceId)
            .where('id', '=', s.transaction_id)
            .execute();
          voided++;
          if (protection === 'closed')
            kept.push({ transactionId: s.transaction_id, reason: 'reversed_in_open_period' });
          continue;
        }
        // Matched: put the entry back as it was before the import.
        const before = s.before_image as {
          status: string;
          txnDate: string;
          spec: unknown;
          statementDate: string | null;
          rawDescription: string | null;
          dedupeKey: string | null;
          cleared: { id: string; cleared: 'uncleared' | 'cleared' | 'reconciled' }[];
        };
        if (before.status === 'scheduled') {
          await this.poster.unpost(trx, ctx, s.transaction_id);
          await trx
            .updateTable('app.transaction')
            .set({
              status: 'scheduled',
              txn_date: before.txnDate,
              spec: JSON.stringify(before.spec),
              posted_at: null,
            })
            .where('workspace_id', '=', ctx.workspaceId)
            .where('id', '=', s.transaction_id)
            .execute();
        } else {
          for (const p of before.cleared) {
            await trx
              .updateTable('app.posting')
              .set({ cleared: p.cleared })
              .where('workspace_id', '=', ctx.workspaceId)
              .where('id', '=', p.id)
              .where('cleared', '<>', 'reconciled')
              .execute();
          }
        }
        await trx
          .updateTable('app.transaction')
          .set({
            statement_date: before.statementDate,
            raw_description: before.rawDescription,
            dedupe_key: before.dedupeKey,
          })
          .where('workspace_id', '=', ctx.workspaceId)
          .where('id', '=', s.transaction_id)
          .execute();
        await trx
          .deleteFrom('app.transaction_source')
          .where('workspace_id', '=', ctx.workspaceId)
          .where('transaction_id', '=', s.transaction_id)
          .where('import_row_id', '=', s.import_row_id)
          .execute();
        restored++;
      }
      await trx
        .updateTable('app.import_batch')
        .set({
          status: 'undone',
          undone_at: new Date(),
          warnings: JSON.stringify(kept.length ? ['partial_undo'] : []),
        })
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', batchId)
        .execute();
      return { voided, restored, kept };
    });
  }
}
