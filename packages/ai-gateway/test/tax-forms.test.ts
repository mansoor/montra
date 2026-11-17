import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseTaxFormBoxes } from '@montra/domain';
import {
  createGateway,
  decimalToMinor,
  FakeAdapter,
  maskTaxFormText,
  MemoryStore,
  taxFormBoxesFromWire,
  type AiContext,
  type CompletionRequest,
  type CompletionResponse,
  type ProviderAdapter,
  type TaxFormDocument,
  type TaxFormExtraction,
} from '../src/index.js';

// extract_tax_form (ADR-0052 §6, TAX-02, TAX-08). The eval corpus in test/tax-forms holds synthetic forms as the
// doc-worker hands them on (masked text, pages split by "--- page ---") and the reading the fake provider must give.
// Set UPDATE_TAX_FORM_CORPUS=1 to write the .json files from the current reading (then review them by hand).
const DIR = join(__dirname, 'tax-forms');
const corpus = readdirSync(DIR)
  .filter((f) => f.endsWith('.txt'))
  .map((f) => ({
    name: f.replace(/\.txt$/, ''),
    pages: readFileSync(join(DIR, f), 'utf8')
      .split(/\n--- page ---\n/)
      .map((text, i) => ({ page: i + 1, text })),
  }));

const PSEUDONYMS = [
  { name: 'Sam Example', token: 'MEMBER_1' },
  { name: 'Alex Example', token: 'MEMBER_2' },
];

const ctxOf = (store: MemoryStore, over: Partial<AiContext> = {}): AiContext => ({
  workspaceId: 'w1',
  mode: 'builtin',
  provider: { id: 'fake' },
  budget: { monthlyUsd: null, spentMicroUsd: 0n },
  store,
  pseudonyms: PSEUDONYMS,
  ...over,
});

const doc = (pages: TaxFormDocument['pages'], taxYearHint: number | null = 2025): TaxFormDocument => ({
  pages,
  taxYearHint,
});

class Scripted implements ProviderAdapter {
  readonly id = 'fake' as const;
  readonly calls: CompletionRequest[] = [];
  constructor(private readonly answer: unknown) {}
  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    this.calls.push(req);
    return {
      ok: true,
      json: this.answer,
      usage: { inputTokens: 10, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 },
      model: req.model,
    };
  }
}

describe('tax form corpus (eval, fake provider)', () => {
  it.each(corpus.map((c) => [c.name, c] as const))('%s reads as recorded', async (name, c) => {
    const res = await createGateway().extractTaxForm(doc(c.pages), ctxOf(new MemoryStore()));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const file = join(DIR, `${name}.json`);
    if (process.env.UPDATE_TAX_FORM_CORPUS) writeFileSync(file, `${JSON.stringify(res.value, null, 2)}\n`);
    const expected = JSON.parse(readFileSync(file, 'utf8')) as TaxFormExtraction;
    expect(res.value).toEqual(expected);
    // Every reading is valid boxes for its kind.
    for (const f of res.value.forms) expect(() => parseTaxFormBoxes(f.kind, f.boxes)).not.toThrow();
  });

  it('covers every phase 1 kind, a consolidated 1099 and corrected forms', async () => {
    const kinds = new Set<string>();
    let corrected = 0;
    let other = 0;
    for (const c of corpus) {
      const res = await createGateway().extractTaxForm(doc(c.pages), ctxOf(new MemoryStore()));
      if (!res.ok) continue;
      for (const f of res.value.forms) {
        kinds.add(f.kind);
        if (f.corrected) corrected++;
      }
      other += res.value.otherForms;
    }
    expect([...kinds].sort()).toEqual(['1098', '1099_div', '1099_int', 'w2']);
    expect(corrected).toBeGreaterThanOrEqual(2);
    expect(other).toBeGreaterThanOrEqual(1);
  });

  it('reads a consolidated 1099 as one form per section, on its pages', async () => {
    const c = corpus.find((x) => x.name === 'consolidated-1099')!;
    const res = await createGateway().extractTaxForm(doc(c.pages), ctxOf(new MemoryStore()));
    expect(res.ok && res.value.forms.map((f) => [f.kind, f.issuerName, f.person, f.pages])).toEqual([
      ['1099_div', 'Sample Brokerage LLC', 'MEMBER_1', [1]],
      ['1099_int', 'Sample Brokerage LLC', 'MEMBER_1', [1]],
    ]);
    expect(res.ok && res.value.otherForms).toBe(1);
  });
});

describe('extract_tax_form minimization (TAX-08)', () => {
  const w2 = corpus.find((c) => c.name === 'w2-acme')!;

  it('never sends an image, whatever the workspace allows', async () => {
    const fake = new FakeAdapter();
    // Builtin mode with documents allowed: a payslip's images would go; a tax form's never do.
    const res = await createGateway({ adapterFactory: () => fake }).extractTaxForm(
      // Even a caller that smuggles images onto the document can't get them sent.
      { ...doc(w2.pages), images: [{ mediaType: 'image/png', data: 'aGVsbG8=' }] } as TaxFormDocument,
      ctxOf(new MemoryStore(), { mode: 'byok' }),
    );
    expect(res.ok).toBe(true);
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]!.images ?? []).toEqual([]);
    expect(fake.calls[0]!.input).not.toContain('aGVsbG8=');
  });

  it('masks SSNs, EINs and names before anything leaves, and keeps form names, years and amounts', async () => {
    const fake = new FakeAdapter();
    await createGateway({ adapterFactory: () => fake }).extractTaxForm(
      doc([
        {
          page: 1,
          text: [
            'Form W-2 Wage and Tax Statement 2025',
            'a Employee social security number 123-45-6789',
            'b Employer identification number (EIN) 12-3456789',
            'e Employee name Sam Example',
            'Account 000123456789 truncated XXX-XX-6789',
            '1 Wages, tips, other compensation 85,120.34',
            'Form 1099-INT 1098 W-2c',
          ].join('\n'),
        },
      ]),
      ctxOf(new MemoryStore()),
    );
    const sent = fake.calls[0]!.input;
    expect(sent).not.toMatch(/\d{3}-\d{2}-\d{4}/);
    expect(sent).not.toContain('12-3456789');
    expect(sent).not.toContain('000123456789');
    expect(sent).not.toContain('6789');
    expect(sent).not.toContain('Sam Example');
    expect(sent).toContain('MEMBER_1');
    expect(sent).toContain('85,120.34');
    expect(sent).toContain('2025');
    expect(sent).toContain('Form 1099-INT 1098 W-2c');
  });

  it('drops a name returned as the person, and boxes that are not valid for the kind', async () => {
    const scripted = new Scripted({
      forms: [
        {
          kind: 'w2',
          taxYear: 2025,
          corrected: false,
          issuerName: 'Acme Widgets Inc',
          person: 'Sam Example',
          pages: [1, 9],
          boxes: [
            { box: '1', value: '85,120.34', code: '', label: '' },
            { box: '1', value: '1.00', code: '', label: '' },
            { box: '9', value: '100.00', code: '', label: '' },
            { box: '12', value: '19500', code: 'ZZ', label: '' },
            { box: '12', value: '19500', code: 'D', label: '' },
            { box: '2', value: '-5.00', code: '', label: '' },
            { box: '13', value: 'X', code: 'retirement_plan', label: '' },
          ],
          confidence: 1.4,
        },
        {
          kind: 'w2',
          taxYear: 1890,
          corrected: false,
          issuerName: 'MEMBER_1',
          person: null,
          pages: [],
          boxes: [],
          confidence: 0.5,
        },
        {
          kind: 'other',
          taxYear: 2025,
          corrected: false,
          issuerName: null,
          person: null,
          pages: [1],
          boxes: [],
          confidence: 1,
        },
      ],
    });
    const res = await createGateway({ adapterFactory: () => scripted }).extractTaxForm(
      doc([{ page: 1, text: 'Form W-2 2025' }]),
      ctxOf(new MemoryStore()),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const [first, second] = res.value.forms;
    expect(first).toMatchObject({
      person: null,
      pages: [1],
      boxes: { box1: '8512034', box12: [{ code: 'D', amount: '1950000' }], box13: { retirementPlan: true } },
      droppedBoxes: 4,
      confidence: 1,
    });
    expect(second).toMatchObject({ taxYear: null, issuerName: null });
    expect(res.value.otherForms).toBe(1);
  });

  it('keeps amounts, names and identifiers out of the audit record', async () => {
    const store = new MemoryStore();
    await createGateway().extractTaxForm(doc(w2.pages), ctxOf(store));
    const event = JSON.stringify(store.events.at(-1), (_k, v) => (typeof v === 'bigint' ? String(v) : v));
    expect(event).not.toContain('Acme');
    expect(event).not.toContain('8512034');
    expect(event).not.toContain('85,120.34');
    expect(event).not.toContain('MEMBER_1');
    expect(event).toContain('"forms":1');
  });

  it('degrades when AI is off or there is no text', async () => {
    expect(
      await createGateway().extractTaxForm(doc(w2.pages), ctxOf(new MemoryStore(), { mode: 'off' })),
    ).toMatchObject({
      ok: false,
      reason: 'off',
    });
    expect(
      await createGateway().extractTaxForm(doc([{ page: 1, text: '  ' }]), ctxOf(new MemoryStore())),
    ).toMatchObject({ ok: false, reason: 'invalid_output' });
  });
});

describe('tax form boxes from the wire', () => {
  it('parses decimal amounts to minor units, refusing negatives and fractions of a cent', () => {
    expect(decimalToMinor('85,120.34')).toBe('8512034');
    expect(decimalToMinor('$412')).toBe('41200');
    expect(decimalToMinor('0.5')).toBe('50');
    expect(decimalToMinor('-1.00')).toBeNull();
    expect(decimalToMinor('1.005')).toBeNull();
    expect(decimalToMinor('twelve')).toBeNull();
  });

  it('builds state rows per kind', () => {
    expect(
      taxFormBoxesFromWire('1099_div', [
        { box: '14', value: '', code: 'CA', label: '' },
        { box: '15', value: 'CA-1', code: 'CA', label: '' },
        { box: '16', value: '20.00', code: 'CA', label: '' },
      ]).boxes,
    ).toEqual({ states: [{ state: 'CA', stateId: 'CA-1', stateTaxWithheld: '2000' }] });
    expect(
      taxFormBoxesFromWire('1098', [
        { box: '3', value: '2019-06-14', code: '', label: '' },
        { box: '3', value: '2019-02-30', code: '', label: '' },
        { box: '10', value: '3250.00', code: '', label: 'Property tax' },
      ]),
    ).toEqual({
      boxes: { box3: '2019-06-14', box10: '325000', box10Label: 'Property tax' },
      kept: 2,
      dropped: 1,
    });
  });

  it('masks every TIN shape the forms print', () => {
    const out = maskTaxFormText('SSN 123-45-6789 · ***-**-6789 · XXX XX 6789 · EIN 12-3456789 · 2025', []);
    expect(out).not.toMatch(/6789|3456789/);
    expect(out).toContain('2025');
  });
});
