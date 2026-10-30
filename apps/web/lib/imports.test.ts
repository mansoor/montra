import { describe, expect, it } from 'vitest';
import { catalogs } from '@montra/i18n';
import type { ColumnMapping, ImportRowDto } from '@montra/api-client';
import {
  applyRole,
  canUndo,
  columnRoles,
  draftFromMapping,
  draftToMapping,
  fileProblem,
  IMPORT_ERROR_KEYS,
  importErrorKey,
  mappingErrors,
  parseStatementAmount,
  parseStatementDate,
  previewMapping,
  rowDisplay,
  WARNING_KEYS,
  warningKey,
} from './imports';

const en = catalogs.en!;

// packages/importers/test/corpus/chase-checking.csv as the API's analysis.sample would carry it.
const CHASE = [
  ['Details', 'Posting Date', 'Description', 'Amount', 'Type', 'Balance', 'Check or Slip #', ''],
  ['DEBIT', '10/28/2026', 'SQ *BLUE BOTTLE 0423 SF CA', '-6.50', 'DEBIT_CARD', '2481.75', '', ''],
  [
    'CREDIT',
    '10/25/2026',
    'ACME CORP PAYROLL PPD ID: 9876543210',
    '3200.00',
    'ACH_CREDIT',
    '2488.25',
    '',
    '',
  ],
  ['DEBIT', '10/24/2026', 'AMEX EPAYMENT ACH PMT W1234', '-704.00', 'ACH_DEBIT', '-711.75', '', ''],
  ['DEBIT', '10/20/2026', "TRADER JOE'S #552 SAN FRANCISCO CA", '-84.00', 'DEBIT_CARD', '-7.75', '', ''],
  ['DEBIT', '10/20/2026', "TRADER JOE'S #552 SAN FRANCISCO CA", '-84.00', 'DEBIT_CARD', '76.25', '', ''],
  ['CHECK', '10/15/2026', 'CHECK 1043', '-120.00', 'CHECK_PAID', '160.25', '1043', ''],
];

const chase: ColumnMapping = {
  headerRow: 0,
  dataStart: 1,
  date: 1,
  dateFormat: 'MM/DD/YYYY',
  description: [2],
  amount: 3,
  balance: 5,
  reference: 6,
  sign: 'normal',
  decimal: '.',
};

describe('mapping editor model', () => {
  it('round-trips a mapping through per-column roles', () => {
    const draft = draftFromMapping(chase, 8);
    expect(draft.roles).toEqual([
      'ignore',
      'date',
      'description',
      'amount',
      'ignore',
      'balance',
      'reference',
      'ignore',
    ]);
    expect(mappingErrors(draft)).toEqual([]);
    expect(draftToMapping(draft)).toEqual(chase);
  });

  it('moves single roles and treats amount and debit/credit as alternatives', () => {
    let d = draftFromMapping(chase, 8);
    d = applyRole(d, 0, 'date');
    expect(columnRoles(draftToMapping(d), 8).slice(0, 2)).toEqual(['date', 'ignore']);
    d = applyRole(d, 4, 'debit');
    expect(d.roles[3]).toBe('ignore');
    expect(mappingErrors(d)).toEqual(['imports.mapping.need_amount']);
    d = applyRole(d, 7, 'credit');
    expect(mappingErrors(d)).toEqual([]);
    expect(draftToMapping(d)).toMatchObject({ debit: 4, credit: 7 });
    expect(draftToMapping(d).amount).toBeUndefined();
    d = applyRole(d, 1, 'description');
    expect(draftToMapping(d).description).toEqual([1, 2]);
  });

  it('reports what is missing', () => {
    const empty = draftFromMapping(null, 3);
    expect(mappingErrors(empty)).toEqual(['imports.mapping.need_date', 'imports.mapping.need_amount']);
    const bad = { ...draftFromMapping(chase, 8), headerRow: 2, dataStart: 1 };
    expect(mappingErrors(bad)).toEqual(['imports.mapping.data_before_header']);
    for (const key of [
      'imports.mapping.need_date',
      'imports.mapping.need_amount',
      'imports.mapping.too_many_descriptions',
      'imports.mapping.data_before_header',
    ])
      expect(en[key], key).toBeTruthy();
  });
});

describe('live mapping preview', () => {
  it('reads the first five rows the way the importer does', () => {
    const rows = previewMapping(CHASE, chase, 'USD');
    expect(rows).toHaveLength(5);
    expect(rows[0]).toEqual({
      rowNo: 2,
      date: '2026-10-28',
      amount: -650n,
      description: 'SQ *BLUE BOTTLE 0423 SF CA',
      error: null,
    });
    expect(rows.map((r) => r.amount)).toEqual([-650n, 320000n, -70400n, -8400n, -8400n]);
  });

  it('applies the sign toggle, debit/credit columns and direction values', () => {
    expect(previewMapping(CHASE, { ...chase, sign: 'inverted' }, 'USD', 2).map((r) => r.amount)).toEqual([
      650n,
      -320000n,
    ]);
    const split = [
      ['Date', 'Memo', 'Debit', 'Credit'],
      ['01.10.2026', 'Miete', '1.200,00', ''],
      ['02.10.2026', 'Gehalt', '', '3.000,50'],
    ];
    const m: ColumnMapping = {
      headerRow: 0,
      dataStart: 1,
      date: 0,
      dateFormat: 'DD.MM.YYYY',
      description: [1],
      debit: 2,
      credit: 3,
      sign: 'normal',
      decimal: ',',
    };
    expect(previewMapping(split, m, 'EUR').map((r) => [r.date, r.amount])).toEqual([
      ['2026-10-01', -120000n],
      ['2026-10-02', 300050n],
    ]);
    const typed = previewMapping(
      CHASE.map((r) => [...r.slice(0, 3), r[3]!.replace('-', ''), ...r.slice(4)]),
      { ...chase, direction: { column: 0, debitValues: ['debit', 'check'] } },
      'USD',
      2,
    );
    expect(typed.map((r) => r.amount)).toEqual([-650n, 320000n]);
  });

  it('skips blank rows, footers and other accounts, and flags bad cells', () => {
    const sample = [
      ['Date', 'Account', 'Description', 'Amount'],
      ['', '', '', ''],
      ['2026-10-01', 'Checking', 'Coffee', '-4.50'],
      ['2026-10-02', 'Visa', 'Lunch', '-12'],
      ['yesterday', 'Checking', 'Typo', '-1'],
      ['2026-10-03', 'Checking', 'Refund', 'n/a'],
      ['2026-10-04', 'Checking', 'Blank', ''],
      ['Total', '', '', '-17.50'],
    ];
    const m: ColumnMapping = {
      headerRow: 0,
      dataStart: 1,
      date: 0,
      dateFormat: 'YYYY-MM-DD',
      description: [2],
      amount: 3,
      sign: 'normal',
      decimal: '.',
      filter: { column: 1, values: ['checking'] },
    };
    expect(previewMapping(sample, m, 'USD', 10).map((r) => [r.rowNo, r.error])).toEqual([
      [3, null],
      [5, 'invalid_date'],
      [6, 'invalid_amount'],
      [7, 'missing_amount'],
    ]);
  });

  it('parses dates and amounts like @montra/importers', () => {
    expect(parseStatementDate('2026-01-05 14:03:22', 'YYYY-MM-DD')).toBe('2026-01-05');
    expect(parseStatementDate('5 Okt 2026', 'D MMM YYYY')).toBe('2026-10-05');
    expect(parseStatementDate('01-Oct-26', 'DD-MMM-YY')).toBe('2026-10-01');
    expect(parseStatementDate('02/30/2026', 'MM/DD/YYYY')).toBeNull();
    expect(parseStatementAmount('$1,234.56', 'USD', '.')).toBe(123456n);
    expect(parseStatementAmount('(5.00)', 'USD', '.')).toBe(-500n);
    expect(parseStatementAmount('12.00 DR', 'USD', '.')).toBe(-1200n);
    expect(parseStatementAmount('-3,50 €', 'EUR', ',')).toBe(-350n);
    expect(parseStatementAmount('1.234', 'JPY', ',')).toBe(1234n);
    expect(parseStatementAmount('pending', 'USD', '.')).toBeNull();
  });
});

const row = (over: Partial<ImportRowDto>): ImportRowDto => ({
  id: 'r1',
  rowNo: 2,
  date: '2026-10-28',
  amount: { amount: '-650', currency: 'USD' },
  description: 'Coffee',
  payee: null,
  balance: null,
  status: 'new',
  decision: null,
  effective: 'import',
  transactionId: null,
  matchTransactionId: null,
  duplicateOfTransactionId: null,
  score: null,
  categoryId: null,
  suggestion: null,
  error: null,
  outcome: null,
  raw: [],
  ...over,
});

describe('preview row display', () => {
  it('shows status and effective outcome, with the toggle that flips it', () => {
    expect(rowDisplay(row({}))).toMatchObject({
      statusKey: 'imports.row_status.new',
      statusTone: 'good',
      effectiveKey: 'imports.effective.import',
      toggle: { decision: 'skip' },
    });
    expect(rowDisplay(row({ status: 'probable_duplicate', effective: 'skip' })).toggle?.decision).toBe(
      'import',
    );
    const match = rowDisplay(row({ status: 'match', effective: 'match', matchTransactionId: 't9' }));
    expect(match).toMatchObject({ linkedTransactionId: 't9', toggle: { decision: 'skip' } });
    expect(rowDisplay(row({ status: 'match', effective: 'skip' })).toggle?.decision).toBe('match');
    const bad = rowDisplay(row({ status: 'error', effective: 'fail', error: 'invalid_date' }));
    expect(bad).toMatchObject({ toggle: null, errorKey: 'imports.row_error.invalid_date' });
  });

  it('has catalog entries for every status, outcome and toggle', () => {
    for (const status of ['new', 'duplicate', 'probable_duplicate', 'match', 'error'] as const)
      for (const effective of ['import', 'skip', 'match', 'fail'] as const) {
        const d = rowDisplay(row({ status, effective, error: 'missing_amount' }));
        for (const key of [d.statusKey, d.effectiveKey, d.toggle?.labelKey, d.errorKey])
          if (key) expect(en[key], key).toBeTruthy();
      }
  });
});

describe('warnings and failures', () => {
  it('maps every known warning and failure code to a message', () => {
    expect(warningKey('ambiguous_date_format')).toBe('imports.warning.ambiguous_date_format');
    expect(warningKey('something_new')).toBe('imports.warning.unknown');
    for (const key of [...Object.values(WARNING_KEYS), 'imports.warning.unknown'])
      expect(en[key], key).toBeTruthy();
    for (const key of Object.values(IMPORT_ERROR_KEYS)) expect(en[key], key).toBeTruthy();
  });

  it('reads the code from a job error', () => {
    expect(importErrorKey('pdf.no_text_layer: this PDF looks scanned; OCR import arrives in Phase 3')).toBe(
      'imports.error.pdf_no_text_layer',
    );
    expect(en['imports.error.pdf_no_text_layer']).toMatch(/Scanned PDFs arrive in a later update/);
    expect(importErrorKey('job.error: boom')).toBeNull();
    expect(importErrorKey(null)).toBeNull();
  });

  it('checks files before upload and knows when undo is allowed', () => {
    expect(fileProblem({ name: 'stmt.CSV', size: 10 })).toBeNull();
    expect(fileProblem({ name: 'virus.exe', size: 10 })).toBe('imports.upload.bad_type');
    expect(fileProblem({ name: 'big.pdf', size: 26 * 1024 * 1024 })).toBe('imports.error.doc_too_large');
    const now = new Date('2026-10-30T12:00:00Z');
    const batch = { status: 'committed', undoUntil: '2026-11-29T12:00:00Z' } as Parameters<typeof canUndo>[0];
    expect(canUndo(batch, now)).toBe(true);
    expect(canUndo({ ...batch, undoUntil: '2026-10-01T00:00:00Z' }, now)).toBe(false);
    expect(canUndo({ ...batch, status: 'undone' }, now)).toBe(false);
  });
});
