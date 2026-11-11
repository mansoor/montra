/**
 * Switching from another app (IMP-13, ADR-0029). One export holds several accounts; a migration reads it, lets the user
 * map its accounts and categories (or create them), then makes one ordinary import per account, so dedupe, preview,
 * review and undo work as for any statement. Afterwards, transfers between its accounts are paired.
 *
 * It's for a fresh start: a workspace without transactions of its own. Later, the Switch page offers a new workspace
 * instead, so nothing has to be merged into existing books.
 */
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { newId, type Trx } from '@montra/db';
import {
  accountProfile,
  addDays,
  diffDays,
  todayIn,
  type AccountKind,
  type CalendarDate,
  type CurrencyCode,
} from '@montra/domain';
import {
  analyze,
  applyMapping,
  decodeText,
  findAccountColumn,
  parseDelimited,
  pickSheet,
  readXlsx,
  type ParsedRow,
  type Sheet,
} from '@montra/importers';
import { transferSuggestion, type PipelineItem, type TransferCandidate } from '@montra/categorize';
import type {
  AnalyzeMigrationRequest,
  MigrationAnalysisDto,
  MigrationDto,
  MigrationEligibilityDto,
  MigrationSource,
  StartMigrationRequest,
} from '@montra/schemas';
import { AppError, notFound, unprocessable } from '../common/errors.js';
import { Db } from '../db/database.js';
import { STORAGE_PORT, type StoragePort } from '../storage/storage.js';
import { AccountsService } from '../accounts/accounts.service.js';
import { ReviewService } from '../categorization/review.service.js';
import { TransactionsService } from '../transactions/transactions.service.js';
import { ImportsService, fileTypeOf } from './imports.service.js';

type Ctx = { workspaceId: string; userId: string };

/** One account's rows in one file of the export. */
interface AccountRows {
  fileId: string;
  /** The value to filter on (the account column), or null when the file is one account. */
  filter: string | null;
  rows: ParsedRow[];
  opening: bigint | null;
  group: (row: ParsedRow) => string | null;
}

interface ReadFile {
  fileId: string;
  fileName: string;
  template: string | null;
  problem: MigrationAnalysisDto['files'][number]['problem'];
  accounts: Map<string, AccountRows>;
}

const TRANSFER = /\b(transfer|xfer|credit card payment|card payment|balance adjustment|internal)\b/i;

/** A guess at a new account's kind from its name in the export. */
function kindFromName(name: string): AccountKind {
  const n = name.toLowerCase();
  if (/credit|card|visa|amex|american express|mastercard|discover/.test(n)) return 'credit_card';
  if (/mortgage/.test(n)) return 'mortgage';
  if (/loan|student|auto loan/.test(n)) return 'loan';
  if (/line of credit|heloc/.test(n)) return 'line_of_credit';
  if (/saving/.test(n)) return 'savings';
  if (/cash|wallet/.test(n)) return 'cash';
  if (/invest|brokerage|401|ira|roth|retirement/.test(n)) return 'investment';
  return 'checking';
}

@Injectable()
export class MigrationsService {
  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(STORAGE_PORT) private readonly storage: StoragePort,
    @Inject(AccountsService) private readonly accounts: AccountsService,
    @Inject(ReviewService) private readonly review: ReviewService,
    @Inject(TransactionsService) private readonly transactions: TransactionsService,
    @Inject(ImportsService) private readonly imports: ImportsService,
  ) {}

  /** Transactions of the workspace's own: anything not imported by an earlier switch. */
  async eligibility(ctx: Ctx): Promise<MigrationEligibilityDto> {
    return this.db.run(ctx, (trx) => this.eligibilityIn(trx, ctx));
  }

  private async eligibilityIn(trx: Trx, ctx: Ctx): Promise<MigrationEligibilityDto> {
    const row = await sql<{ n: string }>`
      select count(*)::text as n
        from app.transaction t
       where t.workspace_id = ${ctx.workspaceId}
         and t.deleted_at is null and t.status <> 'void'
         and not exists (
           select 1 from app.transaction_source s
             join app.import_batch b on b.workspace_id = s.workspace_id and b.id = s.import_batch_id
            where s.workspace_id = t.workspace_id and s.transaction_id = t.id and b.migration_id is not null)`.execute(
      trx,
    );
    const n = Number(row.rows[0]?.n ?? 0);
    return { eligible: n === 0, transactions: n };
  }

  async analyze(ctx: Ctx, req: AnalyzeMigrationRequest): Promise<MigrationAnalysisDto> {
    return this.db.run(ctx, async (trx) => {
      const ws = await trx
        .selectFrom('app.workspace')
        .select(['base_currency', 'time_zone'])
        .where('id', '=', ctx.workspaceId)
        .executeTakeFirstOrThrow();
      const currency = ws.base_currency as CurrencyCode;
      const files = await this.read(trx, ctx, req.fileIds, currency, req.inverted);
      const existingAccounts = await trx
        .selectFrom('app.ledger_account as a')
        .innerJoin('app.bank_account as b', 'b.ledger_account_id', 'a.id')
        .select(['a.id', 'a.name'])
        .where('a.workspace_id', '=', ctx.workspaceId)
        .where('a.archived_at', 'is', null)
        .execute();
      const entityId = await this.personalEntity(trx, ctx);
      const existingCategories = await trx
        .selectFrom('app.ledger_account')
        .select(['id', 'name'])
        .where('workspace_id', '=', ctx.workspaceId)
        .where('entity_id', '=', entityId)
        .where('is_category', '=', true)
        .where('system_role', 'is', null)
        .where('archived_at', 'is', null)
        .execute();
      const accountByName = new Map(existingAccounts.map((a) => [a.name.toLowerCase(), a.id]));
      const categoryByName = new Map(existingCategories.map((c) => [c.name.toLowerCase(), c.id]));

      const accounts = new Map<string, AccountRows[]>();
      for (const f of files)
        for (const [key, a] of f.accounts) accounts.set(key, [...(accounts.get(key) ?? []), a]);
      const categories = new Map<
        string,
        { group: string | null; rows: number; moneyIn: bigint; moneyOut: bigint }
      >();
      for (const list of accounts.values())
        for (const a of list)
          for (const r of a.rows) {
            const name = r.category?.trim();
            if (!name) continue;
            const c = categories.get(name) ?? { group: a.group(r), rows: 0, moneyIn: 0n, moneyOut: 0n };
            c.rows++;
            if (r.amount > 0n) c.moneyIn += r.amount;
            else c.moneyOut -= r.amount;
            categories.set(name, c);
          }

      return {
        source: req.source,
        currency,
        files: files.map((f) => ({
          fileId: f.fileId,
          fileName: f.fileName,
          template: f.template,
          rows: [...f.accounts.values()].reduce((n, a) => n + a.rows.length, 0),
          problem: f.problem,
        })),
        accounts: [...accounts.entries()].map(([key, list]) => {
          const rows = list.flatMap((a) => a.rows);
          const dates = rows.map((r) => r.date).sort();
          const opening = list.some((a) => a.opening !== null)
            ? list.reduce((t, a) => t + (a.opening ?? 0n), 0n)
            : null;
          return {
            key,
            rows: rows.length,
            from: dates[0] ?? null,
            to: dates.at(-1) ?? null,
            moneyIn: String(rows.reduce((t, r) => (r.amount > 0n ? t + r.amount : t), 0n)),
            moneyOut: String(rows.reduce((t, r) => (r.amount < 0n ? t - r.amount : t), 0n)),
            opening: opening === null ? null : String(opening),
            matchId: accountByName.get(key.toLowerCase()) ?? null,
            suggestedKind: kindFromName(key),
          };
        }),
        categories: [...categories.entries()]
          .sort((a, b) => b[1].rows - a[1].rows)
          .map(([name, c]) => ({
            name,
            group: c.group,
            rows: c.rows,
            moneyIn: String(c.moneyIn),
            moneyOut: String(c.moneyOut),
            matchId: categoryByName.get(name.toLowerCase()) ?? null,
            transfer: TRANSFER.test(name) || TRANSFER.test(c.group ?? ''),
          })),
      };
    });
  }

  /** Creates the new accounts and categories, then one import per account and file (they parse into previews). */
  async start(ctx: Ctx, req: StartMigrationRequest): Promise<MigrationDto> {
    const id = newId();
    const batches: { fileId: string; accountId: string; filter: string | null }[] = [];
    await this.db.run(ctx, async (trx) => {
      const eligible = await this.eligibilityIn(trx, ctx);
      if (!eligible.eligible)
        throw new AppError(
          409,
          'migration.not_fresh',
          'Switching from another app is for a fresh start: this workspace already has transactions. Start a new workspace for the import.',
        );
      const ws = await trx
        .selectFrom('app.workspace')
        .select(['base_currency', 'time_zone'])
        .where('id', '=', ctx.workspaceId)
        .executeTakeFirstOrThrow();
      const currency = ws.base_currency as CurrencyCode;
      const entityId = req.entityId ?? (await this.personalEntity(trx, ctx));
      const files = await this.read(trx, ctx, req.fileIds, currency, req.inverted);
      const bad = files.find((f) => f.problem);
      if (bad)
        throw unprocessable(
          'migration.file',
          `${bad.fileName} can't be read here; import it on the Import page`,
        );
      const today = todayIn(ws.time_zone);

      // Categories first, so the plan can map names to ids.
      const categoryMap: Record<string, string | null> = {};
      for (const c of req.categories) {
        const key = c.name.trim().toLowerCase();
        if (c.target.type === 'skip') categoryMap[key] = null;
        else if (c.target.type === 'existing') categoryMap[key] = c.target.categoryId;
        else
          categoryMap[key] = await this.review.createCategory(trx, ctx, entityId, currency, {
            name: c.target.name,
            group: c.target.group,
            kind: c.target.kind,
          });
      }
      await trx
        .insertInto('app.import_migration')
        .values({
          workspace_id: ctx.workspaceId,
          id,
          source: req.source,
          plan: JSON.stringify({ categories: categoryMap, inverted: req.inverted }),
          created_by: ctx.userId,
        })
        .execute();

      for (const a of req.accounts) {
        if (a.target.type === 'skip') continue;
        const parts = files.flatMap((f) => (f.accounts.has(a.key) ? [f.accounts.get(a.key)!] : []));
        if (!parts.length) throw unprocessable('migration.account', `No rows for ${a.key} in these files`);
        let accountId: string;
        if (a.target.type === 'existing') accountId = a.target.accountId;
        else {
          const rows = parts.flatMap((p) => p.rows);
          const first = rows.map((r) => r.date).sort()[0] ?? today;
          const net = rows.reduce((t, r) => t + r.amount, 0n);
          const liability = accountProfile(a.target.kind).side === 'liability';
          // The opening balance (natural: what you have, or owe) that ends at today's balance; else the export's own.
          const fileOpening = parts.some((p) => p.opening !== null)
            ? parts.reduce((t, p) => t + (p.opening ?? 0n), 0n)
            : 0n;
          const opening = a.target.balance
            ? liability
              ? BigInt(a.target.balance.amount) + net
              : BigInt(a.target.balance.amount) - net
            : liability
              ? -fileOpening
              : fileOpening;
          accountId = await this.accounts.createIn(trx, ctx, {
            name: a.target.name,
            kind: a.target.kind,
            entityId,
            openingBalance: { amount: String(opening), currency },
            openingDate: addDays(first, -1),
          } as Parameters<AccountsService['createIn']>[2]);
        }
        for (const p of parts) batches.push({ fileId: p.fileId, accountId, filter: p.filter });
      }
    });
    // Each import parses on its own (the existing pipeline), tagged with the migration so it uses the plan.
    for (const b of batches)
      await this.imports.create(
        ctx,
        {
          fileId: b.fileId,
          accountId: b.accountId,
          ...(b.filter !== null ? { accountFilter: b.filter } : {}),
        },
        { migrationId: id },
      );
    return this.get(ctx, id);
  }

  async get(ctx: Ctx, id: string): Promise<MigrationDto> {
    return this.db.run(ctx, async (trx) => {
      const m = await trx
        .selectFrom('app.import_migration')
        .selectAll()
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', id)
        .executeTakeFirst();
      if (!m) throw notFound('Migration');
      const rows = await trx
        .selectFrom('app.import_batch as b')
        .innerJoin('app.ledger_account as a', 'a.id', 'b.ledger_account_id')
        .select([
          'b.id',
          'b.ledger_account_id',
          'a.name',
          'b.file_name',
          'b.status',
          'b.rows_read',
          'b.rows_added',
          'b.rows_matched',
          'b.error',
        ])
        .where('b.workspace_id', '=', ctx.workspaceId)
        .where('b.migration_id', '=', id)
        .orderBy('a.name')
        .execute();
      const live = rows.filter((r) => r.status !== 'undone' && r.status !== 'failed');
      return {
        id: m.id,
        source: m.source as MigrationSource,
        createdAt: new Date(m.created_at).toISOString(),
        batches: rows.map((r) => ({
          batchId: r.id,
          accountId: r.ledger_account_id,
          accountName: r.name,
          fileName: r.file_name,
          status: r.status,
          rowsRead: Number(r.rows_read),
          rowsAdded: Number(r.rows_added),
          rowsMatched: Number(r.rows_matched),
          error: r.error,
        })),
        ready: live.length > 0 && live.every((r) => r.status === 'preview' || r.status === 'committed'),
        done: live.length > 0 && live.every((r) => r.status === 'committed'),
        transferPairs: (await this.pairs(trx, ctx, id)).length,
      };
    });
  }

  /** Imports every previewed batch (each commits as its own job, as on the Import page). */
  async commit(ctx: Ctx, id: string): Promise<MigrationDto> {
    const m = await this.get(ctx, id);
    for (const b of m.batches) if (b.status === 'preview') await this.imports.commit(ctx, b.batchId);
    return this.get(ctx, id);
  }

  /** Makes the paired transfers between the migration's accounts. */
  async makeTransfers(ctx: Ctx, id: string): Promise<{ made: number; migration: MigrationDto }> {
    const made = await this.db.run(ctx, async (trx) => {
      const pairs = await this.pairs(trx, ctx, id);
      for (const p of pairs)
        await this.transactions.makeTransferInTrx(trx, ctx, p.id, {
          accountId: p.otherAccountId,
          counterpartId: p.otherId,
        });
      return pairs.length;
    });
    return { made, migration: await this.get(ctx, id) };
  }

  /**
   * Transfers between the migration's own accounts: its uncategorized transactions with the opposite amount on another
   * of its accounts within 3 days, where the text says so (a payment or transfer word, YNAB's "Transfer : Savings", or
   * the other account's last 4 digits). One-to-one, closest date first.
   */
  private async pairs(
    trx: Trx,
    ctx: Ctx,
    id: string,
  ): Promise<{ id: string; otherId: string; otherAccountId: string }[]> {
    const { rows } = await sql<{
      id: string;
      account_id: string;
      account_name: string;
      amount: string;
      date: string;
      payee: string | null;
      description: string;
    }>`
      select distinct t.id, t.spec->>'accountId' as account_id, a.name as account_name, t.spec->>'amount' as amount,
             t.txn_date::text as date, t.payee_raw as payee, coalesce(t.raw_description, t.description) as description
        from app.transaction t
        join app.transaction_source s on s.workspace_id = t.workspace_id and s.transaction_id = t.id
        join app.import_batch b on b.workspace_id = s.workspace_id and b.id = s.import_batch_id
        join app.ledger_account a on a.workspace_id = t.workspace_id and a.id = (t.spec->>'accountId')::uuid
       where t.workspace_id = ${ctx.workspaceId} and b.migration_id = ${id}
         and t.deleted_at is null and t.status = 'posted'
         and t.spec->>'type' = 'standard' and (t.spec->>'uncategorized')::boolean is true
         and jsonb_array_length(t.spec->'splits') = 1`.execute(trx);
    const candidates: (TransferCandidate & { accountName: string })[] = rows.map((r) => ({
      transactionId: r.id,
      accountId: r.account_id,
      accountName: r.account_name,
      accountLast4: null,
      amountMinor: BigInt(r.amount),
      date: r.date as CalendarDate,
    }));
    const used = new Set<string>();
    const out: { id: string; otherId: string; otherAccountId: string }[] = [];
    for (const r of [...rows].sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id))) {
      if (used.has(r.id)) continue;
      const item = {
        id: r.id,
        accountId: r.account_id,
        amountMinor: BigInt(r.amount),
        date: r.date as CalendarDate,
        payee: r.payee,
        description: r.description,
        rawDescription: r.description,
      } as unknown as PipelineItem;
      const s = transferSuggestion(
        item,
        candidates.filter(
          (c) =>
            !used.has(c.transactionId!) &&
            c.transactionId !== r.id &&
            Math.abs(diffDays(c.date, item.date)) <= 3,
        ),
      );
      if (!s || s.confidence < 0.95 || !s.candidate.transactionId) continue;
      used.add(r.id);
      used.add(s.candidate.transactionId);
      out.push({ id: r.id, otherId: s.candidate.transactionId, otherAccountId: s.candidate.accountId });
    }
    return out;
  }

  /** Reads each file into its accounts' rows (CSV, TSV and XLSX; other files go through the Import page). */
  private async read(
    trx: Trx,
    ctx: Ctx,
    fileIds: readonly string[],
    currency: CurrencyCode,
    inverted: readonly string[] = [],
  ): Promise<ReadFile[]> {
    const out: ReadFile[] = [];
    for (const fileId of fileIds) {
      const file = await trx
        .selectFrom('app.file')
        .select(['id', 'file_name', 'mime', 'storage_key'])
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', fileId)
        .where('deleted_at', 'is', null)
        .executeTakeFirst();
      if (!file) throw notFound('Uploaded file');
      const base: ReadFile = {
        fileId,
        fileName: file.file_name,
        template: null,
        problem: null,
        accounts: new Map(),
      };
      const type = fileTypeOf(file.mime, file.file_name);
      if (type !== 'csv' && type !== 'xlsx') {
        out.push({ ...base, problem: 'unsupported_type' });
        continue;
      }
      let sheets: Sheet[];
      try {
        const bytes = await this.storage.get(file.storage_key);
        sheets = type === 'xlsx' ? await readXlsx(bytes) : [parseDelimited(decodeText(bytes).text)];
      } catch {
        out.push({ ...base, problem: 'unreadable' });
        continue;
      }
      const a = analyze(sheets, { fileType: type, currency, accountType: 'asset' });
      const proposal = a.proposal as typeof a.proposal & { groupColumn?: number | null };
      const template = proposal.templateId ?? null;
      if (!template && proposal.confidence < 0.75) {
        out.push({ ...base, problem: 'needs_mapping' });
        continue;
      }
      const sheet = pickSheet(sheets);
      const accountColumn =
        proposal.accountColumn ?? (proposal.header ? findAccountColumn(proposal.header) : null) ?? null;
      const groupColumn = proposal.groupColumn ?? null;
      const group = (r: ParsedRow) =>
        groupColumn !== null ? (r.raw[groupColumn] ?? '').trim() || null : null;
      const { filter: _, ...given } = proposal.mapping;
      const mapping = inverted.includes(fileId)
        ? { ...given, sign: given.sign === 'inverted' ? ('normal' as const) : ('inverted' as const) }
        : given;
      const keys =
        accountColumn !== null
          ? [...new Set(a.parsed.rows.map((r) => (r.raw[accountColumn] ?? '').trim()).filter(Boolean))]
          : [];
      // Openings (YNAB's Starting Balance) are skipped rows, so each account is parsed on its own to find its own.
      const accounts = new Map<string, AccountRows>();
      if (accountColumn === null) {
        const p = applyMapping(sheet, mapping, currency);
        accounts.set(file.file_name, { fileId, filter: null, rows: p.rows, opening: p.opening, group });
      } else {
        for (const key of keys) {
          const p = applyMapping(
            sheet,
            { ...mapping, filter: { column: accountColumn, values: [key] } },
            currency,
          );
          accounts.set(key, { fileId, filter: key, rows: p.rows, opening: p.opening, group });
        }
      }
      const rows = [...accounts.values()].reduce((n, x) => n + x.rows.length, 0);
      out.push({ ...base, template, accounts, problem: rows === 0 ? 'no_transactions' : null });
    }
    return out;
  }

  private async personalEntity(trx: Trx, ctx: Ctx): Promise<string> {
    const row = await trx
      .selectFrom('app.entity')
      .select('id')
      .where('workspace_id', '=', ctx.workspaceId)
      .where('archived_at', 'is', null)
      .orderBy(sql`case when type = 'personal' then 0 else 1 end`)
      .orderBy('created_at')
      .executeTakeFirst();
    if (!row) throw notFound('Entity');
    return row.id;
  }
}
