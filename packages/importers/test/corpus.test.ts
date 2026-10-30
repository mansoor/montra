import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { CurrencyCode } from '@montra/domain';
import { analyze, decodeText, detectFileType, parseDelimited } from '../src/index.js';

const dir = join(dirname(fileURLToPath(import.meta.url)), 'corpus');

interface Expectation {
  account: 'asset' | 'liability';
  currency: CurrencyCode;
  rows: number;
  errors: number;
  skipped?: number;
  first: { date: string; amount: number; contains: string };
  total: number;
  balance: 'ok' | 'mismatch' | 'n_a';
  sign?: 'normal' | 'inverted';
  key?: string;
  template?: string;
  accountFilter?: string;
  dayFirst?: boolean;
  warning?: string;
}

const expected = JSON.parse(readFileSync(join(dir, 'expected.json'), 'utf8')) as Record<string, Expectation>;

describe('golden corpus (IMP-03, UP-01)', () => {
  for (const [file, e] of Object.entries(expected)) {
    it(file, () => {
      const bytes = new Uint8Array(readFileSync(join(dir, file)));
      expect(detectFileType(bytes, file)).toBe('csv');
      const { text } = decodeText(bytes);
      const sheet = parseDelimited(text);
      const a = analyze([sheet], {
        fileType: 'csv',
        currency: e.currency,
        accountType: e.account,
        preferDayFirst: e.dayFirst,
        accountFilter: e.accountFilter,
      });
      const { rows, errors } = a.parsed;
      expect({ rows: rows.length, errors: errors.length }).toEqual({ rows: e.rows, errors: e.errors });
      if (e.skipped !== undefined) expect(a.parsed.skipped.length).toBe(e.skipped);
      const first = rows[0]!;
      expect(first.date).toBe(e.first.date);
      expect(first.amount).toBe(BigInt(e.first.amount));
      expect(`${first.payee ?? ''} ${first.description}`).toContain(e.first.contains);
      expect(rows.reduce((t, r) => t + r.amount, 0n)).toBe(BigInt(e.total));
      expect(a.balance.status).toBe(e.balance);
      if (e.sign) expect(a.proposal.mapping.sign).toBe(e.sign);
      if (e.key) expect(first.normalizedDescription).toBe(e.key);
      if (e.template) expect(a.proposal).toMatchObject({ source: 'reference', templateId: e.template });
      if (e.warning) expect(a.proposal.warnings).toContain(e.warning);
      // Loss-proof accounting: every non-blank line is a row, an error or a counted skip.
      const nonBlankSkips = a.parsed.skipped.filter((s) => s.reason !== 'blank').length;
      expect(a.parsed.read).toBe(rows.length + errors.length + nonBlankSkips);
    });
  }
});
