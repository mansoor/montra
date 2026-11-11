import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { calendarDate } from '@montra/domain';
import {
  analyze,
  classifyRows,
  dedupeKey,
  detectFileType,
  FIXED,
  normalizeQifDate,
  readOfx,
  readQif,
  readTextSheets,
  splitQifCategory,
  type AnalyzeOptions,
} from '../src/index.js';

const dir = join(dirname(fileURLToPath(import.meta.url)), 'corpus');
const bytes = (file: string) => new Uint8Array(readFileSync(join(dir, file)));

function read(file: string, opts: Partial<AnalyzeOptions> = {}) {
  const b = bytes(file);
  const fileType = detectFileType(b, file);
  if (fileType !== 'qif' && fileType !== 'ofx') throw new Error(`${file} read as ${fileType}`);
  const sheets = readTextSheets(fileType, b);
  const a = analyze(sheets, { fileType, currency: 'USD', accountType: 'asset', ...opts });
  // Loss-proof accounting (UP-01): every non-blank line is a row, an error or a counted skip.
  const nonBlank = a.parsed.skipped.filter((s) => s.reason !== 'blank').length;
  expect(a.parsed.read).toBe(a.parsed.rows.length + a.parsed.errors.length + nonBlank);
  return { a, sheet: sheets[0]!, fileType };
}

const total = (rows: { amount: bigint }[]) => rows.reduce((t, r) => t + r.amount, 0n);

describe('file type detection (QIF, OFX, QFX)', () => {
  it('reads the extension and the content', () => {
    expect(detectFileType(bytes('quicken-bank.qif'), 'quicken-bank.qif')).toBe('qif');
    expect(detectFileType(bytes('bank-ofx1.ofx'), 'bank-ofx1.ofx')).toBe('ofx');
    expect(detectFileType(bytes('bank-ofx2.ofx'), 'bank-ofx2.ofx')).toBe('ofx');
    expect(detectFileType(bytes('card.qfx'), 'card.qfx')).toBe('ofx');
    // Content wins over a misleading name: banks serve OFX as "download.txt" and QIF as "export.csv".
    expect(detectFileType(bytes('bank-ofx1.ofx'), 'download.txt')).toBe('ofx');
    expect(detectFileType(bytes('quicken-ccard.qif'), 'export.csv')).toBe('qif');
    expect(detectFileType(bytes('chase-checking.csv'), 'chase-checking.csv')).toBe('csv');
  });
});

describe('QIF reader (IMP-13, ADR-0030)', () => {
  it('normalizes Quicken dates', () => {
    expect(normalizeQifDate(" 1/ 5'26")).toBe('1/5/2026');
    expect(normalizeQifDate('12/31/99')).toBe('12/31/1999');
    expect(normalizeQifDate('01/05/24')).toBe('01/05/2024');
    expect(normalizeQifDate('25.12.26')).toBe('25.12.2026');
    expect(normalizeQifDate('2026-01-05')).toBe('2026-01-05');
  });

  it('splits categories, classes and transfers', () => {
    expect(splitQifCategory('Food:Groceries/Vacation')).toEqual({
      category: 'Food:Groceries',
      transfer: null,
    });
    expect(splitQifCategory('[Savings]/Joint')).toEqual({ category: '', transfer: 'Savings' });
    expect(splitQifCategory('--Split--')).toEqual({ category: '', transfer: null });
  });

  it('reads a bank register: opening balance, categories, numbers and transfers', () => {
    const { a, sheet } = read('quicken-bank.qif');
    const { rows } = a.parsed;
    expect(a.proposal).toMatchObject({ source: 'reference', templateId: 'qif', warnings: [] });
    expect(a.proposal.confidence).toBeGreaterThanOrEqual(0.75);
    expect(a.proposal.mapping.dateFormat).toBe('MM/DD/YYYY');
    expect(rows).toHaveLength(5);
    // Quicken's "Opening Balance" record is the statement's opening, not a transaction.
    expect(a.parsed.opening).toBe(0n);
    expect(rows[0]).toMatchObject({
      date: '2026-10-01',
      amount: 250000n,
      payee: 'ACME PAYROLL',
      category: 'Salary',
    });
    expect(rows[1]).toMatchObject({
      amount: -120000n,
      description: 'October rent',
      category: 'Housing:Rent',
      reference: '101',
    });
    expect(rows[1]!.raw[FIXED.group]).toBe('Housing');
    // A transfer stays uncategorized and says so, so the switch flow pairs it with the other account.
    expect(rows[3]).toMatchObject({ amount: -30000n, category: null, description: 'Transfer : Savings' });
    expect(rows[4]).toMatchObject({ date: '2026-10-12', amount: -1840n, description: 'Latte, croissant' });
    expect(total(rows)).toBe(91723n);
    expect(sheet.accounts).toEqual([{ name: '', kind: null, closing: null }]);
    expect(a.proposal.accountColumn).toBeNull();
  });

  it('reads a credit card register with its kind', () => {
    const { a, sheet } = read('quicken-ccard.qif', { accountType: 'liability' });
    expect(a.parsed.rows).toHaveLength(4);
    expect(a.proposal.mapping.sign).toBe('normal');
    expect(a.parsed.rows[0]).toMatchObject({ date: '2026-10-02', amount: -1549n, payee: 'NETFLIX.COM' });
    expect(a.parsed.rows[2]).toMatchObject({ amount: 25000n, description: 'Transfer : Checking' });
    expect(total(a.parsed.rows)).toBe(3241n);
    expect(sheet.accounts?.[0]?.kind).toBe('credit_card');
  });

  it('reads a multi-account export: accounts, splits, and skipped investments and lists', () => {
    const { a, sheet } = read('quicken-multi.qif');
    expect(a.proposal.accounts).toEqual(['Checking', 'Visa']);
    expect(a.proposal.warnings).toEqual([
      'multiple_accounts_choose_one',
      'investment_transactions_skipped:2',
    ]);
    expect(sheet.accounts?.map((x) => [x.name, x.kind])).toEqual([
      ['Checking', null],
      ['Visa', 'credit_card'],
    ]);
    // Category lists and memorized transactions are not transactions.
    expect(sheet.rows).toHaveLength(1 + 5);

    const checking = read('quicken-multi.qif', { accountFilter: 'Checking' }).a.parsed.rows;
    expect(checking).toHaveLength(3);
    // A split keeps its total; its category is the splits' common one, or none when they differ.
    expect(checking[0]).toMatchObject({ amount: 300000n, category: null, description: '' });
    expect(checking[1]).toMatchObject({ amount: -15000n, category: 'Food:Groceries' });
    expect(checking[2]).toMatchObject({ amount: -25000n, description: 'Transfer : Visa' });

    const visa = read('quicken-multi.qif', { accountFilter: 'Visa' }).a.parsed.rows;
    expect(visa.map((r) => r.amount)).toEqual([-4200n, 25000n]);
    expect(visa[1]!.description).toBe('Transfer : Checking');
  });

  it('leaves ambiguous day/month order to the locale preference, with a warning', () => {
    const us = read('quicken-daymonth.qif').a;
    expect(us.proposal.warnings).toContain('ambiguous_date_format');
    expect(us.proposal.confidence).toBeLessThan(0.75);
    expect(us.parsed.rows[0]!.date).toBe('2026-01-02');
    const uk = read('quicken-daymonth.qif', { preferDayFirst: true }).a;
    expect(uk.proposal.mapping.dateFormat).toBe('DD/MM/YYYY');
    expect(uk.parsed.rows[0]!.date).toBe('2026-02-01');
  });

  it('reuses only the confirmed day/month order from a saved profile, never its account filter', () => {
    const { a: first } = read('quicken-daymonth.qif');
    const profile = {
      id: 'p1',
      fingerprint: first.fingerprint,
      mapping: {
        ...first.proposal.mapping,
        dateFormat: 'DD/MM/YYYY' as const,
        filter: { column: FIXED.account, values: ['Some other account'] },
      },
    };
    const { a } = read('quicken-daymonth.qif', { profiles: [profile] });
    expect(a.proposal).toMatchObject({ templateId: 'qif', profileId: 'p1', warnings: [] });
    expect(a.proposal.confidence).toBeGreaterThanOrEqual(0.75);
    expect(a.parsed.rows).toHaveLength(3);
    expect(a.parsed.rows[0]!.date).toBe('2026-02-01');
  });

  it('keeps the Opening Balance record out when the user changes the mapping', () => {
    const sheets = readTextSheets('qif', bytes('quicken-bank.qif'));
    const opts = { fileType: 'qif' as const, currency: 'USD' as const, accountType: 'asset' as const };
    const { openingPayees: _, externalId: __, ...mapping } = analyze(sheets, opts).proposal.mapping;
    const a = analyze(sheets, opts, { ...mapping, description: [FIXED.memo] });
    expect(a.parsed.rows).toHaveLength(5);
    expect(a.parsed.opening).toBe(0n);
  });

  it('reads Windows-1252 (ANSI) files with CRLF line ends', () => {
    const { a } = read('quicken-ansi.qif');
    expect(a.parsed.rows.map((r) => r.payee)).toEqual(['Café Crème', 'Müller Bäckerei']);
    expect(a.parsed.rows[0]).toMatchObject({
      date: '2026-10-02',
      amount: -450n,
      description: 'Pain au chocolat € 1',
      category: 'Food:Cafés',
    });
  });

  it('reads an empty or list-only file as no rows', () => {
    expect(readQif('!Type:Cat\nNFood\n^\n').rows).toHaveLength(1);
  });
});

describe('OFX reader (IMP-13, ADR-0030)', () => {
  it('reads OFX 1.x (SGML): FITIDs, check numbers, entities and the closing balance', () => {
    const { a, sheet } = read('bank-ofx1.ofx');
    const { rows } = a.parsed;
    expect(a.proposal).toMatchObject({ templateId: 'ofx', warnings: [] });
    expect(a.proposal.mapping.dateFormat).toBe('YYYY-MM-DD');
    expect(rows).toHaveLength(5);
    expect(rows[0]).toMatchObject({
      date: '2026-10-03',
      amount: -6437n,
      payee: 'WHOLE FOODS #123',
      description: 'POS PURCHASE',
      externalId: '202610030001',
    });
    expect(rows[2]).toMatchObject({ amount: -120000n, reference: '101' });
    expect(rows[3]!.payee).toBe("BEN & JERRY'S");
    expect(total(rows)).toBe(122663n);
    expect(sheet.accounts).toEqual([
      { name: 'First Bank Checking ••5678', kind: 'checking', closing: '3731.13' },
    ]);
    expect(a.proposal.accounts).toEqual(['First Bank Checking ••5678']);
    // Only a closing balance: shown on the import, but no opening to check against.
    expect(a.parsed.closing).toBe(373113n);
    expect(a.balance.status).toBe('n_a');
  });

  it('reads OFX 2.x (XML)', () => {
    const { a, sheet } = read('bank-ofx2.ofx');
    expect(a.parsed.rows).toHaveLength(2);
    // A transfer whose text doesn't say so gets the word, so the switch flow can pair it.
    expect(a.parsed.rows[0]).toMatchObject({
      amount: 30000n,
      description: 'Transfer',
      externalId: 'SAV-0001',
    });
    // A memo repeating the name isn't repeated in the description.
    expect(a.parsed.rows[1]).toMatchObject({ amount: 127n, description: '', payee: 'Interest paid' });
    expect(sheet.accounts?.[0]).toEqual({ name: 'Savings ••3210', kind: 'savings', closing: '5301.27' });
    expect(a.parsed.closing).toBe(530127n);
  });

  it('reads QFX (OFX with Intuit tags) from a credit card on one line', () => {
    const { a, sheet } = read('card.qfx', { accountType: 'liability' });
    expect(a.parsed.rows.map((r) => r.amount)).toEqual([-1549n, -8210n, 25000n]);
    expect(a.parsed.rows[1]).toMatchObject({ payee: 'SHELL OIL 57412', description: 'FUEL' });
    expect(sheet.accounts?.[0]).toEqual({
      name: 'B1 Credit card ••4321',
      kind: 'credit_card',
      closing: '-347.59',
    });
    expect(a.parsed.closing).toBe(-34759n);
  });

  it('signs unsigned debits by their type, and counts skipped investment transactions', () => {
    const sheet = readOfx(
      `OFXHEADER:100\n<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>USD<BANKACCTFROM><ACCTID>1234<ACCTTYPE>CHECKING</BANKACCTFROM><BANKTRANLIST>` +
        `<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20261001<TRNAMT>12.00<FITID>a<NAME>SHOP</STMTTRN>` +
        `<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20261002<TRNAMT>50.00<FITID>b<NAME>REFUND</STMTTRN>` +
        `</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1>` +
        `<INVSTMTMSGSRSV1><INVSTMTTRNRS><INVSTMTRS><INVTRANLIST><BUYSTOCK><INVBUY><INVTRAN><FITID>c</INVTRAN></INVBUY></BUYSTOCK></INVTRANLIST></INVSTMTRS></INVSTMTTRNRS></INVSTMTMSGSRSV1></OFX>`,
    );
    expect(sheet.rows.slice(1).map((r) => r[FIXED.amount])).toEqual(['-12.00', '50.00']);
    expect(sheet.warnings).toEqual(['investment_transactions_skipped:1']);
  });

  it('refuses a file without an <OFX> element', () => {
    expect(() => readOfx('OFXHEADER:100\nnothing here')).toThrow(/OFX/);
  });

  it('keys dedupe on the FITID, so a renamed payee is still the same transaction', () => {
    const row = { date: calendarDate('2026-10-03'), amount: -6437n, normalizedDescription: 'WHOLE FOODS' };
    const a = dedupeKey('acct', { ...row, externalId: 'X1' }, 0);
    expect(
      dedupeKey('acct', { ...row, normalizedDescription: 'WHOLE FOODS MARKET', externalId: 'X1' }, 0),
    ).toBe(a);
    expect(dedupeKey('acct', { ...row, externalId: 'X2' }, 0)).not.toBe(a);
    // Two same-day purchases with different FITIDs are both new, each with ordinal 0.
    const { a: parsed } = read('bank-ofx1.ofx');
    const classes = classifyRows('acct', parsed.parsed.rows, [], [], []);
    expect(classes.slice(3).map((c) => c.ordinal)).toEqual([0, 0]);
    expect(new Set(classes.map((c) => c.dedupeKey)).size).toBe(5);
    // Re-importing the same file finds every row as an exact duplicate.
    const again = classifyRows(
      'acct',
      parsed.parsed.rows,
      parsed.parsed.rows.map((r, i) => ({ ...r, transactionId: `t${i}`, dedupeKey: classes[i]!.dedupeKey })),
      [],
      [],
    );
    expect(again.every((c) => c.status === 'duplicate')).toBe(true);
  });

  it('keeps the FITID when the user changes the mapping', () => {
    const b = bytes('bank-ofx1.ofx');
    const sheets = readTextSheets('ofx', b);
    const opts = { fileType: 'ofx' as const, currency: 'USD' as const, accountType: 'asset' as const };
    const first = analyze(sheets, opts);
    const { externalId: _, ...mapping } = first.proposal.mapping;
    const again = analyze(sheets, opts, { ...mapping, description: [FIXED.memo] });
    expect(again.parsed.rows[0]!.externalId).toBe('202610030001');
  });
});
