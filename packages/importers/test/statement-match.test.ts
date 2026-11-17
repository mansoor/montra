import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  analyze,
  billSignal,
  cleanImport,
  fileNameLast4,
  fileNamePattern,
  forgetMatch,
  institutionKey,
  isLearned,
  LEARN_AFTER,
  learnMatch,
  ofxAccounts,
  readTextSheets,
  sheetFingerprint,
  statementSignal,
  taxIssuerSignal,
  taxSignalHasEin,
  type ImportOutcome,
} from '../src/index.js';

const dir = join(dirname(fileURLToPath(import.meta.url)), 'corpus');
const bytes = (file: string) => new Uint8Array(readFileSync(join(dir, file)));

describe('learning a match (ADR-0051 §3)', () => {
  it('becomes automatic after three confirmations of the same target', () => {
    let m = learnMatch(null, 'checking');
    expect(m).toEqual({ targetId: 'checking', confirmations: 1, corrected: false });
    expect(isLearned(m)).toBe(false);
    m = learnMatch(m, 'checking');
    expect(isLearned(m)).toBe(false);
    m = learnMatch(m, 'checking');
    expect(m.confirmations).toBe(LEARN_AFTER);
    expect(isLearned(m)).toBe(true);
  });

  it('starts again at one after a correction', () => {
    let m = learnMatch(learnMatch(null, 'checking'), 'checking');
    m = learnMatch(m, 'savings');
    expect(m).toEqual({ targetId: 'savings', confirmations: 1, corrected: true });
    m = learnMatch(learnMatch(m, 'savings'), 'savings');
    expect(isLearned(m)).toBe(true);
  });

  it('forgets an automatic match that was undone', () => {
    expect(isLearned(forgetMatch({ targetId: 'a', confirmations: 7 }))).toBe(false);
    expect(isLearned(null)).toBe(false);
  });
});

describe('file names (ADR-0051 §2)', () => {
  it('finds one run of four digits that is not a year', () => {
    expect(fileNameLast4('Chase1234_Activity_20261101.csv')).toBe('1234');
    expect(fileNameLast4('Checking ...4321 Oct 2026.csv')).toBe('4321');
    expect(fileNameLast4('statement_2026-10.csv')).toBeNull();
    expect(fileNameLast4('export.csv')).toBeNull();
    // Two candidates: neither is trusted.
    expect(fileNameLast4('1234-5678.csv')).toBeNull();
  });

  it('keeps the shape of the name', () => {
    expect(fileNamePattern('Chase1234_Activity_20261101.CSV')).toBe('chase#_activity_#');
    expect(fileNamePattern('Chase5678_Activity_20261201.csv')).toBe('chase#_activity_#');
    expect(fileNamePattern('2026-10.csv')).toBeNull();
  });
});

describe('signals', () => {
  it('prefers printed digits, then the issuer, for PDFs and photos', () => {
    expect(
      statementSignal({ fileType: 'pdf', printedLast4: '1234', issuer: 'Chase', fileName: 'x.pdf' }),
    ).toBe('last4:1234');
    expect(
      statementSignal({ fileType: 'image', issuer: 'Wells Fargo Bank, N.A.', fileName: 'IMG_1.jpg' }),
    ).toBe('issuer:wells fargo bank n a');
    expect(statementSignal({ fileType: 'pdf', fileName: 'scan.pdf' })).toBeNull();
  });

  it('keys an OFX account by its bank and a hash of its account id', () => {
    const [acct] = ofxAccounts(new TextDecoder().decode(bytes('bank-ofx2.ofx')));
    expect(acct).toMatchObject({ bankId: '021000021', acctId: '9876543210', card: false });
    const signal = statementSignal({ fileType: 'ofx', ofx: acct, fileName: 'download.qfx' })!;
    expect(signal).toMatch(/^ofx:021000021:[0-9a-f]{24}$/);
    expect(signal).not.toContain('9876543210');
    const [first] = ofxAccounts(new TextDecoder().decode(bytes('bank-ofx1.ofx')));
    expect(first).toMatchObject({ bankId: '123456789', acctId: '000012345678', org: 'First Bank' });
  });

  it('keys a CSV by the digits in its name, else its header and name pattern', () => {
    const sheets = readTextSheets('csv', bytes('chase-checking.csv'));
    const fp = sheetFingerprint(sheets, 'csv');
    // The same fingerprint the import profile is saved under.
    expect(fp).toBe(analyze(sheets, { fileType: 'csv', currency: 'USD', accountType: 'asset' }).fingerprint);
    expect(statementSignal({ fileType: 'csv', fileName: 'Chase1234_Activity.csv', fingerprint: fp })).toBe(
      'last4:1234',
    );
    expect(statementSignal({ fileType: 'csv', fileName: 'chase-checking.csv', fingerprint: fp })).toBe(
      `shape:${fp}:chase_checking`,
    );
    expect(
      statementSignal({ fileType: 'csv', fileName: 'chase-checking.csv', fingerprint: null }),
    ).toBeNull();
  });

  it('keys a bill by its account digits, else its provider', () => {
    expect(billSignal({ accountLast4: '5521', billerName: 'SDG&E' })).toBe('last4:5521');
    expect(billSignal({ accountLast4: null, billerName: 'Pacific Gas & Electric' })).toMatch(
      /^name:PACIFIC GAS/,
    );
    expect(billSignal({})).toBeNull();
  });

  it('keys a tax form’s issuer by EIN, account digits, else name (ADR-0052 §4)', () => {
    expect(taxIssuerSignal({ kind: 'w2', ein: '123456789', issuerName: 'Acme Corp' })).toBe(
      'w2:ein:123456789',
    );
    expect(taxIssuerSignal({ kind: 'w2', issuerName: 'Acme Corp' })).toMatch(/^w2:name:ACME/);
    expect(taxIssuerSignal({ kind: '1099_int', ein: '987654321', accountLast4: '4321' })).toBe(
      '1099_int:ein:987654321:last4:4321',
    );
    expect(taxIssuerSignal({ kind: '1098', ein: '987654321' })).toBe('1098:ein:987654321');
    expect(taxIssuerSignal({ kind: '1099_div', issuerName: 'Big Brokerage' })).toMatch(/^1099_div:name:BIG/);
    expect(taxIssuerSignal({ kind: '1099_div' })).toBeNull();
    expect(taxSignalHasEin('1099_int:ein:987654321:last4:4321')).toBe(true);
    expect(taxSignalHasEin('w2:name:ACME')).toBe(false);
  });

  it('compares institutions as words', () => {
    expect(institutionKey('JPMorgan Chase Bank, N.A.')).toBe('jpmorgan chase bank n a');
  });
});

describe('clean imports (ADR-0051 §4)', () => {
  const ok: ImportOutcome = {
    status: 'preview',
    balanceCheck: 'ok',
    counts: { new: 5, match: 1, duplicate: 0, probableDuplicate: 0, error: 0 },
  };
  it('is clean when nothing needs a decision', () => {
    expect(cleanImport(ok)).toEqual({ clean: true });
    expect(cleanImport({ ...ok, balanceCheck: 'n_a' })).toEqual({ clean: true });
  });
  it('names what needs a decision', () => {
    expect(cleanImport({ ...ok, status: 'needs_mapping' })).toMatchObject({ reason: 'needs_mapping' });
    expect(cleanImport({ ...ok, status: 'failed' })).toMatchObject({ reason: 'import_failed' });
    expect(cleanImport({ ...ok, counts: { ...ok.counts, probableDuplicate: 2 } })).toMatchObject({
      reason: 'duplicates',
    });
    expect(cleanImport({ ...ok, counts: { ...ok.counts, error: 1 } })).toMatchObject({ reason: 'errors' });
    expect(cleanImport({ ...ok, balanceCheck: 'mismatch' })).toMatchObject({ reason: 'balance' });
    expect(cleanImport({ ...ok, counts: { ...ok.counts, new: 0, match: 0, duplicate: 6 } })).toMatchObject({
      reason: 'nothing_new',
    });
  });
});
