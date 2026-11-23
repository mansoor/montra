/**
 * Rental property and unit for a line (AI-02). The same order as categories: rules, then the payee's learned history,
 * then what the text says (an address or a unit), then AI. Matching here is in code and stays conservative: a text
 * that could name two properties, or two units, names none.
 */
import type { PropertyHistoryEntry, PropertyOption, UnitOption } from './types.js';

export interface PropertyHint {
  propertyId: string;
  unitId: string | null;
  confidence: number;
  explanation: string;
}

/** A street address found in the text: "12 Elm St" and "12 ELM STREET" read the same. */
export const ADDRESS_CONFIDENCE = 0.9;
/** The property's own name, as a phrase in the text ("Lakeside duplex"). */
export const NAME_CONFIDENCE = 0.85;
/** Only a unit, unique across the books' properties ("APT 2B"). */
export const UNIT_ONLY_CONFIDENCE = 0.8;

const SUFFIX: Record<string, string> = {
  street: 'st',
  avenue: 'ave',
  av: 'ave',
  road: 'rd',
  drive: 'dr',
  lane: 'ln',
  boulevard: 'blvd',
  court: 'ct',
  place: 'pl',
  parkway: 'pkwy',
  highway: 'hwy',
  terrace: 'ter',
  circle: 'cir',
};
const DIRECTION: Record<string, string> = {
  north: 'n',
  south: 's',
  east: 'e',
  west: 'w',
  n: 'n',
  s: 's',
  e: 'e',
  w: 'w',
};
/** Words that come before a unit's number: "Unit 2B", "Apt 3", "Suite 100", "#4". */
const UNIT_PREFIX = new Set([
  'unit',
  'apt',
  'apartment',
  'suite',
  'ste',
  'no',
  'number',
  '#',
  'flat',
  'rm',
  'room',
]);

/** Lower case, punctuation to spaces ("#" kept as its own word), abbreviations folded. */
export function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/#/g, ' # ')
    .replace(/[^a-z0-9#]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
    .map((t) => SUFFIX[t] ?? t);
}

/** The house number and the street's first word, from the address's first line: "12 N Elm Street, …" → 12, elm. */
export function addressKey(address: string | null | undefined): { number: string; street: string } | null {
  if (!address) return null;
  const t = tokens(address.split(/[,\n]/)[0] ?? '');
  const number = t[0];
  if (!number || !/^\d{1,6}[a-z]?$/.test(number)) return null;
  let i = 1;
  if (t[i] && DIRECTION[t[i]!] && t[i + 1]) i++;
  const street = t[i];
  if (!street || /^\d+$/.test(street) || UNIT_PREFIX.has(street)) return null;
  return { number, street };
}

function hasAddress(text: readonly string[], key: { number: string; street: string }): boolean {
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== key.number) continue;
    let j = i + 1;
    if (text[j] && DIRECTION[text[j]!]) j++;
    if (text[j] === key.street) return true;
  }
  return false;
}

function hasPhrase(text: readonly string[], phrase: readonly string[]): boolean {
  if (phrase.length === 0) return false;
  outer: for (let i = 0; i + phrase.length <= text.length; i++) {
    for (let k = 0; k < phrase.length; k++) if (text[i + k] !== phrase[k]) continue outer;
    return true;
  }
  return false;
}

/**
 * A unit's label without its prefix ("Unit 2B" → ["2b"]). A label with no prefix and a word in it ("Upstairs",
 * "Garden flat") can also stand on its own in the text; a bare number or letter can't, because "2" is everywhere.
 */
function unitCore(label: string): { core: string[]; standalone: boolean } {
  const t = tokens(label);
  let i = 0;
  while (i < t.length && UNIT_PREFIX.has(t[i]!)) i++;
  const core = t.slice(i);
  const standalone = i === 0 && core.join(' ').replace(/[^a-z]/g, '').length >= 4;
  return { core, standalone };
}

/** Whether the text names this unit: "UNIT 2B", "APT 2B", "#2B", or the label itself when it is a word. */
export function namesUnit(text: readonly string[], label: string): boolean {
  const { core, standalone } = unitCore(label);
  if (core.length === 0) return false;
  if (standalone && hasPhrase(text, core)) return true;
  for (let i = 0; i + core.length < text.length; i++) {
    if (!UNIT_PREFIX.has(text[i]!)) continue;
    // "APT # 2B" and "UNIT NO 2B": one more prefix word may follow.
    const at = UNIT_PREFIX.has(text[i + 1]!) && text[i + 1] !== core[0] ? i + 2 : i + 1;
    if (core.every((c, k) => text[at + k] === c)) return true;
  }
  return false;
}

/** The one unit of a property the text names, or null when none or more than one. */
export function unitFromText(text: string, units: readonly UnitOption[]): UnitOption | null {
  const t = tokens(text);
  const hits = units.filter((u) => namesUnit(t, u.label));
  return hits.length === 1 ? hits[0]! : null;
}

const label = (p: PropertyOption, u: UnitOption | null) => (u ? `${p.name}, ${u.label}` : p.name);

/**
 * Step 3: an address or a unit in the text. The property's address (or a name that is an address) wins over its
 * name as a phrase; a unit on its own counts only when it is in one property. Two properties named: nothing.
 */
export function propertyFromText(text: string, properties: readonly PropertyOption[]): PropertyHint | null {
  const t = tokens(text);
  const byAddress = properties.filter((p) => {
    const keys = [addressKey(p.address), addressKey(p.name)].filter((k) => k !== null);
    return keys.some((k) => hasAddress(t, k));
  });
  const byName = properties.filter((p) => {
    const name = tokens(p.name);
    return name.join('').length >= 4 && hasPhrase(t, name);
  });
  const named = byAddress.length > 0 ? byAddress : byName;
  if (named.length > 1) return null;
  if (named.length === 1) {
    const p = named[0]!;
    const u = unitFromText(text, p.units);
    return {
      propertyId: p.id,
      unitId: u?.id ?? null,
      confidence: byAddress.length ? ADDRESS_CONFIDENCE : NAME_CONFIDENCE,
      explanation: `The text names ${label(p, u)}`,
    };
  }
  const units = properties.flatMap((p) =>
    p.units.filter((u) => namesUnit(t, u.label)).map((u) => ({ p, u })),
  );
  if (units.length !== 1) return null;
  const { p, u } = units[0]!;
  return {
    propertyId: p.id,
    unitId: u.id,
    confidence: UNIT_ONLY_CONFIDENCE,
    explanation: `The text names ${label(p, u)}`,
  };
}

/**
 * Step 2: the property most of the payee's lines went to (a share of at least 0.8 and at least 2 lines), and its unit
 * when most of those lines had the same one. Only properties still on offer count.
 */
export function propertyHistorySuggestion(
  entries: readonly PropertyHistoryEntry[],
  properties: readonly PropertyOption[],
): PropertyHint | null {
  const byId = new Map(properties.map((p) => [p.id, p]));
  const usable = entries.filter((e) => e.count > 0 && byId.has(e.propertyId));
  const total = usable.reduce((n, e) => n + e.count, 0);
  if (total === 0) return null;
  const byProperty = new Map<string, number>();
  for (const e of usable) byProperty.set(e.propertyId, (byProperty.get(e.propertyId) ?? 0) + e.count);
  let best: string | null = null;
  let bestCount = 0;
  for (const [id, n] of byProperty)
    if (n > bestCount) {
      best = id;
      bestCount = n;
    }
  const share = bestCount / total;
  if (!best || share < 0.8 || bestCount < 2) return null;
  const p = byId.get(best)!;
  let unit: UnitOption | null = null;
  for (const e of usable)
    if (e.propertyId === best && e.unitId && e.count / bestCount >= 0.8)
      unit = p.units.find((u) => u.id === e.unitId) ?? null;
  return {
    propertyId: best,
    unitId: unit?.id ?? null,
    confidence: Math.min(0.97, share * Math.min(1, bestCount / 5)),
    explanation: `Like ${bestCount} past transaction${bestCount === 1 ? '' : 's'} at ${label(p, unit)}`,
  };
}
