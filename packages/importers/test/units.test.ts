import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import ExcelJS from 'exceljs';
import { calendarDate, addDays, fromEpochDay } from '@montra/domain';
import {
  analyze,
  classifyRows,
  decodeText,
  detectDateFormat,
  detectDecimalSeparator,
  detectFileType,
  displayName,
  fingerprint,
  matchMerchant,
  normalizeDescription,
  parseAmount,
  parseDate,
  readXlsx,
  type DedupeInputRow,
} from '../src/index.js';

describe('decoding and file types', () => {
  it('falls back to Windows-1252 and honours BOMs', () => {
    expect(decodeText(new Uint8Array([0x4d, 0xfc, 0x6c, 0x6c, 0x65, 0x72])).text).toBe('Müller');
    expect(decodeText(new Uint8Array([0xef, 0xbb, 0xbf, 0x41])).text).toBe('A');
    expect(decodeText(new TextEncoder().encode('Grüße')).encoding).toBe('utf-8');
  });

  it('detects types from magic bytes', () => {
    expect(detectFileType(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]), 'x.pdf')).toBe('pdf');
    expect(detectFileType(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), 'x.xls')).toBe(
      'xls',
    );
    expect(detectFileType(new Uint8Array([0x50, 0x4b, 0x03, 0x04]), 'x.xlsx')).toBe('xlsx');
    expect(detectFileType(new Uint8Array([0x00, 0x01, 0x02]), 'x.bin')).toBeNull();
  });
});

describe('dates', () => {
  it('parses many statement formats', () => {
    expect(parseDate('2026-10-28 14:03:22', 'YYYY-MM-DD')).toBe('2026-10-28');
    expect(parseDate('28.10.26', 'DD.MM.YY')).toBe('2026-10-28');
    expect(parseDate('5 Mär 2026', 'D MMM YYYY')).toBe('2026-03-05');
    expect(parseDate('Oct 5, 2026', 'MMM D YYYY')).toBe('2026-10-05');
    expect(parseDate('05-OCT-26', 'DD-MMM-YY')).toBe('2026-10-05');
    expect(parseDate('20261005', 'YYYYMMDD')).toBe('2026-10-05');
    expect(parseDate('02/30/2026', 'MM/DD/YYYY')).toBeNull();
  });

  it('decides day/month order from the data', () => {
    expect(detectDateFormat(['01/13/2026', '01/02/2026'])).toMatchObject({
      format: 'MM/DD/YYYY',
      ambiguous: false,
    });
    expect(detectDateFormat(['13/01/2026', '02/01/2026'])).toMatchObject({
      format: 'DD/MM/YYYY',
      ambiguous: false,
    });
    // Monotonic order breaks the tie: 01/02, 01/03, 01/04 increase daily as MM/DD and monthly as DD/MM.
    expect(detectDateFormat(['01/02/2026', '01/03/2026', '01/04/2026', '01/05/2026'])?.ambiguous).toBe(true);
    expect(detectDateFormat(['03/04/2026', '04/03/2026'], true)?.format).toBe('DD/MM/YYYY');
  });
});

describe('amounts', () => {
  it.each([
    ['$1,234.56', '.', 123456n],
    ['(12.30)', '.', -1230n],
    ['12.30-', '.', -1230n],
    ['1.234,56 €', ',', 123456n],
    ['-34,56', ',', -3456n],
    ['2 850,00', ',', 285000n],
    ['45.00 DR', '.', -4500n],
    ['45.00 CR', '.', 4500n],
    ['USD 7.5', '.', 750n],
    ['abc', '.', null],
    ['', '.', null],
  ] as const)('%s → %s', (raw, dec, expected) => {
    expect(parseAmount(raw, 'USD', dec)).toBe(expected);
  });

  it('detects the decimal separator for a column', () => {
    expect(detectDecimalSeparator(['1.234,56', '-89,00'])).toBe(',');
    expect(detectDecimalSeparator(['1,234.56', '-89.00'])).toBe('.');
    expect(detectDecimalSeparator(['1,000', '2,500.10'])).toBe('.');
  });
});

describe('payees (IMP-10)', () => {
  it.each([
    ['SQ *BLUE BOTTLE 0423 SF CA', 'BLUE BOTTLE'],
    ["TRADER JOE'S #552 SAN FRANCISCO CA", 'TRADER JOES'],
    ['TST* SUSHI HOUSE 123 MAIN', 'SUSHI HOUSE MAIN'],
    ['AMAZON MKTPLACE PMTS', 'AMAZON'],
    ['APPLE.COM/BILL 866-712-7753 CA', 'APPLE'],
    ['PAYPAL *NETFLIX', 'NETFLIX'],
    ['SPOTIFY USA', 'SPOTIFY'],
    ['SHELL OIL 57444 OAKLAND CA', 'SHELL OIL'],
    ['KARTENZAHLUNG REWE MARKT GMBH', 'REWE MARKT GMBH'],
  ])('%s → %s', (raw, key) => {
    expect(normalizeDescription(raw)).toBe(key);
  });

  it('builds display names and matches reference merchants', () => {
    expect(displayName('BED BATH & BEYOND')).toBe('Bed Bath & Beyond');
    const refs = [
      {
        id: 'bluebottle',
        displayName: 'Blue Bottle Coffee',
        matchKey: 'BLUE BOTTLE',
        categoryHint: 'Dining out',
      },
      { id: 'tj', displayName: "Trader Joe's", matchKey: 'TRADER JOES', categoryHint: 'Groceries' },
    ];
    expect(matchMerchant('BLUE BOTTLE', refs)?.id).toBe('bluebottle');
    expect(matchMerchant('TRADER JOE', refs)?.id).toBe('tj');
    expect(matchMerchant('WALGREENS', refs)).toBeNull();
  });
});

describe('dedupe and matching (IMP-07)', () => {
  const d = calendarDate;
  const row = (date: string, amount: bigint, desc: string): DedupeInputRow => ({
    date: d(date),
    amount,
    normalizedDescription: desc,
  });

  it('keeps two identical coffees on one day, and re-importing the file adds nothing', () => {
    const file = [row('2026-10-20', -450n, 'BLUE BOTTLE'), row('2026-10-20', -450n, 'BLUE BOTTLE')];
    const first = classifyRows('acct', file, [], [], []);
    expect(first.map((c) => c.status)).toEqual(['new', 'new']);
    expect(new Set(first.map((c) => c.dedupeKey)).size).toBe(2);
    const imported = first.map((c, i) => ({ transactionId: `t${i}`, ...file[i]!, dedupeKey: c.dedupeKey }));
    const again = classifyRows('acct', file, imported, [], [{ min: d('2026-10-01'), max: d('2026-10-31') }]);
    expect(again.map((c) => [c.status, c.transactionId])).toEqual([
      ['duplicate', 't0'],
      ['duplicate', 't1'],
    ]);
    // A third identical coffee in a later, overlapping file is new.
    const more = classifyRows(
      'acct',
      [...file, file[0]!],
      imported,
      [],
      [{ min: d('2026-10-01'), max: d('2026-10-31') }],
    );
    expect(more.map((c) => c.status)).toEqual(['duplicate', 'duplicate', 'new']);
  });

  it('only flags probable duplicates inside covered ranges, and never skips them', () => {
    const imported = [
      {
        transactionId: 'x',
        date: d('2026-10-05'),
        amount: -1000n,
        normalizedDescription: 'SHELL OIL',
        dedupeKey: 'other',
      },
    ];
    const rows = [row('2026-10-06', -1000n, 'SHELL OIL')];
    expect(
      classifyRows('acct', rows, imported, [], [{ min: d('2026-10-01'), max: d('2026-10-31') }])[0],
    ).toMatchObject({
      status: 'probable_duplicate',
      transactionId: 'x',
    });
    // Outside every earlier batch's range: a real new transaction.
    expect(
      classifyRows('acct', rows, imported, [], [{ min: d('2026-09-01'), max: d('2026-09-30') }])[0]!.status,
    ).toBe('new');
    // Same amount next day at an unrelated merchant: not a duplicate.
    expect(
      classifyRows(
        'acct',
        [row('2026-10-06', -1000n, 'WALGREENS')],
        imported,
        [],
        [{ min: d('2026-10-01'), max: d('2026-10-31') }],
      )[0]!.status,
    ).toBe('new');
  });

  it('matches manual entries one-to-one and requires description similarity', () => {
    const manual = [
      { transactionId: 'm1', date: d('2026-10-04'), amount: -1850n, normalizedDescription: 'BLUE BOTTLE' },
      { transactionId: 'm2', date: d('2026-10-05'), amount: -1850n, normalizedDescription: 'NOODLE BAR' },
    ];
    const rows = [row('2026-10-05', -1850n, 'BLUE BOTTLE'), row('2026-10-05', -1850n, 'BLUE BOTTLE COFFEE')];
    const out = classifyRows('acct', rows, [], manual, []);
    expect(out.map((c) => [c.status, c.transactionId])).toEqual([
      ['match', 'm1'],
      ['new', null],
    ]);
  });

  it('re-importing any file is idempotent (property)', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            day: fc.integer({ min: 20_000, max: 20_030 }),
            amount: fc.bigInt({ min: -5000n, max: 5000n }),
            desc: fc.constantFrom('A STORE', 'B CAFE', 'C GAS'),
          }),
          { maxLength: 40 },
        ),
        (spec) => {
          const rows = spec.map((s) => ({
            date: fromEpochDay(s.day),
            amount: s.amount,
            normalizedDescription: s.desc,
          }));
          const first = classifyRows('acct', rows, [], [], []);
          expect(first.every((c) => c.status === 'new')).toBe(true);
          const imported = first.map((c, i) => ({
            transactionId: `t${i}`,
            ...rows[i]!,
            dedupeKey: c.dedupeKey,
          }));
          const range = [{ min: fromEpochDay(20_000), max: addDays(fromEpochDay(20_000), 30) }];
          const again = classifyRows('acct', rows, imported, [], range);
          expect(again.every((c) => c.status === 'duplicate')).toBe(true);
          expect(new Set(again.map((c) => c.transactionId)).size).toBe(rows.length);
        },
      ),
    );
  });
});

describe('XLSX and fingerprints (IMP-01, IMP-04)', () => {
  it('reads a workbook with real dates and formatted numbers, and fingerprints its shape', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Transactions');
    ws.addRow(['Date', 'Description', 'Amount']);
    ws.addRow([new Date(Date.UTC(2026, 9, 28)), 'Blue Bottle', -6.5]);
    ws.addRow([new Date(Date.UTC(2026, 9, 25)), 'Payroll', 3200]);
    ws.getColumn(3).numFmt = '#,##0.00';
    const bytes = new Uint8Array(await wb.xlsx.writeBuffer());
    const sheets = await readXlsx(bytes);
    expect(sheets[0]!.rows).toEqual([
      ['Date', 'Description', 'Amount'],
      ['2026-10-28', 'Blue Bottle', '-6.5'],
      ['2026-10-25', 'Payroll', '3200'],
    ]);
    const a = analyze(sheets, { fileType: 'xlsx', currency: 'USD', accountType: 'asset' });
    expect(a.parsed.rows.map((r) => r.amount)).toEqual([-650n, 320000n]);
    expect(a.fingerprint).toBe(fingerprint('xlsx', ['Date', 'Description', 'Amount'], 3));
    expect(fingerprint('csv', ['Date', 'Description', 'Amount'], 3)).not.toBe(a.fingerprint);
  });

  it('reuses a saved profile by fingerprint and lets the user override the mapping', () => {
    const sheet = {
      name: 'CSV',
      rows: [
        ['When', 'What', 'How much'],
        ['2026-10-01', 'X', '1.00'],
        ['2026-10-02', 'Y', '2.00'],
      ],
    };
    const fp = fingerprint('csv', sheet.rows[0]!, 3);
    const mapping = {
      headerRow: 0,
      dataStart: 1,
      date: 0,
      dateFormat: 'YYYY-MM-DD' as const,
      description: [1],
      amount: 2,
      sign: 'inverted' as const,
      decimal: '.' as const,
    };
    const a = analyze([sheet], {
      fileType: 'csv',
      currency: 'USD',
      accountType: 'asset',
      profiles: [{ id: 'p1', fingerprint: fp, mapping }],
    });
    expect(a.proposal).toMatchObject({ source: 'profile', profileId: 'p1', confidence: 1 });
    expect(a.parsed.rows.map((r) => r.amount)).toEqual([-100n, -200n]);
    const o = analyze(
      [sheet],
      { fileType: 'csv', currency: 'USD', accountType: 'asset' },
      { ...mapping, sign: 'normal' },
    );
    expect(o.proposal.source).toBe('user');
    expect(o.parsed.rows.map((r) => r.amount)).toEqual([100n, 200n]);
  });
});
