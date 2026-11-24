/**
 * The document summary (ADR-0057 §3): what a rendered PDF's cover page says about the document it was made from. One
 * model, so other kinds of document can have a cover later; only statements have one now (VLT-13).
 *
 * Built from Montra's own records, never from the file: the account, the import batch and its parsed rows.
 */
import type { BankAccountKind, ImportBatchTable, Trx } from '@montra/db';
import { maskLast4, type CalendarDate } from '@montra/domain';
import type { Selectable } from 'kysely';
import { fileTypeOf } from '../imports/imports.service.js';

/** "Account number on the cover" (ADR-0057 §3). Full is only ever passed in by the caller, never chosen here. */
export type AccountNumberChoice = 'last4' | 'full' | 'none';

/** How much the cover says (ADR-0057 §3): the vault's "Describe documents in more detail" switch, and the number. */
export interface CoverOptions {
  detail: boolean;
  accountNumber: AccountNumberChoice;
}

/** The original file, as the cover names it. */
export interface OriginalFacts {
  fileName: string;
  /** CSV, XLS, OFX and so on. */
  format: string;
  sha256: string;
  /** The day the import was committed (UTC), else the day the file was uploaded. */
  importedOn: CalendarDate;
}

/** A statement's figures, from the batch and its rows. Shown only with the detail switch on. */
export interface StatementFigures {
  opening: bigint | null;
  closing: bigint | null;
  moneyIn: bigint;
  /** Positive: the sum of the rows that took money out. */
  moneyOut: bigint;
  count: number;
  balanceCheck: 'ok' | 'mismatch' | 'n_a';
}

export interface StatementSummary {
  kind: 'statement';
  /** Null when no import ever said which account the file is for. */
  account: { name: string; institution: string | null; type: string } | null;
  holders: string[];
  /** As the cover shows it ("••••1234", or the full number only when Full was passed in), or null. */
  accountNumber: string | null;
  currency: string | null;
  /** The statement's own dates when the file had them, else its first and last transaction dates. */
  period: { start: CalendarDate; end: CalendarDate; from: 'statement' | 'transactions' } | null;
  /** Null when the file couldn't be read into rows. */
  figures: StatementFigures | null;
  original: OriginalFacts;
}

/** Every kind of document that can have a cover. Statements only, for now. */
export type DocumentSummary = StatementSummary;

/** One parsed row of the statement, as the PDF draws it. `balance` is the running balance, when known. */
export interface StatementLine {
  date: CalendarDate;
  description: string;
  amount: bigint;
  balance: bigint | null;
}

const ACCOUNT_TYPES: Record<BankAccountKind, string> = {
  checking: 'Checking',
  savings: 'Savings',
  credit_card: 'Credit card',
  cash: 'Cash',
  loan: 'Loan',
  mortgage: 'Mortgage',
  line_of_credit: 'Line of credit',
  investment: 'Investment',
  asset: 'Asset',
  liability: 'Liability',
};

const FORMATS: Record<string, string> = {
  csv: 'CSV',
  xlsx: 'XLSX',
  xls: 'XLS',
  pdf: 'PDF',
  qif: 'QIF',
  ofx: 'OFX',
};

/**
 * The account number as the cover shows it. `full` shows the full number only when there is one, else the last four;
 * `none` shows nothing.
 */
export function accountNumberDisplay(
  choice: AccountNumberChoice,
  last4: string | null,
  full: string | null,
): string | null {
  if (choice === 'none') return null;
  if (choice === 'full' && full) return full;
  return maskLast4(last4);
}

/**
 * The rows in the order they happened, each with its running balance, and the totals. A file listed newest first is
 * turned round whole, so rows on the same day keep the bank's order. The running balance is the bank's own when every
 * row has one, else worked out from the opening balance (or back from the closing one), else not shown.
 */
export function statementLines(
  rows: readonly { date: CalendarDate; description: string; amount: bigint; balance: bigint | null }[],
  opening: bigint | null,
  closing: bigint | null,
): { lines: StatementLine[]; moneyIn: bigint; moneyOut: bigint } {
  const newestFirst = rows.length > 1 && rows[0]!.date > rows[rows.length - 1]!.date;
  const ordered = (newestFirst ? [...rows].reverse() : [...rows])
    .map((r, i) => ({ r, i }))
    .sort((a, b) => (a.r.date < b.r.date ? -1 : a.r.date > b.r.date ? 1 : a.i - b.i))
    .map(({ r }) => r);
  let moneyIn = 0n;
  let moneyOut = 0n;
  for (const r of ordered) {
    if (r.amount > 0n) moneyIn += r.amount;
    else moneyOut -= r.amount;
  }
  const own = ordered.length > 0 && ordered.every((r) => r.balance !== null);
  const start = opening ?? (closing !== null ? closing - (moneyIn - moneyOut) : null);
  let running = start;
  const lines = ordered.map((r) => {
    if (running !== null) running += r.amount;
    return {
      date: r.date,
      description: r.description,
      amount: r.amount,
      balance: own ? r.balance : running,
    };
  });
  return { lines, moneyIn, moneyOut };
}

type Batch = Selectable<ImportBatchTable>;

/** The file being rendered, as read under the caller's row-level security. */
export interface SourceFile {
  id: string;
  file_name: string;
  mime: string;
  sha256: string;
  created_at: Date;
}

const utcDay = (d: Date) => d.toISOString().slice(0, 10) as CalendarDate;

/**
 * The facts for a statement's cover, in one place.
 *
 * `batch` is the committed import the rows come from, or, for a file that couldn't be read, its latest import of any
 * kind (which still says the account), or null. `lines` are the drawn rows, or null when there are none to draw.
 */
export async function statementFacts(
  trx: Trx,
  workspaceId: string,
  file: SourceFile,
  batch: Batch | null,
  lines: { moneyIn: bigint; moneyOut: bigint; count: number } | null,
  choice: AccountNumberChoice,
): Promise<StatementSummary> {
  const account = batch
    ? await trx
        .selectFrom('app.ledger_account as a')
        .innerJoin('app.entity as e', (j) =>
          j.onRef('e.workspace_id', '=', 'a.workspace_id').onRef('e.id', '=', 'a.entity_id'),
        )
        .leftJoin('app.bank_account as b', (j) =>
          j.onRef('b.workspace_id', '=', 'a.workspace_id').onRef('b.ledger_account_id', '=', 'a.id'),
        )
        .leftJoin('app.family_member as m', (j) =>
          j.onRef('m.workspace_id', '=', 'b.workspace_id').onRef('m.id', '=', 'b.default_member_id'),
        )
        .select([
          'a.name',
          'a.type',
          'e.name as book',
          'b.kind',
          'b.institution',
          'b.last4',
          'm.name as member',
        ])
        .where('a.workspace_id', '=', workspaceId)
        .where('a.id', '=', batch.ledger_account_id)
        .executeTakeFirst()
    : undefined;

  // ADR-0057 §5/§6, until the account holders and the sealed full number exist (ADR-0057 plan, PR 1): the holders are
  // the account's default member, else its book's name; the number is the last four only. PR 1 replaces this block:
  // holders from the account's holder list (default member, then book, only when it has none), and, when the caller
  // passed `full`, the full number unsealed here (never logged). Nothing else in rendering changes.
  const holders = account ? [account.member ?? account.book] : [];
  const fullNumber: string | null = null;
  const accountNumber = account ? accountNumberDisplay(choice, account.last4, fullNumber) : null;
  // End of ADR-0057 §5/§6.

  const statement = (batch?.analysis as { statement?: { periodStart?: string; periodEnd?: string } } | null)
    ?.statement;
  const period =
    statement?.periodStart && statement.periodEnd && statement.periodStart <= statement.periodEnd
      ? {
          start: statement.periodStart as CalendarDate,
          end: statement.periodEnd as CalendarDate,
          from: 'statement' as const,
        }
      : batch?.min_date && batch.max_date && lines
        ? {
            start: batch.min_date as CalendarDate,
            end: batch.max_date as CalendarDate,
            from: 'transactions' as const,
          }
        : null;

  const format =
    batch && batch.file_type !== 'feed' ? batch.file_type : fileTypeOf(file.mime, file.file_name);
  return {
    kind: 'statement',
    account: account
      ? {
          name: account.name,
          institution: account.institution,
          type: account.kind
            ? ACCOUNT_TYPES[account.kind]
            : account.type === 'liability'
              ? 'Liability'
              : 'Asset',
        }
      : null,
    holders,
    accountNumber,
    currency: batch?.currency ?? null,
    period,
    figures:
      batch && lines
        ? {
            opening: batch.statement_opening_minor === null ? null : BigInt(batch.statement_opening_minor),
            closing: batch.statement_closing_minor === null ? null : BigInt(batch.statement_closing_minor),
            moneyIn: lines.moneyIn,
            moneyOut: lines.moneyOut,
            count: lines.count,
            balanceCheck: batch.balance_check,
          }
        : null,
    original: {
      fileName: file.file_name,
      format: format ? (FORMATS[format] ?? format.toUpperCase()) : 'Unknown',
      sha256: file.sha256,
      importedOn: utcDay(batch?.committed_at ?? file.created_at),
    },
  };
}
