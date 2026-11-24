import { PDFDocument } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import type { CalendarDate } from '@montra/domain';
import {
  accountNumberDisplay,
  statementLines,
  type StatementLine,
  type StatementSummary,
} from '../src/renditions/document-summary.js';
import {
  coverLines,
  renderStatementPdf,
  RENDERED_NOTE,
  UNREADABLE_NOTE,
  type DrawnText,
  type StatementPdfInput,
} from '../src/renditions/statement-pdf.js';
import { attachments, coverText, drawnRows, drawnTotals } from './fakes/statement-pdf-view.js';

// VLT-13 (ADR-0057 §2, §3): the statement PDF renderer and its cover, without a database.

const d = (s: string) => s as CalendarDate;
const FULL = '9876543211234';

function summary(over: Partial<StatementSummary> = {}): StatementSummary {
  return {
    kind: 'statement',
    account: { name: 'Everyday Checking', institution: 'First Bank', type: 'Checking' },
    holders: ['Sam Rivera'],
    accountNumber: '••••1234',
    currency: 'USD',
    period: { start: d('2026-10-01'), end: d('2026-10-31'), from: 'statement' },
    figures: {
      opening: 100000n,
      closing: 98525n,
      moneyIn: 250000n,
      moneyOut: 251475n,
      count: 4,
      balanceCheck: 'ok',
    },
    original: {
      fileName: 'october.csv',
      format: 'CSV',
      sha256: 'ab'.repeat(32),
      importedOn: d('2026-11-02'),
    },
    ...over,
  };
}

const LINES: StatementLine[] = statementLines(
  [
    { date: d('2026-10-02'), description: 'Payroll', amount: 250000n, balance: null },
    { date: d('2026-10-03'), description: 'Rent', amount: -200000n, balance: null },
    { date: d('2026-10-05'), description: 'GROCERY OUTLET #12', amount: -4575n, balance: null },
    { date: d('2026-10-09'), description: 'مطعم الزيتون · 北京饭店', amount: -46900n, balance: null },
  ],
  100000n,
  98525n,
).lines;

const ORIGINAL = new TextEncoder().encode('Date,Description,Amount\n2026-10-02,Payroll,2500.00\n');

async function render(over: Partial<StatementPdfInput> = {}) {
  const drawn: DrawnText[] = [];
  const parts = await renderStatementPdf(
    {
      summary: summary(),
      lines: LINES,
      detail: true,
      original: null,
      maxRows: 5000,
      at: new Date('2026-11-02T10:00:00Z'),
      ...over,
    },
    (t) => drawn.push(t),
  );
  return { parts, drawn };
}

describe('statement rows', () => {
  it('keeps the order things happened, with running balances from the opening balance', () => {
    expect(LINES.map((l) => [l.date, l.balance])).toEqual([
      ['2026-10-02', 350000n],
      ['2026-10-03', 150000n],
      ['2026-10-05', 145425n],
      ['2026-10-09', 98525n],
    ]);
  });

  it('turns a newest-first file round whole, keeping same-day rows in the bank’s order', () => {
    const r = statementLines(
      [
        { date: d('2026-10-05'), description: 'c', amount: -1n, balance: null },
        { date: d('2026-10-03'), description: 'b2', amount: -1n, balance: null },
        { date: d('2026-10-03'), description: 'b1', amount: -1n, balance: null },
        { date: d('2026-10-01'), description: 'a', amount: 10n, balance: null },
      ],
      null,
      null,
    );
    expect(r.lines.map((l) => l.description)).toEqual(['a', 'b1', 'b2', 'c']);
    // No balance stated: no running balance.
    expect(r.lines.every((l) => l.balance === null)).toBe(true);
    expect([r.moneyIn, r.moneyOut]).toEqual([10n, 3n]);
  });

  it('uses the bank’s own balances when every row has one, else works back from the closing balance', () => {
    const own = statementLines(
      [
        { date: d('2026-10-01'), description: 'a', amount: -5n, balance: 95n },
        { date: d('2026-10-02'), description: 'b', amount: -5n, balance: 91n },
      ],
      0n,
      null,
    );
    expect(own.lines.map((l) => l.balance)).toEqual([95n, 91n]);
    const back = statementLines(
      [
        { date: d('2026-10-01'), description: 'a', amount: -5n, balance: null },
        { date: d('2026-10-02'), description: 'b', amount: 20n, balance: null },
      ],
      null,
      115n,
    );
    expect(back.lines.map((l) => l.balance)).toEqual([95n, 115n]);
  });
});

describe('the cover', () => {
  it('shows the last four by default, the full number only when Full is passed in, and nothing for None', () => {
    expect(accountNumberDisplay('last4', '1234', FULL)).toBe('••••1234');
    expect(accountNumberDisplay('full', '1234', FULL)).toBe(FULL);
    expect(accountNumberDisplay('none', '1234', FULL)).toBeNull();
    // No full number kept (ADR-0057 §6 lands with PR 1): Full falls back to the last four, never to nothing hidden.
    expect(accountNumberDisplay('full', '1234', null)).toBe('••••1234');
    expect(accountNumberDisplay('last4', null, null)).toBeNull();
  });

  it('with the detail switch off: the account, holders, currency and period only', () => {
    const lines = coverLines(summary({ accountNumber: FULL }), false);
    expect(lines.map((l) => l.label)).toEqual([
      'Account',
      'Institution',
      'Account type',
      'Account holder',
      'Currency',
      'Period',
    ]);
    const text = lines.map((l) => l.value).join(' ');
    expect(text).not.toContain('$');
    expect(text).not.toContain('1234');
    expect(text).not.toContain('october.csv');
  });

  it('with it on: the number as chosen, the figures and the original file', () => {
    const lines = Object.fromEntries(coverLines(summary(), true).map((l) => [l.label, l.value]));
    expect(lines).toMatchObject({
      'Account number': '••••1234',
      'Opening balance': '$1,000.00',
      'Closing balance': '$985.25',
      'Money in': '$2,500.00',
      'Money out': '$2,514.75',
      Transactions: '4',
      'Original file': 'october.csv',
      Format: 'CSV',
      'SHA-256': 'ab'.repeat(32),
      Imported: '2026-11-02',
    });
    expect(lines.Balances).toMatch(/^They check out/);
    // Joint holders.
    expect(coverLines(summary({ holders: ['Sam Rivera', 'Alex Rivera'] }), false)).toContainEqual({
      label: 'Account holders',
      value: 'Sam Rivera, Alex Rivera',
    });
  });

  it('draws what the inputs allow, and the full number only when it was passed in', async () => {
    const off = await render({ summary: summary({ accountNumber: FULL }), detail: false });
    const offText = coverText(off.drawn);
    expect(offText).toContain('Everyday Checking');
    expect(offText).toContain('Sam Rivera');
    expect(offText).toContain(RENDERED_NOTE);
    expect(offText).not.toContain('$');
    expect(off.drawn.some((t) => t.text.includes(FULL) || t.text.includes('1234'))).toBe(false);

    const last4 = await render();
    expect(coverText(last4.drawn)).toContain('••••1234');
    expect(last4.drawn.some((t) => t.text.includes(FULL))).toBe(false);

    const full = await render({
      summary: summary({ accountNumber: accountNumberDisplay('full', '1234', FULL) }),
    });
    expect(coverText(full.drawn)).toContain(FULL);
    // Not in the document's own metadata either.
    const pdf = await PDFDocument.load(full.parts[0]!.bytes, { updateMetadata: false });
    expect(`${pdf.getTitle()} ${pdf.getSubject()}`).not.toContain('1234');
  });
});

describe('the PDF', () => {
  it('draws every row and the totals, with a page header, and sets its metadata', async () => {
    const { parts, drawn } = await render();
    expect(parts).toHaveLength(1);
    expect(drawnRows(drawn)).toEqual([
      { date: '2026-10-02', description: 'Payroll', out: null, in: '2,500.00', balance: '3,500.00' },
      { date: '2026-10-03', description: 'Rent', out: '2,000.00', in: null, balance: '1,500.00' },
      { date: '2026-10-05', description: 'GROCERY OUTLET #12', out: '45.75', in: null, balance: '1,454.25' },
      {
        date: '2026-10-09',
        description: 'مطعم الزيتون · 北京饭店',
        out: '469.00',
        in: null,
        balance: '985.25',
      },
    ]);
    expect(drawnTotals(drawn, 'Totals')).toEqual({ out: '2,514.75', in: '2,500.00', balance: '985.25' });
    const header = drawn.filter((t) => t.page === 2 && t.y > 740).map((t) => t.text);
    expect(header).toContain('Everyday Checking');
    expect(header).toContain('2026-10-01 to 2026-10-31  ·  Page 2 of 2');

    const pdf = await PDFDocument.load(parts[0]!.bytes, { updateMetadata: false });
    expect(pdf.getPageCount()).toBe(2);
    expect(pdf.getTitle()).toBe('Everyday Checking statement, 2026-10-01 to 2026-10-31');
    expect(pdf.getCreator()).toBe('Montra');
    expect(pdf.getCreationDate()?.toISOString()).toBe('2026-11-02T10:00:00.000Z');
  });

  it('gives the same bytes for the same input', async () => {
    const a = await render({ original: { bytes: ORIGINAL, mime: 'text/csv' } });
    const b = await render({ original: { bytes: ORIGINAL, mime: 'text/csv' } });
    expect(Buffer.from(a.parts[0]!.bytes).equals(Buffer.from(b.parts[0]!.bytes))).toBe(true);
  });

  it('attaches the original inside the PDF, byte for byte', async () => {
    const { parts } = await render({ original: { bytes: ORIGINAL, mime: 'text/csv' } });
    expect(parts[0]!.attached).toBe(true);
    const files = await attachments(parts[0]!.bytes);
    expect([...files.keys()]).toEqual(['october.csv']);
    expect(Buffer.from(files.get('october.csv')!.bytes).equals(Buffer.from(ORIGINAL))).toBe(true);
    expect(files.get('october.csv')!.mime).toBe('text/csv');
    // Without asking, nothing is attached.
    expect((await attachments((await render()).parts[0]!.bytes)).size).toBe(0);
  });

  it('splits into parts of at most the setting’s rows, each titled part n of m, the original in the first', async () => {
    const many = statementLines(
      Array.from({ length: 7 }, (_, i) => ({
        date: d(`2026-10-0${i + 1}`),
        description: `Row ${i + 1}`,
        amount: -100n,
        balance: null,
      })),
      1000n,
      300n,
    ).lines;
    const { parts, drawn } = await render({
      lines: many,
      maxRows: 3,
      original: { bytes: ORIGINAL, mime: 'text/csv' },
    });
    expect(parts.map((p) => [p.part, p.parts, p.rows, p.attached])).toEqual([
      [1, 3, 3, true],
      [2, 3, 3, false],
      [3, 3, 1, false],
    ]);
    expect(parts.map((p) => p.title)).toEqual([
      'Everyday Checking statement, 2026-10-01 to 2026-10-31, part 1 of 3',
      'Everyday Checking statement, 2026-10-01 to 2026-10-31, part 2 of 3',
      'Everyday Checking statement, 2026-10-01 to 2026-10-31, part 3 of 3',
    ]);
    expect([1, 2, 3].flatMap((p) => drawnRows(drawn, p).map((r) => r.description))).toEqual(
      many.map((l) => l.description),
    );
    expect(drawnRows(drawn, 2).map((r) => r.balance)).toEqual(['6.00', '5.00', '4.00']);
    expect(coverText(drawn, 2)).toContain('This part holds rows 4–6 of 7.');
    expect(coverText(drawn, 2)).toContain('The original file is attached to part 1.');
    expect(drawnTotals(drawn, 'Totals for part 1', 1)).toEqual({ out: '3.00', in: '0.00', balance: '7.00' });
    expect(drawnTotals(drawn, 'Statement totals', 3)).toEqual({ out: '7.00', in: '0.00', balance: '3.00' });
    expect(drawnTotals(drawn, 'Statement totals', 1)).toBeNull();
    expect((await attachments(parts[1]!.bytes)).size).toBe(0);
  });

  it('a file that couldn’t be read: the cover alone, saying so, with the original attached', async () => {
    const { parts, drawn } = await render({
      lines: null,
      summary: summary({ figures: null, period: null }),
      original: { bytes: ORIGINAL, mime: 'text/csv' },
    });
    expect(parts).toHaveLength(1);
    expect(parts[0]!.pages).toBe(1);
    expect(coverText(drawn)).toContain(UNREADABLE_NOTE.split(':')[0]);
    expect(drawnRows(drawn)).toEqual([]);
    const files = await attachments(parts[0]!.bytes);
    expect(Buffer.from(files.get('october.csv')!.bytes).equals(Buffer.from(ORIGINAL))).toBe(true);
  });
});
