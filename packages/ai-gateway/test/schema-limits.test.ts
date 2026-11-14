/**
 * Every task's structured-output schema stays within what the providers compile (AIA-04). Anthropic refuses a schema
 * with more than 16 parameters whose type is a union (a type array or anyOf, which is how a nullable field comes
 * out): receipts failed in production with "Schemas contains too many parameters with union types (17 ...)".
 * The fake provider used in tests never sends a schema, so only this test catches it.
 */
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { jsonSchemaOf } from '../src/schema.js';
import * as answerQuestion from '../src/tasks/answer-question/v1.js';
import * as categorize from '../src/tasks/categorize/v1.js';
import * as extractPayslip from '../src/tasks/extract-payslip/v2.js';
import * as extractBill from '../src/tasks/extract-bill/v1.js';
import * as extractReceipt from '../src/tasks/extract-receipt/v3.js';
import * as extractStatementTable from '../src/tasks/extract-statement-table/v1.js';
import * as flagCapital from '../src/tasks/flag-capital/v1.js';
import * as flagSeparation from '../src/tasks/flag-separation/v1.js';
import * as mapColumns from '../src/tasks/map-columns/v1.js';
import * as mapTaxLines from '../src/tasks/map-tax-lines/v1.js';
import * as normalizePayees from '../src/tasks/normalize-payees/v1.js';
import * as parseQuickAdd from '../src/tasks/parse-quick-add/v1.js';
import * as ping from '../src/tasks/ping/v1.js';
import * as proposeCategories from '../src/tasks/propose-categories/v1.js';
import * as summarizeMonth from '../src/tasks/summarize-month/v1.js';
import * as wordSummary from '../src/tasks/word-summary/v1.js';

/** Anthropic's limit on union-typed parameters in one schema. */
const MAX_UNION_PARAMS = 16;

/** Counts schema nodes whose type is a union: `type: [...]` or `anyOf`. */
function unionParams(node: unknown): number {
  if (Array.isArray(node)) return node.reduce((n: number, x) => n + unionParams(x), 0);
  if (!node || typeof node !== 'object') return 0;
  const o = node as Record<string, unknown>;
  const here = Array.isArray(o.type) || Array.isArray(o.anyOf) ? 1 : 0;
  return here + Object.values(o).reduce((n: number, v) => n + unionParams(v), 0);
}

const TASKS: Record<string, z.ZodType> = {
  extract_bill: extractBill.Output,
  answer_question: answerQuestion.Output,
  categorize: categorize.Output,
  extract_payslip: extractPayslip.Output,
  extract_receipt: extractReceipt.Output,
  extract_statement_table: extractStatementTable.Output,
  flag_capital: flagCapital.Output,
  flag_separation: flagSeparation.Output,
  map_columns: mapColumns.Output,
  map_tax_lines: mapTaxLines.Output,
  normalize_payees: normalizePayees.Output,
  parse_quick_add: parseQuickAdd.Output,
  ping: ping.Output,
  propose_categories: proposeCategories.Output,
  summarize_month: summarizeMonth.Output,
  word_summary: wordSummary.Output,
};

describe('structured-output schemas (AIA-04)', () => {
  it('counts union-typed parameters the way the provider does', () => {
    expect(
      unionParams({ type: 'object', properties: { a: { anyOf: [{ type: 'string' }, { type: 'null' }] } } }),
    ).toBe(1);
    expect(unionParams({ properties: { a: { type: ['string', 'null'] }, b: { type: 'string' } } })).toBe(1);
  });

  it.each(Object.entries(TASKS))('%s has at most 16 union-typed parameters', (_task, schema) => {
    expect(unionParams(jsonSchemaOf(schema))).toBeLessThanOrEqual(MAX_UNION_PARAMS);
  });
});
