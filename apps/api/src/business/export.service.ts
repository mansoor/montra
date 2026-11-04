/**
 * Accountant export (BIZ-13, ADR-0017 §8): the journal for a date range as CSV, XLSX, a QuickBooks Desktop IIF journal or
 * a Xero manual-journal CSV. Read under RLS, so an accountant gets only the entities they were granted. Account names
 * won't match another chart exactly, so the importing tool will ask to map them.
 */
import { Inject, Injectable } from '@nestjs/common';
import ExcelJS from 'exceljs';
import { sql } from 'kysely';
import { asCurrencyCode, toDecimalString, money, type CalendarDate } from '@montra/domain';
import type { AccountingExportFormat } from '@montra/schemas';
import { Db } from '../db/database.js';
import { businessEntity, dateOf, type Ctx } from './shared.js';

export interface JournalLine {
  entryId: string;
  date: string;
  kind: string;
  description: string;
  payee: string;
  account: string;
  accountType: string;
  taxLine: string;
  /** Decimal with debits positive. */
  amount: string;
  currency: string;
}

const CONTENT_TYPES: Record<AccountingExportFormat, { mime: string; ext: string }> = {
  csv: { mime: 'text/csv; charset=utf-8', ext: 'csv' },
  xlsx: { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ext: 'xlsx' },
  quickbooks_iif: { mime: 'application/octet-stream', ext: 'iif' },
  xero_csv: { mime: 'text/csv; charset=utf-8', ext: 'csv' },
};

/**
 * Text a spreadsheet would run as a formula gets a leading apostrophe (OWASP CSV injection). Payees come from bank
 * statements, so they're not ours to trust. Amounts don't pass through this: a negative number is a number.
 */
function safeText(s: string): string {
  return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
}

function csvCell(s: string): string {
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const csv = (rows: string[][]): string => rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';

export function toCsv(lines: readonly JournalLine[]): string {
  return csv([
    [
      'Entry',
      'Date',
      'Kind',
      'Description',
      'Payee',
      'Account',
      'Account type',
      'Tax line',
      'Debit',
      'Credit',
      'Currency',
    ],
    ...lines.map((l) => {
      const credit = l.amount.startsWith('-');
      return [
        l.entryId,
        l.date,
        l.kind,
        safeText(l.description),
        safeText(l.payee),
        safeText(l.account),
        l.accountType,
        l.taxLine,
        credit ? '' : l.amount,
        credit ? l.amount.slice(1) : '',
        l.currency,
      ];
    }),
  ]);
}

const iifText = (s: string) => s.replace(/[\t\r\n"]/g, ' ').trim();
const usDate = (iso: string) => {
  const [y, m, d] = iso.split('-');
  return `${m}/${d}/${y}`;
};

/**
 * QuickBooks Desktop IIF: one balanced GENERAL JOURNAL per entry. The first line is TRNS and the rest SPL. QuickBooks
 * treats positive amounts as debits on these rows.
 */
export function toIif(lines: readonly JournalLine[]): string {
  const out = [
    '!TRNS\tTRNSTYPE\tDATE\tACCNT\tNAME\tAMOUNT\tMEMO',
    '!SPL\tTRNSTYPE\tDATE\tACCNT\tNAME\tAMOUNT\tMEMO',
    '!ENDTRNS',
  ];
  const groups = new Map<string, JournalLine[]>();
  for (const l of lines) groups.set(l.entryId, [...(groups.get(l.entryId) ?? []), l]);
  for (const group of groups.values()) {
    group.forEach((l, i) => {
      out.push(
        [
          i === 0 ? 'TRNS' : 'SPL',
          'GENERAL JOURNAL',
          usDate(l.date),
          iifText(l.account),
          iifText(l.payee),
          l.amount,
          iifText(l.description),
        ].join('\t'),
      );
    });
    out.push('ENDTRNS');
  }
  return out.join('\r\n') + '\r\n';
}

/** Xero's manual-journal import template. Positive amounts are debits. Tax is out of scope, so every line is exempt. */
export function toXero(lines: readonly JournalLine[]): string {
  return csv([
    ['*Narration', '*Date', 'Description', '*AccountCode', '*TaxRate', '*Amount'],
    ...lines.map((l) => [
      safeText(l.description || l.payee || 'Journal'),
      usDate(l.date),
      safeText(l.payee),
      safeText(l.account),
      'Tax Exempt',
      l.amount,
    ]),
  ]);
}

export async function toXlsx(lines: readonly JournalLine[]): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet('Journal');
  sheet.columns = [
    { header: 'Entry', key: 'entry', width: 38 },
    { header: 'Date', key: 'date', width: 12 },
    { header: 'Kind', key: 'kind', width: 14 },
    { header: 'Description', key: 'description', width: 36 },
    { header: 'Payee', key: 'payee', width: 28 },
    { header: 'Account', key: 'account', width: 28 },
    { header: 'Account type', key: 'type', width: 12 },
    { header: 'Tax line', key: 'taxLine', width: 14 },
    { header: 'Debit', key: 'debit', width: 14 },
    { header: 'Credit', key: 'credit', width: 14 },
    { header: 'Currency', key: 'currency', width: 9 },
  ];
  for (const l of lines) {
    const credit = l.amount.startsWith('-');
    sheet.addRow({
      entry: l.entryId,
      date: l.date,
      kind: l.kind,
      description: safeText(l.description),
      payee: safeText(l.payee),
      account: safeText(l.account),
      type: l.accountType,
      taxLine: l.taxLine,
      debit: credit ? '' : l.amount,
      credit: credit ? l.amount.slice(1) : '',
      currency: l.currency,
    });
  }
  sheet.getRow(1).font = { bold: true };
  return new Uint8Array(await wb.xlsx.writeBuffer());
}

@Injectable()
export class ExportService {
  constructor(@Inject(Db) private readonly db: Db) {}

  async lines(ctx: Ctx, entityId: string, from: CalendarDate, to: CalendarDate): Promise<JournalLine[]> {
    return this.db.run(ctx, async (trx) => {
      await businessEntity(trx, ctx, entityId);
      const { rows } = await sql<{
        entry_id: string;
        d: string;
        kind: string;
        description: string | null;
        payee: string | null;
        account: string;
        type: string;
        tax_line: string | null;
        amount: string;
        currency: string;
      }>`
        select je.id as entry_id, je.entry_date::text as d, je.kind, coalesce(je.description, t.description) as description,
               t.payee_raw as payee, a.name as account, a.type, a.tax_line_code as tax_line,
               p.functional_amount_minor::text as amount, e.functional_currency as currency
          from app.posting p
          join app.journal_entry je on je.workspace_id = p.workspace_id and je.id = p.journal_entry_id
          join app.entity e on e.workspace_id = p.workspace_id and e.id = p.entity_id
          join app.ledger_account a on a.workspace_id = p.workspace_id and a.id = p.ledger_account_id
          left join app.transaction t on t.workspace_id = je.workspace_id and t.id = je.transaction_id
         where p.workspace_id = ${ctx.workspaceId} and p.entity_id = ${entityId}
           and p.entry_date between ${from} and ${to}
         order by je.entry_date, je.id, p.line_no`.execute(trx);
      return rows.map((r) => ({
        entryId: r.entry_id,
        date: String(dateOf(r.d)),
        kind: r.kind,
        description: r.description ?? '',
        payee: r.payee ?? '',
        account: r.account,
        accountType: r.type,
        taxLine: r.tax_line ?? '',
        amount: toDecimalString(money(BigInt(r.amount), asCurrencyCode(r.currency))),
        currency: r.currency,
      }));
    });
  }

  async export(
    ctx: Ctx,
    q: { entityId: string; from: CalendarDate; to: CalendarDate; format: AccountingExportFormat },
  ): Promise<{ bytes: Uint8Array; mime: string; fileName: string }> {
    const lines = await this.lines(ctx, q.entityId, q.from, q.to);
    const { mime, ext } = CONTENT_TYPES[q.format];
    const fileName = `journal-${q.from}-to-${q.to}${q.format === 'xero_csv' ? '-xero' : ''}.${ext}`;
    const bytes =
      q.format === 'xlsx'
        ? await toXlsx(lines)
        : new TextEncoder().encode(
            q.format === 'csv' ? toCsv(lines) : q.format === 'quickbooks_iif' ? toIif(lines) : toXero(lines),
          );
    return { bytes, mime, fileName };
  }
}
