import { describe, expect, it } from 'vitest';
import {
  buildOpeningBalanceEntry,
  buildTransactionEntries,
  buildTransferEntries,
  calendarDate,
  rebookStandalone,
  rebookTransaction,
  type AccountResolver,
  type AccountType,
  type EntityRef,
  type JournalEntryDraft,
  type LedgerAccountRef,
  type RebookEntity,
  type SystemRole,
} from '../src/index.js';

// Moving an account to other books (ADR-0033).
const D = calendarDate('2026-10-29');
const P: EntityRef = { id: 'P', type: 'personal', functionalCurrency: 'USD' };
const B: EntityRef = { id: 'B', type: 'business', functionalCurrency: 'USD' };
const C: EntityRef = { id: 'C', type: 'business', functionalCurrency: 'USD' };
const entities = new Map([P, B, C].map((e) => [e.id, e]));

const acct = (id: string, entityId: string, type: AccountType): LedgerAccountRef => ({
  id,
  entityId,
  type,
  currency: 'USD',
});
const sys = (entityId: string, role: SystemRole, cp?: string): LedgerAccountRef => ({
  id: cp ? `${entityId}:${role}:${cp}` : `${entityId}:${role}`,
  entityId,
  type: role.startsWith('uncategorized_expense') || role === 'bank_fees' ? 'expense' : 'equity',
  currency: 'USD',
  systemRole: role,
});

/** Equity mode between Personal and a business (clearing on Personal, owner draw or contribution on the business). */
const resolver: AccountResolver = {
  entity: (id) => entities.get(id)!,
  systemAccount: (entityId, role) => sys(entityId, role),
  interEntity: (local, remote, flow) => {
    if (local === 'P')
      return {
        local: sys('P', 'inter_entity_clearing', remote),
        remote: sys(remote, flow === 'out' ? 'owner_contribution' : 'owner_draw'),
      };
    if (remote === 'P')
      return {
        local: sys(local, flow === 'out' ? 'owner_draw' : 'owner_contribution'),
        remote: sys('P', 'inter_entity_clearing', local),
      };
    return flow === 'out'
      ? { local: sys(local, 'due_from_entity', remote), remote: sys(remote, 'due_to_entity', local) }
      : { local: sys(local, 'due_to_entity', remote), remote: sys(remote, 'due_from_entity', local) };
  },
};

const card = acct('card', 'P', 'liability');
const groceries = acct('groceries', 'P', 'expense');
const office = acct('office', 'B', 'expense');
const bizChecking = acct('biz-checking', 'B', 'asset');
const otherChecking = acct('c-checking', 'C', 'asset');

/** Drafts as the poster would read them back: each line knows its account's role and counterparty. */
const booked = (drafts: JournalEntryDraft[]): RebookEntity[] =>
  drafts.map((d) => ({
    entityId: d.entityId,
    functionalCurrency: d.functionalCurrency,
    entryDate: d.entryDate,
    kind: d.kind,
    description: d.description,
    lines: d.postings.map((p) => {
      const [, role, cp] = p.accountId.split(':');
      return { ...p, role: (role as SystemRole) ?? null, counterpartyEntityId: cp ?? null };
    }),
  }));

/** Each entity's lines as account → amount, for comparing. */
const view = (drafts: JournalEntryDraft[]) =>
  Object.fromEntries(
    drafts.map((d) => [d.entityId, Object.fromEntries(d.postings.map((p) => [p.accountId, p.amount]))]),
  );

const spend = (account: LedgerAccountRef, category: LedgerAccountRef, amount = -10000n) =>
  buildTransactionEntries(
    { date: D, description: 'Purchase', account, amount, splits: [{ account: category, amount }] },
    resolver,
  );

const move = (drafts: JournalEntryDraft[], accountId: string, from: string, to: string, hub = to) =>
  rebookTransaction(
    {
      bookings: booked(drafts),
      accountId,
      fromEntityId: from,
      toEntityId: to,
      hubEntityId: hub,
      follows: hub === to,
    },
    resolver,
  );

describe('rebookTransaction', () => {
  it('makes a business expense on a personal card a plain business expense once the card is the business’s', () => {
    const before = spend(card, office);
    expect(view(before)).toEqual({
      P: { card: -10000n, 'P:inter_entity_clearing:B': 10000n },
      B: { office: 10000n, 'B:owner_contribution': -10000n },
    });
    expect(view(move(before, 'card', 'P', 'B'))).toEqual({ B: { office: 10000n, card: -10000n } });
  });

  it('shows a personal purchase on a card moved to the business as an owner draw', () => {
    const after = move(spend(card, groceries), 'card', 'P', 'B');
    expect(view(after)).toEqual({
      B: { card: -10000n, 'B:owner_draw': 10000n },
      P: { groceries: 10000n, 'P:inter_entity_clearing:B': -10000n },
    });
    // The same as if the card had always been the business's.
    const always = spend(acct('card', 'B', 'liability'), groceries);
    expect(view(after)).toEqual(view(always));
  });

  it('comes back to exactly where it started', () => {
    const before = spend(card, office);
    const there = move(before, 'card', 'P', 'B');
    const back = move(there, 'card', 'B', 'P');
    expect(view(back)).toEqual(view(before));
  });

  it('takes uncategorized and bank fee lines with the account, not its categories', () => {
    const before = buildTransactionEntries(
      {
        date: D,
        description: 'Mystery',
        account: card,
        amount: -10500n,
        splits: [
          { account: sys('P', 'uncategorized_expense'), amount: -10000n },
          { account: sys('P', 'bank_fees'), amount: -500n },
        ],
      },
      resolver,
    );
    expect(view(move(before, 'card', 'P', 'B'))).toEqual({
      B: { card: -10500n, 'B:uncategorized_expense': 10000n, 'B:bank_fees': 500n },
    });
  });

  it('settles between two businesses with due to and due from', () => {
    const before = buildTransferEntries(
      {
        date: D,
        description: 'Loan to sister company',
        from: bizChecking,
        to: otherChecking,
        amountOut: 5000n,
      },
      resolver,
    );
    // The other company's checking joins the first: the transfer is inside one set of books.
    const after = move(before, 'c-checking', 'C', 'B', 'B');
    expect(view(after)).toEqual({ B: { 'biz-checking': -5000n, 'c-checking': 5000n } });
  });

  it('keeps tags and the old books’ date, kind and description', () => {
    const before = buildTransactionEntries(
      {
        date: D,
        description: 'Lunch',
        account: card,
        amount: -2000n,
        splits: [{ account: office, amount: -2000n, memberId: 'm1', memo: 'client' }],
        accountTags: { memberId: 'm2' },
      },
      resolver,
    );
    const [entry] = move(before, 'card', 'P', 'B');
    expect(entry).toMatchObject({ entityId: 'B', entryDate: D, kind: 'standard', description: 'Lunch' });
    expect(entry!.postings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ accountId: 'office', memberId: 'm1', memo: 'client' }),
        expect.objectContaining({ accountId: 'card', memberId: 'm2' }),
      ]),
    );
  });
});

describe('rebookStandalone', () => {
  it('moves an opening balance with the new books’ own equity', () => {
    const opening = buildOpeningBalanceEntry(card, -25000n, D, resolver);
    const [entry] = booked([opening]);
    const moved = rebookStandalone(entry!, 'card', 'B', resolver);
    expect(moved && view([moved])).toEqual({ B: { card: -25000n, 'B:opening_balance_equity': 25000n } });
    expect(moved?.kind).toBe('opening_balance');
  });

  it('leaves a hand-written journal with a category to the user', () => {
    const [entry] = booked([
      {
        entityId: 'P',
        functionalCurrency: 'USD',
        entryDate: D,
        kind: 'manual',
        description: 'Fix',
        postings: [
          {
            lineNo: 1,
            accountId: 'card',
            accountEntityId: 'P',
            currency: 'USD',
            amount: -100n,
            functionalAmount: -100n,
            fxRate: null,
          },
          {
            lineNo: 2,
            accountId: 'groceries',
            accountEntityId: 'P',
            currency: 'USD',
            amount: 100n,
            functionalAmount: 100n,
            fxRate: null,
          },
        ],
      },
    ]);
    expect(rebookStandalone(entry!, 'card', 'B', resolver)).toBeNull();
  });
});
