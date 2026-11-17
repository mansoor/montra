import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TAX_CHECK_STATUSES, TaxFormBoxesJsonSchemas } from '@montra/domain';
import { catalogs } from '@montra/i18n';
import {
  TAX_FORM_READING_PROBLEMS,
  TAX_FORM_RESULT_STATES,
  type TaxFormCheckDto,
  type TaxFormDto,
  type TaxFormExpectedDto,
} from '@montra/schemas';
import { createApi } from '../src/api/client';
import {
  acceptable,
  anyReading,
  boxLabel,
  boxLines,
  byPerson,
  canConfirmReading,
  canMatchEmployer,
  checkTone,
  defaultTaxYear,
  drillDown,
  expectedTone,
  KINDS,
  matchableAccounts,
  matchedIds,
  matchUpdate,
  MONEY_BOXES,
  personPickable,
  pickableCandidates,
  READING_STAGES,
  readingStage,
  resultLabel,
  resultTone,
  reviewBadge,
  scanUploads,
  showsTaxForms,
  shownDifference,
  TaxFormsToCheck,
  titleOf,
  uploadOutcome,
  yearChoices,
  yearSections,
} from '../src/features/tax-forms';

// Tax forms on the phone (ADR-0052 §7.2, TAX-09).

const reading = (
  over: Partial<NonNullable<TaxFormDto['reading']>> = {},
): NonNullable<TaxFormDto['reading']> => ({
  fileNames: ['w2-scan.pdf'],
  kindKnown: true,
  boxesRead: true,
  problem: null,
  droppedBoxes: 0,
  confirmedBy: null,
  match: { automatic: false, reason: null, candidates: [] },
  copyOfId: null,
  ...over,
});

const form = (over: Partial<TaxFormDto> = {}): TaxFormDto =>
  ({
    id: 'f1',
    entityId: 'e1',
    taxYear: 2025,
    kind: 'w2',
    corrected: false,
    supersedesId: null,
    issuerName: 'Acme Corp',
    issuerEin: '123456789',
    issuerTinLast4: null,
    personTinLast4: '6789',
    accountLast4: null,
    personMemberId: 'm1',
    targets: [{ employerId: 'emp1', accountId: null }],
    fileIds: [],
    pages: null,
    status: 'confirmed',
    reason: null,
    source: 'typed',
    createdBy: 'u1',
    confirmedBy: 'u1',
    confirmedAt: '2026-02-01T00:00:00Z',
    deletedAt: null,
    createdAt: '2026-02-01T00:00:00Z',
    updatedAt: '2026-02-01T00:00:00Z',
    version: 3,
    result: { state: 'matches', difference: null, review: false, recordable: null, recorded: null },
    checks: [],
    reading: null,
    boxes: { box1: '8512034', box2: '1200000' },
    ...over,
  }) as TaxFormDto;

const check = (over: Partial<TaxFormCheckDto> = {}): TaxFormCheckDto => ({
  box: '1',
  kind: 'check',
  form: '100000',
  books: '90000',
  difference: '10000',
  status: 'differs',
  rule: 'Earnings less pre-tax deductions',
  explanation: null,
  acceptedNote: null,
  sources: { payslipIds: ['p1', 'p2'], transactionIds: [], loanPaymentIds: [], journalEntryIds: ['j1'] },
  ...over,
});

describe('who sees tax forms', () => {
  it('shows them in US-dollar workspaces, not to viewers (as the web)', () => {
    expect(showsTaxForms({ baseCurrency: 'USD', role: 'owner' })).toBe(true);
    expect(showsTaxForms({ baseCurrency: 'USD', role: 'accountant' })).toBe(true);
    expect(showsTaxForms({ baseCurrency: 'USD', role: 'member' })).toBe(true);
    expect(showsTaxForms({ baseCurrency: 'USD', role: 'viewer' })).toBe(false);
    expect(showsTaxForms({ baseCurrency: 'EUR', role: 'owner' })).toBe(false);
  });

  it('never lets an accountant match a W-2 to an employer (the owner’s decision)', () => {
    expect(canMatchEmployer('owner')).toBe(true);
    expect(canMatchEmployer('admin')).toBe(true);
    expect(canMatchEmployer('partner')).toBe(true);
    expect(canMatchEmployer('member')).toBe(true);
    expect(canMatchEmployer('accountant')).toBe(false);
    expect(canMatchEmployer('viewer')).toBe(false);
    const candidates = [
      { employerId: 'emp1', accountId: null, name: 'Acme', reason: 'Only employer' },
      { employerId: null, accountId: 'a1', name: 'Savings', reason: 'Ends 4471' },
    ];
    const f = form({ reading: reading({ match: { automatic: false, reason: null, candidates } }) });
    expect(pickableCandidates(f, 'accountant').map((c) => c.name)).toEqual(['Savings']);
    expect(pickableCandidates(f, 'owner').map((c) => c.name)).toEqual(['Acme', 'Savings']);
    expect(pickableCandidates(form(), 'owner')).toEqual([]);
  });
});

describe('the year', () => {
  it('opens last year until April, this year after', () => {
    expect(defaultTaxYear('2026-01-15')).toBe(2025);
    expect(defaultTaxYear('2026-04-30')).toBe(2025);
    expect(defaultTaxYear('2026-05-01')).toBe(2026);
    expect(defaultTaxYear('2026-12-31')).toBe(2026);
  });

  it('offers the last four years, and an older one being shown', () => {
    expect(yearChoices('2026-02-01', 2025)).toEqual([2026, 2025, 2024, 2023]);
    expect(yearChoices('2026-02-01', 2020)).toEqual([2026, 2025, 2024, 2023, 2020]);
  });
});

describe('a form’s result and checks', () => {
  it('colours results as the web does', () => {
    expect(resultTone('matches')).toBe('good');
    expect(resultTone('accepted')).toBe('good');
    for (const s of ['not_tracked', 'reading', 'dismissed', 'superseded'] as const)
      expect(resultTone(s)).toBe('muted');
    for (const s of [
      'differs',
      'check_reading',
      'needs_match',
      'needs_person',
      'unread',
      'probable_copy',
    ] as const)
      expect(resultTone(s)).toBe('warn');
    expect(checkTone('explained')).toBe('good');
    expect(checkTone('check_reading')).toBe('warn');
    expect(checkTone('info')).toBe('muted');
  });

  it('says by how much a form differs, without the sign', () => {
    expect(resultLabel({ state: 'differs', difference: '-41250' })).toEqual({
      key: 'tax_forms.result.differs_by',
      amount: 41250n,
    });
    expect(resultLabel({ state: 'differs', difference: '100' }).amount).toBe(100n);
    expect(resultLabel({ state: 'needs_match', difference: null })).toEqual({
      key: 'tax_forms.result.needs_match',
      amount: null,
    });
  });

  it('titles a form by its kind and issuer, or a file not read yet by its name', () => {
    expect(titleOf(form())).toEqual({ kindKey: 'tax_forms.kind.w2', issuer: 'Acme Corp' });
    expect(titleOf(form({ issuerName: null }))).toEqual({ kindKey: 'tax_forms.kind.w2', issuer: null });
    expect(titleOf(form({ reading: reading({ kindKnown: false }) }))).toEqual({ fileName: 'w2-scan.pdf' });
  });

  it('accepts only a check box that differs, and shows only its difference', () => {
    expect(acceptable(check())).toBe(true);
    expect(acceptable(check({ status: 'check_reading' }))).toBe(true);
    expect(acceptable(check({ status: 'accepted' }))).toBe(false);
    expect(acceptable(check({ kind: 'info', status: 'differs' }))).toBe(false);
    expect(shownDifference(check())).toBe('10000');
    expect(shownDifference(check({ kind: 'info' }))).toBeNull();
  });

  it('drills down to payslips and transactions, and counts the entries left to the web', () => {
    expect(drillDown(check())).toEqual({ payslipIds: ['p1', 'p2'], transactionIds: [], entries: 1 });
  });
});

describe('reading a form from a file', () => {
  it('says where the reading stands', () => {
    expect(readingStage(form())).toBeNull();
    expect(readingStage(form({ status: 'reading', reading: reading({ boxesRead: false }) }))).toBe('reading');
    expect(readingStage(form({ status: 'reading', reading: reading({ problem: 'waiting' }) }))).toBe(
      'waiting',
    );
    expect(readingStage(form({ status: 'reading', reading: reading({ problem: 'failed' }) }))).toBe('unread');
    expect(readingStage(form({ status: 'review', reason: 'unread', reading: reading() }))).toBe('unread');
    expect(readingStage(form({ status: 'review', reading: reading({ kindKnown: false }) }))).toBe('unread');
    expect(readingStage(form({ status: 'review', reason: 'differs', reading: reading() }))).toBe(
      'to_confirm',
    );
    expect(readingStage(form({ reading: reading({ confirmedBy: 'books' }) }))).toBe('confirmed_by_books');
    expect(readingStage(form({ reading: reading({ confirmedBy: 'person' }) }))).toBe('confirmed');
  });

  it('confirms a reading only when it is read, matched and for a known person', () => {
    const toConfirm = form({ status: 'review', reason: 'differs', reading: reading() });
    expect(canConfirmReading(toConfirm)).toBe(true);
    expect(canConfirmReading({ ...toConfirm, reading: null })).toBe(false);
    expect(canConfirmReading({ ...toConfirm, targets: [] })).toBe(false);
    expect(canConfirmReading({ ...toConfirm, personMemberId: null })).toBe(false);
    expect(canConfirmReading({ ...toConfirm, boxes: {} })).toBe(false);
    expect(canConfirmReading({ ...toConfirm, reason: 'unread' })).toBe(false);
    expect(canConfirmReading({ ...toConfirm, status: 'confirmed' })).toBe(false);
  });

  it('looks again while a form is being read, not once its reading failed', () => {
    expect(anyReading([form()])).toBe(false);
    expect(anyReading([form({ status: 'reading', reading: reading() })])).toBe(true);
    expect(anyReading([form({ status: 'reading', reading: reading({ problem: 'failed' }) })])).toBe(false);
  });
});

describe('the boxes as read', () => {
  it('lists only boxes each kind has', () => {
    for (const kind of KINDS) {
      const shape = Object.keys(TaxFormBoxesJsonSchemas[kind].shape);
      for (const box of MONEY_BOXES[kind]) expect(shape).toContain(box);
    }
  });

  it('shows a W-2’s money boxes in order, its box 12 codes and its first state', () => {
    const lines = boxLines(
      form({
        boxes: {
          box2: '1200000',
          box1: '8512034',
          box12: [{ code: 'D', amount: '1950000' }],
          states: [{ state: 'CA', box16: '8000000', box17: '400000' }],
        },
      }),
    );
    expect(lines).toEqual([
      { box: '1', nameKey: 'tax_forms.box_name.w2.box1', amount: '8512034' },
      { box: '2', nameKey: 'tax_forms.box_name.w2.box2', amount: '1200000' },
      { box: '12D', nameKey: null, amount: '1950000' },
      { box: null, nameKey: 'tax_forms.w2_box16', amount: '8000000' },
      { box: null, nameKey: 'tax_forms.w2_box17', amount: '400000' },
    ]);
    const t = (key: string, v?: Record<string, string | number>) =>
      v ? `${key}(${JSON.stringify(v)})` : key;
    expect(boxLabel(lines[0]!, t)).toBe(
      'tax_forms.box_label({"box":"1","name":"tax_forms.box_name.w2.box1"})',
    );
    expect(boxLabel(lines[2]!, t)).toBe('tax_forms.box_short({"box":"12D"})');
    expect(boxLabel(lines[3]!, t)).toBe('tax_forms.w2_box16');
  });

  it('shows a 1098’s dates and a 1099-DIV’s lettered boxes', () => {
    expect(
      boxLines(form({ kind: '1098', boxes: { box1: '1500000', box3: '2019-06-01', box11: '2019-06-15' } })),
    ).toEqual([
      { box: '1', nameKey: 'tax_forms.box_name.1098.box1', amount: '1500000' },
      { box: null, nameKey: 'tax_forms.box_1098_box3', date: '2019-06-01' },
      { box: '11', nameKey: null, date: '2019-06-15' },
    ]);
    expect(
      boxLines(form({ kind: '1099_div', boxes: { box1b: '500', box1a: '900' } })).map((l) => l.box),
    ).toEqual(['1a', '1b']);
  });
});

describe('the year’s list', () => {
  const expected = (over: Partial<TaxFormExpectedDto>): TaxFormExpectedDto => ({
    kind: 'w2',
    employerId: 'emp1',
    accountId: null,
    personMemberId: 'm1',
    entityId: 'e1',
    name: 'Acme',
    amount: '100',
    state: 'missing',
    formId: null,
    waiverId: null,
    ...over,
  });

  it('groups expected forms by person, the household last', () => {
    const names = new Map([
      ['m1', 'Sam'],
      ['m2', 'Alex'],
    ]);
    const groups = byPerson(
      [
        expected({ personMemberId: null, kind: '1099_int', employerId: null, accountId: 'a1' }),
        expected({}),
        expected({ personMemberId: 'm2', employerId: 'emp2' }),
      ],
      names,
    );
    expect(groups.map((g) => g.name)).toEqual(['Alex', 'Sam', null]);
    expect(expectedTone('received')).toBe('good');
    expect(expectedTone('missing')).toBe('warn');
    expect(expectedTone('waived')).toBe('muted');
  });

  it('lists the forms being read, and those received that nothing expected', () => {
    const read = form({ id: 'r', status: 'reading', reading: reading() });
    const other = form({ id: 'o' });
    const sections = yearSections({ forms: [read, other, form({ id: 'x' })], unexpectedFormIds: ['o', 'r'] });
    expect(sections.reading.map((f) => f.id)).toEqual(['r']);
    expect(sections.unexpected.map((f) => f.id)).toEqual(['o']);
  });
});

describe('changing the match', () => {
  const accounts = [
    { id: 'chk', name: 'Checking', kind: 'checking', archived: false },
    { id: 'old', name: 'Old savings', kind: 'savings', archived: true },
    { id: 'card', name: 'Card', kind: 'credit_card', archived: false },
    { id: 'mtg', name: 'Mortgage', kind: 'mortgage', archived: false },
    { id: 'brk', name: 'Brokerage', kind: 'investment', archived: false },
  ] as const;

  it('offers a mortgage for a 1098, and accounts that aren’t debts for a 1099', () => {
    expect(matchableAccounts('1098', accounts).map((a) => a.id)).toEqual(['mtg']);
    expect(matchableAccounts('1099_int', accounts).map((a) => a.id)).toEqual(['chk', 'brk']);
  });

  it('sends a W-2’s employer with no person, so it takes the employer’s', () => {
    expect(matchUpdate(form(), { employerId: 'emp2' })).toEqual({
      targets: [{ employerId: 'emp2' }],
      personMemberId: null,
      version: 3,
    });
    expect(matchUpdate(form(), { accountIds: ['chk'] })).toBeNull();
    expect(matchUpdate(form({ kind: '1099_int' }), { employerId: 'emp2' })).toBeNull();
  });

  it('sends one account for a 1098 and every picked account for a 1099', () => {
    expect(matchUpdate(form({ kind: '1098' }), { accountIds: ['mtg', 'chk'] })).toEqual({
      targets: [{ accountId: 'mtg' }],
      version: 3,
    });
    expect(matchUpdate(form({ kind: '1099_int' }), { accountIds: ['chk', 'brk', 'chk'] })).toEqual({
      targets: [{ accountId: 'chk' }, { accountId: 'brk' }],
      version: 3,
    });
    expect(matchUpdate(form({ kind: '1099_div' }), { accountIds: [] })).toBeNull();
  });

  it('picks the person by hand, except on a W-2 matched to an employer', () => {
    expect(personPickable(form())).toBe(false);
    expect(personPickable(form({ targets: [] }))).toBe(true);
    expect(
      personPickable(form({ kind: '1099_int', targets: [{ employerId: null, accountId: 'chk' }] })),
    ).toBe(true);
    expect(matchedIds(form({ kind: '1099_int', targets: [{ employerId: null, accountId: 'chk' }] }))).toEqual(
      ['chk'],
    );
  });
});

describe('scanning a form', () => {
  it('combines the pages into one PDF, and sends a picked PDF as it is', () => {
    const plan = scanUploads([
      { uri: 'file:///1.jpg', type: 'image/jpeg', name: 'page-1.jpg', shot: true },
      { uri: 'file:///2.jpg', type: 'image/jpeg', name: 'page-2.jpg', shot: true },
      { uri: 'file:///w2.pdf', type: 'application/pdf', name: 'w2.pdf', shot: false },
    ]);
    expect(plan.images.map((p) => p.name)).toEqual(['page-1.jpg', 'page-2.jpg']);
    expect(plan.pdfs.map((p) => p.name)).toEqual(['w2.pdf']);
    expect(plan.imagesSource).toBe('scan');
    expect(
      scanUploads([{ uri: 'content://x.jpg', type: 'image/jpeg', name: 'x.jpg', shot: false }]).imagesSource,
    ).toBe('upload');
  });

  it('opens the form after one upload, and lists several or a duplicate', () => {
    expect(uploadOutcome([{ fileName: 'a.pdf', status: 'reading', formId: 'f1' }])).toEqual({
      lines: [{ key: 'tax_forms.upload_reading', values: { name: 'a.pdf' } }],
      openFormId: 'f1',
    });
    const two = uploadOutcome([
      { fileName: 'a.pdf', status: 'reading', formId: 'f1' },
      { fileName: 'b.pdf', status: 'duplicate', formId: 'f0' },
    ]);
    expect(two.openFormId).toBeNull();
    expect(two.lines[1]).toEqual({ key: 'tax_forms.upload_duplicate', values: { name: 'b.pdf' } });
  });
});

describe('the Review badge counts tax forms to check', () => {
  it('adds the forms to the transactions to review', () => {
    expect(reviewBadge(3, 2)).toBe(5);
    expect(reviewBadge(3, null)).toBe(3);
    expect(reviewBadge(0, 0)).toBe(0);
  });

  it('reads the count at most once a minute, at once when forced, and keeps it when offline', async () => {
    let now = 0;
    const counter = new TaxFormsToCheck(60_000, () => now);
    let reads = 0;
    let answer: number | Error = 2;
    const read = async () => {
      reads++;
      if (answer instanceof Error) throw answer;
      return answer;
    };
    const seen: Array<number | null> = [];
    const off = counter.subscribe(() => seen.push(counter.get()));
    expect(counter.get()).toBeNull();

    await counter.refresh(read);
    expect(counter.get()).toBe(2);
    now = 30_000;
    answer = 1;
    await counter.refresh(read);
    expect([reads, counter.get()]).toEqual([1, 2]);

    await counter.refresh(read, true);
    expect([reads, counter.get()]).toEqual([2, 1]);

    now = 200_000;
    answer = new Error('offline');
    await counter.refresh(read);
    expect([reads, counter.get()]).toEqual([3, 1]);

    // Review's list sets it, and resets the minute.
    counter.set(4);
    now = 230_000;
    await counter.refresh(read);
    expect([reads, counter.get()]).toEqual([3, 4]);
    off();
    expect(seen).toEqual([2, 1, 4]);
  });

  it('reads once when asked twice at the same time', async () => {
    const counter = new TaxFormsToCheck(60_000, () => 0);
    let reads = 0;
    let release: (n: number) => void = () => undefined;
    const read = () => {
      reads++;
      return new Promise<number>((r) => (release = r));
    };
    const a = counter.refresh(read, true);
    const b = counter.refresh(read, true);
    release(5);
    await Promise.all([a, b]);
    expect([reads, counter.get()]).toEqual([1, 5]);
  });
});

describe('the API calls', () => {
  it('reads, acts on and uploads forms at the web’s endpoints', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const f = (async (url: string, init: RequestInit = {}) => {
      calls.push({ url, init });
      const body = url.endsWith('/review')
        ? { data: [form()] }
        : url.endsWith('/files')
          ? { files: [] }
          : form();
      return new Response(JSON.stringify(body), { status: 200 });
    }) as unknown as typeof fetch;
    const api = createApi({ baseUrl: 'http://api', token: async () => 'dev:a@b.co', fetch: f });
    await api.taxYear('w1', 2025);
    expect((await api.taxFormsToCheck('w1')).map((x) => x.id)).toEqual(['f1']);
    await api.getTaxForm('w1', 'f1');
    await api.updateTaxForm('w1', 'f1', { personMemberId: 'm2', version: 3 });
    await api.confirmTaxFormReading('w1', 'f1', 3);
    await api.acceptTaxFormDifference('w1', 'f1', { box: '1', note: 'Bonus as a gift card' });
    await api.recordFromTaxForm('w1', 'f1', '4107');
    await api.undoRecordFromTaxForm('w1', 'f1');
    await api.uploadTaxFormFile(
      'w1',
      { uri: 'file:///cache/scan.pdf', name: 'tax-form-scan.pdf', type: 'application/pdf' },
      { year: 2025, source: 'scan' },
    );
    const base = 'http://api/v1/workspaces/w1/tax-forms';
    expect(calls.map((c) => [c.init.method, c.url.replace(base, '')])).toEqual([
      ['GET', '?year=2025'],
      ['GET', '/review'],
      ['GET', '/f1'],
      ['PATCH', '/f1'],
      ['POST', '/f1/confirm'],
      ['POST', '/f1/accept'],
      ['POST', '/f1/record'],
      ['DELETE', '/f1/record'],
      ['POST', '/files'],
    ]);
    const json = (i: number) => JSON.parse(String(calls[i]!.init.body)) as unknown;
    expect(json(3)).toEqual({ personMemberId: 'm2', version: 3 });
    expect(json(4)).toEqual({ version: 3 });
    expect(json(5)).toEqual({ box: '1', note: 'Bonus as a gift card' });
    expect(json(6)).toEqual({ amount: '4107' });
    const upload = calls[8]!.init.body as FormData;
    expect(upload).toBeInstanceOf(FormData);
    expect(upload.get('year')).toBe('2025');
    expect(upload.get('source')).toBe('scan');
  });
});

describe('the words the tax form screens use', () => {
  const en = catalogs.en!;
  const root = join(__dirname, '..');
  const files = [
    'app/tax-forms/index.tsx',
    'app/tax-forms/scan.tsx',
    'app/tax-forms/[id].tsx',
    'src/ui/TaxForms.tsx',
    'app/(tabs)/more.tsx',
    'app/_layout.tsx',
  ].map((p) => readFileSync(join(root, p), 'utf8'));

  it('are all in the catalog', () => {
    const keys = files.flatMap((text) => [...text.matchAll(/\bt\(\s*'([a-z0-9_.]+)'/g)].map((m) => m[1]!));
    expect(keys.length).toBeGreaterThan(30);
    expect(keys.filter((k) => !(k in en))).toEqual([]);
  });

  it('cover every result, reading stage, problem, check status and box name', () => {
    const dynamic = [
      ...TAX_FORM_RESULT_STATES.flatMap((s) => [`tax_forms.result.${s}`, `tax_forms.review_why.${s}`]),
      ...READING_STAGES.map((s) => `tax_forms.reading_stage.${s}`),
      ...TAX_FORM_READING_PROBLEMS.map((p) => `tax_forms.reading_problem.${p}`),
      ...TAX_CHECK_STATUSES.map((s) => `tax_forms.check_status.${s}`),
      ...KINDS.flatMap((k) => [`tax_forms.kind.${k}`, `tax_forms.expected_because.${k}`]),
      ...KINDS.flatMap((k) => MONEY_BOXES[k].map((b) => `tax_forms.box_name.${k}.${b}`)),
      ...['received', 'waived', 'missing'].map((s) => `tax_forms.expected_state.${s}`),
      ...['not_issued', 'combined', 'other'].map((r) => `tax_forms.waiver_reason.${r}`),
      'tax_forms.w2_box16',
      'tax_forms.w2_box17',
      'tax_forms.box_1098_box3',
    ];
    expect(dynamic.filter((k) => !(k in en))).toEqual([]);
  });
});
