/**
 * Tax forms on the phone (ADR-0052 §7.2, TAX-09). Pure: who sees them, which year to open, a form's result and checks
 * in words and tone, its boxes as read, the expected forms by person, what can be matched or confirmed, how scanned
 * pages are uploaded, and the Review badge's count of forms to check. The server works out every check; the phone only
 * shows them (no ledger logic here). Nothing here is synced: forms are read and acted on online (§10), and a year's list
 * is kept for offline viewing like account details.
 */
import type {
  AccountDto,
  MemberRole,
  TaxFormCandidateDto,
  TaxFormCheckDto,
  TaxFormDto,
  TaxFormExpectedDto,
  TaxFormResultDto,
  TaxFormUploadDto,
  TaxYearDto,
  UpdateTaxFormRequest,
} from '@montra/schemas';
import type { CapturedPage } from './scanner';

export type TaxFormKind = TaxFormDto['kind'];
export const KINDS: readonly TaxFormKind[] = ['w2', '1099_int', '1099_div', '1098'];

export interface Message {
  key: string;
  values?: Record<string, string | number>;
}

// ----- Who sees them ------------------------------------------------------------------------------------------------

/** US forms, so for books kept in US dollars; not for viewers (as the web's nav and Review). */
export const showsTaxForms = (ws: { baseCurrency: string; role: MemberRole }): boolean =>
  ws.baseCurrency === 'USD' && ws.role !== 'viewer';

/**
 * Who may match a W-2 to an employer: the API's `W2_EMPLOYER_MATCHERS`. Accountants never do, even with the owner's
 * setting on (the owner's decision): employers are private to their person (PAY-09).
 */
export const W2_EMPLOYER_MATCHERS: readonly MemberRole[] = ['owner', 'admin', 'partner', 'member'];
export const canMatchEmployer = (role: MemberRole): boolean => W2_EMPLOYER_MATCHERS.includes(role);

// ----- The year -----------------------------------------------------------------------------------------------------

/** Last year from January to April, while its forms arrive and are checked; this year otherwise (as the web). */
export function defaultTaxYear(today: string): number {
  const year = Number(today.slice(0, 4));
  const month = Number(today.slice(5, 7));
  return month <= 4 ? year - 1 : year;
}

/** The years the picker offers: the last four, newest first, and the one shown if it's older. */
export function yearChoices(today: string, shown: number): number[] {
  const year = Number(today.slice(0, 4));
  const years = [year, year - 1, year - 2, year - 3];
  return years.includes(shown) ? years : [...years, shown].sort((a, b) => b - a);
}

/** The cache name of a year's list (kept on the device for offline viewing). */
export const yearCacheName = (year: number) => `tax-forms.${year}`;
export const formCacheName = (id: string) => `tax-form.${id}`;

// ----- A form's result, title and checks ----------------------------------------------------------------------------

export type Tone = 'good' | 'warn' | 'muted';

/** Green when it matches, amber when it needs a look, grey otherwise (the web's `resultChip`). */
export function resultTone(state: TaxFormResultDto['state']): Tone {
  if (state === 'matches' || state === 'accepted') return 'good';
  if (state === 'not_tracked' || state === 'reading' || state === 'dismissed' || state === 'superseded')
    return 'muted';
  return 'warn';
}

/** A check's tone (the web's `checkChip`). */
export function checkTone(status: TaxFormCheckDto['status']): Tone {
  if (status === 'matches' || status === 'explained' || status === 'accepted') return 'good';
  if (status === 'differs' || status === 'check_reading') return 'warn';
  return 'muted';
}

/** Minor units without their sign. */
const abs = (minor: string): bigint => {
  const v = BigInt(minor);
  return v < 0n ? -v : v;
};

/**
 * A result in words: "Differs by $412.50" (the largest difference, without its sign), else the state's label. The
 * amount comes back in minor units for the screen to format.
 */
export function resultLabel(result: Pick<TaxFormResultDto, 'state' | 'difference'>): {
  key: string;
  amount: bigint | null;
} {
  if (result.state === 'differs' && result.difference !== null)
    return { key: 'tax_forms.result.differs_by', amount: abs(result.difference) };
  return { key: `tax_forms.result.${result.state}`, amount: null };
}

/** A form's title: a file not read yet by its name; otherwise its kind, and the issuer when known. */
export function titleOf(
  form: Pick<TaxFormDto, 'kind' | 'issuerName' | 'reading'>,
): { fileName: string } | { kindKey: string; issuer: string | null } {
  if (form.reading && !form.reading.kindKnown) return { fileName: form.reading.fileNames[0] ?? '' };
  return { kindKey: `tax_forms.kind.${form.kind}`, issuer: form.issuerName };
}

/** Whether a check can be accepted with a note: a `check` box that differs and isn't accepted yet. */
export const acceptable = (c: Pick<TaxFormCheckDto, 'kind' | 'status'>): boolean =>
  c.kind === 'check' && (c.status === 'differs' || c.status === 'check_reading');

/** A check's difference to show: only a `check` box has one that counts. */
export const shownDifference = (c: Pick<TaxFormCheckDto, 'kind' | 'difference'>): string | null =>
  c.kind === 'check' ? c.difference : null;

/** What a check's drill-down can open on the phone: payslips and transactions (entries stay on the web's Journal). */
export function drillDown(c: Pick<TaxFormCheckDto, 'sources'>): {
  payslipIds: string[];
  transactionIds: string[];
  entries: number;
} {
  return {
    payslipIds: c.sources.payslipIds,
    transactionIds: c.sources.transactionIds,
    entries: c.sources.journalEntryIds.length,
  };
}

// ----- Reading (forms from a file) ----------------------------------------------------------------------------------

/** Where a form from a file stands (the web's `READING_STAGES`, the same `tax_forms.reading_stage.*` words). */
export const READING_STAGES = [
  'reading',
  'waiting',
  'unread',
  'to_confirm',
  'confirmed_by_books',
  'confirmed',
] as const;
export type ReadingStage = (typeof READING_STAGES)[number];

export function readingStage(form: Pick<TaxFormDto, 'reading' | 'status' | 'reason'>): ReadingStage | null {
  const r = form.reading;
  if (!r) return null;
  if (form.status === 'reading') {
    if (r.problem === 'failed') return 'unread';
    return r.problem === 'waiting' ? 'waiting' : 'reading';
  }
  if (form.status === 'confirmed') return r.confirmedBy === 'books' ? 'confirmed_by_books' : 'confirmed';
  if (!r.kindKnown || !r.boxesRead || form.reason === 'unread') return 'unread';
  return 'to_confirm';
}

/** Whether Confirm reading can be pressed: read, in Review, matched, and for a known person (the API's rule). */
export function canConfirmReading(
  form: Pick<TaxFormDto, 'reading' | 'status' | 'reason' | 'boxes' | 'targets' | 'personMemberId'>,
): boolean {
  return (
    form.reading !== null &&
    form.status === 'review' &&
    form.reason !== 'unread' &&
    form.reading.kindKnown &&
    Object.keys(form.boxes).length > 0 &&
    form.targets.length > 0 &&
    form.personMemberId !== null
  );
}

/** Whether to look again soon: a form is still being read. */
export const anyReading = (forms: ReadonlyArray<Pick<TaxFormDto, 'status' | 'reading'>>): boolean =>
  forms.some((f) => f.status === 'reading' && f.reading?.problem !== 'failed');

// ----- The boxes as read --------------------------------------------------------------------------------------------

/** The money boxes per kind, in the order printed on the form (the web editor's `MONEY_BOXES`). */
export const MONEY_BOXES: Record<TaxFormKind, readonly string[]> = {
  w2: ['box1', 'box2', 'box3', 'box4', 'box5', 'box6', 'box7', 'box8', 'box10', 'box11'],
  '1099_int': [
    'box1',
    'box2',
    'box3',
    'box4',
    'box5',
    'box6',
    'box8',
    'box9',
    'box10',
    'box11',
    'box12',
    'box13',
  ],
  '1099_div': [
    'box1a',
    'box1b',
    'box2a',
    'box2b',
    'box2c',
    'box2d',
    'box2e',
    'box2f',
    'box3',
    'box4',
    'box5',
    'box6',
    'box7',
    'box9',
    'box10',
    'box12',
    'box13',
  ],
  '1098': ['box1', 'box2', 'box4', 'box5', 'box6', 'box10'],
};

/**
 * One box as the phone shows it, to compare with the paper: its number as printed (`1`, `12D`), the i18n key of its
 * name, and an amount (minor units) or a date.
 */
export interface BoxLine {
  box: string | null;
  nameKey: string | null;
  amount?: string;
  date?: string;
}

const isMoney = (v: unknown): v is string => typeof v === 'string' && /^\d+$/.test(v);

/**
 * The boxes a form holds, in the form's order, blank ones left out: the money boxes, a W-2's box 12 codes and its first
 * state's wages and tax, a 1098's dates. Editing them is on the web (§7.2).
 */
export function boxLines(form: Pick<TaxFormDto, 'kind' | 'boxes'>): BoxLine[] {
  const boxes = form.boxes as Record<string, unknown>;
  const lines: BoxLine[] = [];
  for (const box of MONEY_BOXES[form.kind]) {
    const v = boxes[box];
    if (isMoney(v))
      lines.push({ box: box.slice(3), nameKey: `tax_forms.box_name.${form.kind}.${box}`, amount: v });
  }
  if (form.kind === 'w2') {
    for (const e of (boxes.box12 ?? []) as Array<{ code: string; amount: string }>)
      lines.push({ box: `12${e.code}`, nameKey: null, amount: e.amount });
    const state = ((boxes.states ?? []) as Array<Record<string, unknown>>)[0];
    for (const b of ['box16', 'box17'] as const) {
      const v = state?.[b];
      if (isMoney(v)) lines.push({ box: null, nameKey: `tax_forms.w2_${b}`, amount: v });
    }
  }
  if (form.kind === '1098') {
    if (typeof boxes.box3 === 'string')
      lines.push({ box: null, nameKey: 'tax_forms.box_1098_box3', date: boxes.box3 });
    if (typeof boxes.box11 === 'string') lines.push({ box: '11', nameKey: null, date: boxes.box11 });
  }
  return lines;
}

type T = (key: string, values?: Record<string, string | number>) => string;

/** A box line's label: "Box 1: Wages, tips, other compensation", "Box 12D", or the name alone. */
export function boxLabel(line: BoxLine, t: T): string {
  if (line.box && line.nameKey) return t('tax_forms.box_label', { box: line.box, name: t(line.nameKey) });
  if (line.box) return t('tax_forms.box_short', { box: line.box });
  return t(line.nameKey ?? '');
}

// ----- The year's list ----------------------------------------------------------------------------------------------

/** Expected forms grouped by the person they're for (household last), each group in the order given. */
export function byPerson(
  expected: readonly TaxFormExpectedDto[],
  names: ReadonlyMap<string, string>,
): { personMemberId: string | null; name: string | null; items: TaxFormExpectedDto[] }[] {
  const groups = new Map<string | null, TaxFormExpectedDto[]>();
  for (const e of expected) groups.set(e.personMemberId, [...(groups.get(e.personMemberId) ?? []), e]);
  return [...groups.entries()]
    .map(([id, items]) => ({ personMemberId: id, name: id ? (names.get(id) ?? null) : null, items }))
    .sort((a, b) => (a.name === null ? 1 : b.name === null ? -1 : a.name.localeCompare(b.name)));
}

/** The forms being read, and those received that match nothing expected (read already). */
export function yearSections(data: Pick<TaxYearDto, 'forms' | 'unexpectedFormIds'>): {
  reading: TaxFormDto[];
  unexpected: TaxFormDto[];
} {
  const byId = new Map(data.forms.map((f) => [f.id, f]));
  return {
    reading: data.forms.filter((f) => f.status === 'reading'),
    unexpected: data.unexpectedFormIds
      .map((id) => byId.get(id))
      .filter((f): f is TaxFormDto => !!f && f.status !== 'reading'),
  };
}

/** The tone of an expected form's state: received is good, not yet needs a look, won't come is quiet. */
export const expectedTone = (state: TaxFormExpectedDto['state']): Tone =>
  state === 'received' ? 'good' : state === 'missing' ? 'warn' : 'muted';

// ----- Changing the match -------------------------------------------------------------------------------------------

/** Accounts a 1099 or 1098 can be matched to (the web editor's rule): a mortgage or loan for a 1098, else not a debt. */
export function matchableAccounts<A extends Pick<AccountDto, 'id' | 'name' | 'kind' | 'archived'>>(
  kind: TaxFormKind,
  accounts: readonly A[],
): A[] {
  return accounts.filter(
    (a) =>
      !a.archived &&
      (kind === '1098'
        ? a.kind === 'mortgage' || a.kind === 'loan'
        : !['credit_card', 'loan', 'mortgage', 'line_of_credit', 'liability'].includes(a.kind)),
  );
}

/** The reading's suggested matches this login may pick: an employer only for those who match W-2s. */
export const pickableCandidates = (
  form: Pick<TaxFormDto, 'reading'>,
  role: MemberRole,
): TaxFormCandidateDto[] =>
  (form.reading?.match.candidates ?? []).filter((c) => (c.employerId ? canMatchEmployer(role) : true));

/**
 * The change to send for a picked match: a W-2 has one employer, and is then for the employer's person (so the person
 * is sent as null, for the server to take the employer's); a 1098 has one account; a 1099 one or more. Null when the
 * pick doesn't fit the kind, or nothing is picked.
 */
export function matchUpdate(
  form: Pick<TaxFormDto, 'kind' | 'version'>,
  pick: { employerId: string } | { accountIds: readonly string[] },
): UpdateTaxFormRequest | null {
  if ('employerId' in pick)
    return form.kind === 'w2'
      ? { targets: [{ employerId: pick.employerId }], personMemberId: null, version: form.version }
      : null;
  if (form.kind === 'w2' || pick.accountIds.length === 0) return null;
  const ids = form.kind === '1098' ? pick.accountIds.slice(0, 1) : [...new Set(pick.accountIds)];
  return { targets: ids.map((accountId) => ({ accountId })), version: form.version };
}

/** The ids a form is matched to now, to show the current pick. */
export const matchedIds = (form: Pick<TaxFormDto, 'targets'>): string[] =>
  form.targets.flatMap((t) => (t.employerId ? [t.employerId] : t.accountId ? [t.accountId] : []));

/** Who it's for is picked by hand, except on a W-2 matched to an employer: that's the employer's person. */
export const personPickable = (form: Pick<TaxFormDto, 'kind' | 'targets'>): boolean =>
  !(form.kind === 'w2' && form.targets.some((t) => t.employerId));

// ----- Scanning a form ----------------------------------------------------------------------------------------------

/**
 * What to upload for the captured pages (§7.2): the photos and scanned pages combined into one PDF, as statements are;
 * a picked PDF as it is. The combined PDF's source is `scan` when the phone made the pages, `upload` for photos picked.
 */
export function scanUploads(pages: readonly CapturedPage[]): {
  images: CapturedPage[];
  pdfs: CapturedPage[];
  imagesSource: 'scan' | 'upload';
} {
  const images = pages.filter((p) => p.type !== 'application/pdf');
  return {
    images,
    pdfs: pages.filter((p) => p.type === 'application/pdf'),
    imagesSource: images.some((p) => p.shot) ? 'scan' : 'upload',
  };
}

/** What became of each file uploaded, in words, and the form to open when there's exactly one. */
export function uploadOutcome(results: ReadonlyArray<TaxFormUploadDto['files'][number]>): {
  lines: Message[];
  openFormId: string | null;
} {
  return {
    lines: results.map((f) =>
      f.status === 'duplicate'
        ? { key: 'tax_forms.upload_duplicate', values: { name: f.fileName } }
        : { key: 'tax_forms.upload_reading', values: { name: f.fileName } },
    ),
    openFormId: results.length === 1 ? results[0]!.formId : null,
  };
}

// ----- The Review badge ---------------------------------------------------------------------------------------------

/** The badge's number: transactions to review (the sync feed's `reviewCount`) plus tax forms to check. */
export const reviewBadge = (transactions: number, taxForms: number | null): number =>
  transactions + (taxForms ?? 0);

/**
 * The count of tax forms to check behind the Review badge (the web's `reviewBadgeTotal` adds the same). Read from
 * `GET tax-forms/review`, at most once a minute when sync runs, at once after an action on a form; a failed read (offline)
 * keeps the last count. One per workspace and login, shared by the tab bar and More.
 */
export class TaxFormsToCheck {
  private value: number | null = null;
  private at = Number.NEGATIVE_INFINITY;
  private inflight: Promise<void> | null = null;
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly minGapMs = 60_000,
    private readonly now: () => number = () => Date.now(),
  ) {}

  get = (): number | null => this.value;

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  /** A fresh count from elsewhere: the Review list, read anyway. */
  set(count: number): void {
    this.at = this.now();
    if (count === this.value) return;
    this.value = count;
    for (const fn of this.listeners) fn();
  }

  /** Reads the count unless it was read within the last minute; `force` after an action that may have changed it. */
  refresh(read: () => Promise<number>, force = false): Promise<void> {
    if (this.inflight) return this.inflight;
    if (!force && this.now() - this.at < this.minGapMs) return Promise.resolve();
    this.at = this.now();
    this.inflight = read()
      .then(
        (n) => this.set(n),
        () => undefined,
      )
      .finally(() => {
        this.inflight = null;
      });
    return this.inflight;
  }
}

const counters = new Map<string, TaxFormsToCheck>();

/** The shared counter for a login in a workspace. */
export function taxFormsToCheckFor(key: string): TaxFormsToCheck {
  let c = counters.get(key);
  if (!c) counters.set(key, (c = new TaxFormsToCheck()));
  return c;
}
