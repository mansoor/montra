/**
 * An account's holders (ACC-15) and its full number (ACC-16; ADR-0057 §5, §6): the shaping the API contract, the web and
 * the phone share. The API decides the rest (the ACCOUNT_MAX_HOLDERS limit, members in the household, who may change
 * the number).
 */

/** A holder as the API returns it. */
export interface AccountHolder {
  name: string;
  memberId: string | null;
}

/** One row of a holders form: a name, and a family member's id or '' for none. */
export interface HolderDraft {
  name: string;
  memberId: string;
}

export const holderDrafts = (holders: readonly AccountHolder[]): HolderDraft[] =>
  holders.map((h) => ({ name: h.name, memberId: h.memberId ?? '' }));

/**
 * What a form sends: rows in order, trimmed, blank rows dropped. A row with a member and no name is sent without one, so
 * the API fills in the member's name.
 */
export function holdersToSave(drafts: readonly HolderDraft[]): { name?: string; memberId: string | null }[] {
  return drafts
    .map((d) => ({ name: d.name.trim(), memberId: d.memberId || null }))
    .filter((d) => d.name || d.memberId)
    .map((d) => (d.name ? d : { memberId: d.memberId }));
}

/** True when a form says something other than what's saved. */
export const holdersChanged = (saved: readonly AccountHolder[], drafts: readonly HolderDraft[]): boolean =>
  JSON.stringify(holdersToSave(holderDrafts(saved))) !== JSON.stringify(holdersToSave(drafts));

/** "Ada and Ben", "A, B and C"; '' for none. `and` is the translated word. */
export function holdersLine(holders: readonly Pick<AccountHolder, 'name'>[], and: string): string {
  const names = holders.map((h) => h.name);
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} ${and} ${names[names.length - 1]}`;
}

/** A full account number once spaces and dashes are dropped and letters upper-cased: 4 to 34, ending in 4 digits. */
export const ACCOUNT_NUMBER_PATTERN = /^[A-Z0-9]{0,30}[0-9]{4}$/;

export const normalizeAccountNumber = (raw: string): string => raw.replace(/[\s-]/g, '').toUpperCase();

/** A typed number as the API takes it, or null when it isn't one. */
export function accountNumberInput(raw: string): string | null {
  const v = normalizeAccountNumber(raw);
  return ACCOUNT_NUMBER_PATTERN.test(v) ? v : null;
}
