/**
 * Deterministic stand-in provider for tests, end-to-end runs and the evaluation self-check
 * (`AI_PROVIDER=fake`). It reads the same requests the real adapters get and answers every task with simple
 * keyword logic — no network, no randomness.
 */
import { DATE_FORMATS, detectDateFormat, displayName, normalizeDescription } from '@montra/importers';
import type { CompletionRequest, CompletionResponse, ProviderAdapter } from '../types.js';

/** keyword (in payee/description) → category name fragments it points to. */
export const FAKE_SYNONYMS: ReadonlyArray<readonly [readonly string[], readonly string[]]> = [
  [
    ['coffee', 'starbucks', 'blue bottle', 'peets', 'dunkin', 'cafe'],
    ['coffee', 'dining', 'restaurant', 'eating out'],
  ],
  [
    [
      'restaurant',
      'grill',
      'pizza',
      'sushi',
      'taco',
      'chipotle',
      'mcdonald',
      'doordash',
      'grubhub',
      'ubereats',
      'uber eats',
    ],
    ['dining', 'restaurant', 'eating out', 'meals'],
  ],
  [
    ['shell', 'chevron', 'exxon', 'bp ', 'mobil', 'arco', 'fuel', 'gas station', 'valero', 'sunoco'],
    ['fuel', 'gas', 'auto'],
  ],
  [
    ['netflix', 'spotify', 'hulu', 'disney', 'hbo', 'youtube premium', 'apple music'],
    ['subscription', 'streaming', 'entertainment'],
  ],
  [
    ['uber', 'lyft', 'taxi', 'cab '],
    ['rideshare', 'transport', 'travel'],
  ],
  [
    [
      'kroger',
      'whole foods',
      'safeway',
      'trader joe',
      'aldi',
      'publix',
      'grocery',
      'costco',
      'wegmans',
      'heb ',
    ],
    ['groceries', 'grocery', 'food'],
  ],
  [
    ['rent', 'property management', 'apartments'],
    ['rent', 'housing'],
  ],
  [
    ['payroll', 'salary', 'direct dep', 'paycheck'],
    ['salary', 'income', 'wages', 'paycheck'],
  ],
  [
    [
      'airline',
      'delta',
      'united air',
      'american air',
      'southwest',
      'jetblue',
      'hotel',
      'marriott',
      'hilton',
      'airbnb',
      'expedia',
    ],
    ['travel'],
  ],
  [
    ['comcast', 'xfinity', 'verizon', 'at&t', 't-mobile', 'spectrum', 'internet'],
    ['internet', 'phone', 'utilities'],
  ],
  [
    ['pg&e', 'electric', 'water', 'utility', 'con ed', 'duke energy'],
    ['utilities', 'electric'],
  ],
  [
    ['amazon', 'target', 'walmart', 'best buy', 'ebay'],
    ['shopping', 'household', 'general'],
  ],
  [
    ['cvs', 'walgreens', 'pharmacy', 'rite aid'],
    ['pharmacy', 'health', 'medical'],
  ],
  [
    ['gym', 'fitness', 'planet fitness', 'equinox', 'peloton'],
    ['fitness', 'gym', 'health'],
  ],
  [['insurance', 'geico', 'state farm', 'allstate', 'progressive'], ['insurance']],
  [
    ['home depot', 'lowes', "lowe's", 'hardware', 'plumbing', 'repair'],
    ['repairs', 'maintenance', 'home improvement'],
  ],
  [
    ['adobe', 'github', 'aws', 'google workspace', 'slack', 'zoom', 'dropbox', 'notion'],
    ['software', 'subscriptions', 'office'],
  ],
  [
    ['staples', 'office depot', 'office'],
    ['office', 'supplies'],
  ],
  [
    ['tuition', 'university', 'college', 'bookstore', 'school'],
    ['education', 'tuition', 'school'],
  ],
  [
    ['parking', 'toll', 'parkmobile'],
    ['parking', 'transport', 'auto'],
  ],
  [['interest'], ['interest']],
  [
    ['fee', 'service charge', 'overdraft'],
    ['fees', 'bank'],
  ],
];

type Json = Record<string, unknown>;

function usageFor(req: CompletionRequest, out: string) {
  return {
    inputTokens: Math.ceil((req.system.length + (req.context?.length ?? 0) + req.input.length) / 4),
    outputTokens: Math.ceil(out.length / 4),
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };
}

function parse(text: string | undefined): Json {
  if (!text) return {};
  try {
    return JSON.parse(text) as Json;
  } catch {
    return {};
  }
}

interface FakeCategory {
  id: string;
  name: string;
  kind?: string;
}

/** Best category for a text by synonyms (strong) or shared words (weak). */
export function fakeMatch(text: string, categories: readonly FakeCategory[], amountSign = -1) {
  const t = ` ${text.toLowerCase()} `;
  const preferKind = amountSign > 0 ? 'income' : 'expense';
  const ordered = [...categories].sort(
    (a, b) => Number(b.kind === preferKind) - Number(a.kind === preferKind),
  );
  for (const [keywords, names] of FAKE_SYNONYMS) {
    if (!keywords.some((k) => t.includes(k))) continue;
    for (const n of names) {
      const hit = ordered.find((c) => c.name.toLowerCase().includes(n));
      if (hit) return { category: hit, confidence: 0.9, keyword: keywords.find((k) => t.includes(k))! };
    }
  }
  const words = new Set(t.split(/[^a-z]+/).filter((w) => w.length >= 4));
  for (const c of ordered) {
    const cw = c.name
      .toLowerCase()
      .split(/[^a-z]+/)
      .filter((w) => w.length >= 4);
    const shared = cw.find((w) => words.has(w) || words.has(w.replace(/s$/, '')));
    if (shared) return { category: c, confidence: 0.55, keyword: shared };
  }
  return null;
}

export class FakeAdapter implements ProviderAdapter {
  readonly id = 'fake' as const;
  /** Every request seen, for assertions in tests. */
  readonly calls: CompletionRequest[] = [];

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    this.calls.push(req);
    const json = this.answer(req);
    const out = JSON.stringify(json);
    return { ok: true, json, usage: usageFor(req, out), model: req.model };
  }

  private answer(req: CompletionRequest): unknown {
    const input = parse(req.input);
    const context = parse(req.context);
    switch (req.task) {
      case 'categorize':
        return fakeCategorize(input, context);
      case 'normalize_payees':
        return {
          results: ((input.items as Json[] | undefined) ?? []).map((i) => ({
            id: i.id,
            name: displayName(normalizeDescription(String(i.raw ?? ''))) || String(i.raw ?? ''),
            kind: 'merchant',
            mcc: null,
            confidence: 0.8,
          })),
        };
      case 'map_columns':
        return fakeMapColumns(input);
      case 'parse_quick_add':
        return fakeQuickAdd(input);
      case 'extract_statement_table':
        return fakeExtract(input);
      case 'propose_categories':
        return fakePropose(input);
      case 'ping':
        return { ok: true };
    }
  }
}

function fakeCategorize(input: Json, context: Json) {
  const categories = (context.categories as FakeCategory[] | undefined) ?? [];
  const items = (input.items as Json[] | undefined) ?? [];
  return {
    results: items.map((i) => {
      const text = `${String(i.payee ?? '')} ${String(i.description ?? '')}`;
      const sign = String(i.amount ?? '').startsWith('-') ? -1 : 1;
      const m = fakeMatch(text, categories, sign);
      return {
        id: i.id,
        category: m?.category.id ?? null,
        member: null,
        tags: [],
        confidence: m?.confidence ?? 0.3,
        reason: m ? `'${m.keyword}' suggests ${m.category.name}` : 'Unrecognized payee',
        merchant:
          m && m.confidence >= 0.9 ? { name: displayName(normalizeDescription(text)), mcc: null } : null,
      };
    }),
  };
}

const HEADER_WORDS: Record<string, RegExp> = {
  date: /^(transaction |posting |post |trans\.? )?date$|^datum$|^buchungstag$/i,
  description: /description|details|memo|narrative|verwendungszweck|name/i,
  amount: /^amount|betrag/i,
  debit: /debit|withdrawal|money out|paid out/i,
  credit: /credit|deposit|money in|paid in/i,
  balance: /balance|saldo/i,
  category: /category/i,
  payee: /payee|merchant/i,
};

function fakeMapColumns(input: Json) {
  const rows = (input.rows as string[][] | undefined) ?? [];
  let headerRow: number | null = null;
  const cols: Record<string, number> = {};
  for (let r = 0; r < Math.min(rows.length, 10); r++) {
    const found: Record<string, number> = {};
    rows[r]!.forEach((cell, c) => {
      for (const [key, re] of Object.entries(HEADER_WORDS))
        if (found[key] === undefined && re.test(cell.trim())) found[key] = c;
    });
    if (found.date !== undefined && (found.amount !== undefined || found.debit !== undefined)) {
      headerRow = r;
      Object.assign(cols, found);
      break;
    }
  }
  const dataStart = headerRow === null ? 0 : headerRow + 1;
  const dateCol = cols.date ?? 0;
  const dates = rows.slice(dataStart).map((r) => r[dateCol] ?? '');
  const fmt = detectDateFormat(dates)?.format ?? DATE_FORMATS[0];
  const split = cols.amount === undefined && cols.debit !== undefined && cols.credit !== undefined;
  const ok = headerRow !== null;
  return {
    headerRow,
    dataStart,
    date: dateCol,
    dateFormat: fmt,
    description: [cols.description ?? 1],
    payee: cols.payee ?? null,
    amount: split ? null : (cols.amount ?? 2),
    debit: split ? cols.debit! : null,
    credit: split ? cols.credit! : null,
    direction: null,
    sign: input.accountType === 'liability' && !split ? 'inverted' : 'normal',
    balance: cols.balance ?? null,
    category: cols.category ?? null,
    reference: null,
    decimal: '.',
    confidence: ok ? 0.85 : 0.3,
  };
}

const WEEKDAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

function shiftDate(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function fakeQuickAdd(input: Json) {
  const today = String(input.today ?? '1970-01-01');
  const note = String(input.note ?? '');
  const accounts = (input.accounts as { id: string; label: string; kind: string }[] | undefined) ?? [];
  const categories = (input.categories as FakeCategory[] | undefined) ?? [];
  const members = (input.members as { id: string; token: string }[] | undefined) ?? [];
  let rest = ` ${note} `;
  const take = (re: RegExp): RegExpExecArray | null => {
    const m = re.exec(rest);
    if (m) rest = rest.replace(m[0], ' ');
    return m;
  };
  const amountM = take(/\s\$?(\d+(?:[.,]\d{1,2})?)(?=\s)/);
  let date: string | null = null;
  if (take(/\syesterday(?=\s)/i)) date = shiftDate(today, -1);
  else if (take(/\stoday(?=\s)/i)) date = today;
  else {
    const wd = take(new RegExp(`\\s(${WEEKDAY_NAMES.join('|')})(?=\\s)`, 'i'));
    if (wd) {
      const target = WEEKDAY_NAMES.indexOf(wd[1]!.toLowerCase());
      const cur = new Date(`${today}T00:00:00Z`).getUTCDay();
      date = shiftDate(today, -((cur - target + 7) % 7 || 7));
    }
  }
  const lower = rest.toLowerCase();
  const account = accounts.find(
    (a) => lower.includes(` ${a.label.toLowerCase()} `) || lower.includes(` ${a.kind.toLowerCase()} `),
  );
  if (account) rest = rest.replace(new RegExp(`\\s(${account.label}|${account.kind})(?=\\s)`, 'i'), ' ');
  const member = members.find((m) => rest.includes(m.token));
  if (member) rest = rest.replace(member.token, ' ');
  const tags = [...rest.matchAll(/#(\w+)/g)].map((m) => m[1]!.toLowerCase());
  rest = rest.replace(/#\w+/g, ' ');
  const words = rest.trim().split(/\s+/).filter(Boolean);
  const direction = /\b(refund|salary|received|got paid|paycheck)\b/i.test(note) ? 'in' : 'out';
  const cat = fakeMatch(note, categories, direction === 'in' ? 1 : -1);
  const payee = words[0] ? words[0][0]!.toUpperCase() + words[0].slice(1) : null;
  return {
    date,
    amount: amountM ? amountM[1]!.replace(',', '.') : null,
    direction,
    payee,
    account: account?.id ?? null,
    category: cat?.category.id ?? null,
    member: member?.id ?? null,
    memo: words.slice(1).join(' ') || null,
    tags,
    confidence: amountM ? 0.7 : 0.4,
  };
}

const LINE =
  /^\s*(\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{4})\s+(.+?)\s+(-?\$?[\d,]+\.\d{2})(?:\s+(-?\$?[\d,]+\.\d{2}))?\s*$/;

function toIso(d: string): string {
  if (/^\d{4}-/.test(d)) return d;
  const [m, day, y] = d.split('/');
  return `${y}-${m!.padStart(2, '0')}-${day!.padStart(2, '0')}`;
}

const num = (s: string) => s.replace(/[$,]/g, '');

function fakeExtract(input: Json) {
  const pages = (input.pages as string[] | undefined) ?? [];
  const rows: { date: string; description: string; amount: string; balance: string | null }[] = [];
  let opening: string | null = null;
  let closing: string | null = null;
  for (const page of pages) {
    for (const line of page.split('\n')) {
      const bal = /(opening|previous|beginning|closing|new|ending) balance\D*(-?\$?[\d,]+\.\d{2})/i.exec(
        line,
      );
      if (bal) {
        if (/opening|previous|beginning/i.test(bal[1]!)) opening ??= num(bal[2]!);
        else closing = num(bal[2]!);
        continue;
      }
      const m = LINE.exec(line);
      if (m)
        rows.push({
          date: toIso(m[1]!),
          description: m[2]!.trim(),
          amount: num(m[3]!),
          balance: m[4] ? num(m[4]) : null,
        });
    }
  }
  return { rows, opening, closing, periodStart: rows[0]?.date ?? null, periodEnd: rows.at(-1)?.date ?? null };
}

const PROPOSALS: Record<string, { name: string; group: string; kind: 'income' | 'expense' }> = {
  coffee: { name: 'Dining out', group: 'Daily', kind: 'expense' },
  dining: { name: 'Dining out', group: 'Daily', kind: 'expense' },
  fuel: { name: 'Fuel', group: 'Daily', kind: 'expense' },
  subscription: { name: 'Subscriptions', group: 'Fixed', kind: 'expense' },
  rideshare: { name: 'Transport', group: 'Daily', kind: 'expense' },
  groceries: { name: 'Groceries', group: 'Daily', kind: 'expense' },
  rent: { name: 'Rent', group: 'Fixed', kind: 'expense' },
  salary: { name: 'Salary', group: 'Income', kind: 'income' },
  travel: { name: 'Travel', group: 'Fun', kind: 'expense' },
  internet: { name: 'Internet & phone', group: 'Fixed', kind: 'expense' },
  utilities: { name: 'Utilities', group: 'Fixed', kind: 'expense' },
  shopping: { name: 'Shopping', group: 'Daily', kind: 'expense' },
  pharmacy: { name: 'Health', group: 'Daily', kind: 'expense' },
  fitness: { name: 'Fitness', group: 'Fun', kind: 'expense' },
  insurance: { name: 'Insurance', group: 'Fixed', kind: 'expense' },
  repairs: { name: 'Home repairs', group: 'Fixed', kind: 'expense' },
  software: { name: 'Software', group: 'Business', kind: 'expense' },
  office: { name: 'Office supplies', group: 'Business', kind: 'expense' },
  education: { name: 'Education', group: 'Fixed', kind: 'expense' },
  parking: { name: 'Parking & tolls', group: 'Daily', kind: 'expense' },
  interest: { name: 'Interest', group: 'Income', kind: 'income' },
  fees: { name: 'Bank fees', group: 'Fixed', kind: 'expense' },
};

function fakePropose(input: Json) {
  const existing = new Set(((input.existing as string[] | undefined) ?? []).map((e) => e.toLowerCase()));
  const payees = (input.payees as { id: string; payee: string }[] | undefined) ?? [];
  const cats = new Map<string, { name: string; group: string; kind: 'income' | 'expense' }>();
  const assignments: { payee: string; category: string }[] = [];
  for (const p of payees) {
    const t = ` ${p.payee.toLowerCase()} `;
    const syn = FAKE_SYNONYMS.find(([keywords]) => keywords.some((k) => t.includes(k)));
    const proposal = syn ? PROPOSALS[syn[1][0]!] : undefined;
    if (!proposal) continue;
    if (!existing.has(proposal.name.toLowerCase())) cats.set(proposal.name, proposal);
    assignments.push({ payee: p.id, category: proposal.name });
  }
  return { categories: [...cats.values()], assignments };
}
