/**
 * Moving an account to other books (ADR-0033). One transaction's postings, as booked, re-booked with the account in
 * its new entity: the same lines, amounts and tags, settled again between entities through the inter-entity accounts
 * (DE-05). Nothing is rebuilt from the transaction's spec, so it works the same for lines an owner (a payslip, an
 * invoice, rent) posted with its own builder.
 */
import type { CalendarDate } from '../calendar-date.js';
import type { CurrencyCode } from '../currency.js';
import type { AccountResolver } from './builder.js';
import type { JournalEntryDraft, JournalKind, PostingDraft, SystemRole } from './types.js';
import { validateEntry } from './validate.js';

/** Lines that only settle one entity against another: dropped and settled again. */
const SETTLING: ReadonlySet<SystemRole> = new Set([
  'inter_entity_clearing',
  'due_to_entity',
  'due_from_entity',
]);
/** The other side of `inter_entity_clearing` when Personal pays for a business or receives its money (equity mode). */
const OWNER_SIDE: ReadonlySet<SystemRole> = new Set(['owner_contribution', 'owner_draw']);
/**
 * In a transaction whose main account moves, the old books' lines in these accounts belong to that account and go
 * with it: what the account's own money was, not what it was spent on.
 */
export const FOLLOWING_ROLES: ReadonlySet<SystemRole> = new Set([
  'uncategorized_income',
  'uncategorized_expense',
  'bank_fees',
  'fx_gain_loss',
  'fx_rounding',
]);
/** In an entry without a transaction (opening balance, adjustment, valuation), these map to the new books' own. */
export const STANDALONE_ROLES: ReadonlySet<SystemRole> = new Set([
  ...FOLLOWING_ROLES,
  'opening_balance_equity',
  'investment_gains',
]);

export interface RebookLine extends PostingDraft {
  /** The account's system role, if it has one. */
  readonly role: SystemRole | null;
  /** For inter-entity accounts: the entity on the other side. */
  readonly counterpartyEntityId: string | null;
}

export interface RebookEntity {
  readonly entityId: string;
  readonly functionalCurrency: CurrencyCode;
  readonly entryDate: CalendarDate;
  readonly kind: JournalKind;
  readonly description: string;
  readonly restricted?: boolean;
  readonly restrictedMemberId?: string | null;
  /** The entity's net postings for the transaction (adjustments and reversals collapsed). */
  readonly lines: readonly RebookLine[];
}

export interface RebookInput {
  readonly bookings: readonly RebookEntity[];
  readonly accountId: string;
  readonly fromEntityId: string;
  readonly toEntityId: string;
  /** The entity whose account pays or receives (the transaction's main account), after the move. */
  readonly hubEntityId: string;
  /** True when the moving account is the transaction's main account: its system lines follow it. */
  readonly follows: boolean;
}

type Line = Omit<PostingDraft, 'lineNo'> & { entityId: string };

const key = (l: Line) =>
  [l.entityId, l.accountId, l.memberId, l.propertyId, l.unitId, l.memo, l.fxRate].join('|');

function merge(lines: readonly Line[]): Line[] {
  const out = new Map<string, Line>();
  for (const l of lines) {
    const prev = out.get(key(l));
    out.set(
      key(l),
      prev
        ? {
            ...prev,
            amount: prev.amount + l.amount,
            functionalAmount: prev.functionalAmount + l.functionalAmount,
          }
        : l,
    );
  }
  return [...out.values()].filter((l) => l.amount !== 0n || l.functionalAmount !== 0n);
}

/**
 * The transaction's entries with `accountId` in `toEntityId`'s books. Each entity keeps its date, kind, description and
 * restriction; the new books' entry takes the old books'. Entities left with nothing get no entry.
 */
export function rebookTransaction(input: RebookInput, resolver: AccountResolver): JournalEntryDraft[] {
  const { accountId, fromEntityId: from, toEntityId: to, hubEntityId: hub } = input;
  const lines: Line[] = [];
  for (const b of input.bookings) {
    for (const p of b.lines) {
      const { role, counterpartyEntityId, lineNo: _lineNo, ...rest } = p;
      if (role && SETTLING.has(role)) {
        // Equity mode: Personal's clearing line has an owner contribution or draw as its other side. Cancel it too.
        if (role === 'inter_entity_clearing' && counterpartyEntityId) {
          const owner = resolver.systemAccount(
            counterpartyEntityId,
            p.functionalAmount > 0n ? 'owner_contribution' : 'owner_draw',
          );
          lines.push({
            accountId: owner.id,
            accountEntityId: owner.entityId,
            currency: owner.currency,
            amount: p.functionalAmount,
            functionalAmount: p.functionalAmount,
            fxRate: null,
            memberId: null,
            propertyId: null,
            unitId: null,
            memo: p.memo ?? null,
            entityId: counterpartyEntityId,
          });
        }
        continue;
      }
      if (p.accountId === accountId) {
        lines.push({ ...rest, accountEntityId: to, entityId: to });
      } else if (input.follows && b.entityId === from && role && FOLLOWING_ROLES.has(role)) {
        const mapped = resolver.systemAccount(to, role);
        lines.push({ ...rest, accountId: mapped.id, accountEntityId: to, entityId: to });
      } else {
        lines.push({ ...rest, entityId: b.entityId });
      }
    }
  }

  // Settle each entity's difference against the paying entity, as the builders do (DE-05).
  let merged = merge(lines);
  const totals = new Map<string, bigint>();
  for (const l of merged) totals.set(l.entityId, (totals.get(l.entityId) ?? 0n) + l.functionalAmount);
  for (const [entityId, b] of totals) {
    if (entityId === hub || b === 0n) continue;
    const pair = resolver.interEntity(hub, entityId, b > 0n ? 'out' : 'in');
    const settle = (acc: typeof pair.local, entity: string, amount: bigint): Line => ({
      accountId: acc.id,
      accountEntityId: acc.entityId,
      currency: acc.currency,
      amount,
      functionalAmount: amount,
      fxRate: null,
      memberId: null,
      propertyId: null,
      unitId: null,
      memo: null,
      entityId: entity,
    });
    merged.push(settle(pair.local, hub, b), settle(pair.remote, entityId, -b));
  }
  merged = merge(merged);

  const meta = new Map(input.bookings.map((b) => [b.entityId, b]));
  const order = [hub, ...new Set(merged.map((l) => l.entityId))].filter((e, i, a) => a.indexOf(e) === i);
  const drafts: JournalEntryDraft[] = [];
  for (const entityId of order) {
    const own = merged.filter((l) => l.entityId === entityId);
    if (own.length === 0) continue;
    const m = meta.get(entityId);
    const source = m ?? meta.get(from) ?? input.bookings[0]!;
    const entity = resolver.entity(entityId);
    const draft: JournalEntryDraft = {
      entityId,
      functionalCurrency: entity.functionalCurrency,
      entryDate: source.entryDate,
      kind: source.kind,
      description: source.description,
      // A restricted entry (a payslip's) stays so in its own books; lines arriving in other books aren't.
      ...(m?.restricted ? { restricted: true, restrictedMemberId: m.restrictedMemberId ?? null } : {}),
      postings: own.map(({ entityId: _e, ...l }, i) => ({ ...l, lineNo: i + 1 })),
    };
    validateEntry(draft);
    drafts.push(draft);
  }
  return drafts;
}

/**
 * An entry without a transaction (opening balance, balance adjustment, valuation, revaluation) moved whole: the
 * account's lines, and the old books' system lines mapped to the new books' same role. Null when a line can't move
 * (a category or another account of the old books): the user's own journal, which they change first.
 */
export function rebookStandalone(
  entry: RebookEntity,
  accountId: string,
  toEntityId: string,
  resolver: AccountResolver,
): JournalEntryDraft | null {
  const postings: PostingDraft[] = [];
  for (const p of entry.lines) {
    const { role, counterpartyEntityId: _cp, ...rest } = p;
    if (p.accountId === accountId) postings.push({ ...rest, accountEntityId: toEntityId });
    else if (role && STANDALONE_ROLES.has(role)) {
      const mapped = resolver.systemAccount(toEntityId, role);
      postings.push({ ...rest, accountId: mapped.id, accountEntityId: toEntityId });
    } else return null;
  }
  const entity = resolver.entity(toEntityId);
  const draft: JournalEntryDraft = {
    entityId: toEntityId,
    functionalCurrency: entity.functionalCurrency,
    entryDate: entry.entryDate,
    kind: entry.kind,
    description: entry.description,
    postings: postings.map((p, i) => ({ ...p, lineNo: i + 1 })),
  };
  validateEntry(draft);
  return draft;
}
