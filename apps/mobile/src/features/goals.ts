/**
 * Editing a goal on the phone (BUD-07, BUD-08): the sheet's draft and the patch it sends. The rules a goal must
 * keep (a sinking fund's target and due date, a debt payoff's strategy) are checked again by the API; here they
 * only give a message before the round trip.
 */
import { calendarDate, money, parseMoney, toDecimalString, type CalendarDate } from '@montra/domain';
import type { AccountDto, GoalDto, UpdateGoalRequest } from '@montra/schemas';

export interface GoalDraft {
  name: string;
  memberId: string | null;
  target: string;
  dueDate: string;
  strategy: 'avalanche' | 'snowball';
  extraPayment: string;
  linkedAccountIds: string[];
}

export type GoalDraftError = 'name' | 'amount' | 'date' | 'sinking_fund' | 'debts';

const toInput = (minor: string | null, currency: string) =>
  minor === null ? '' : toDecimalString(money(BigInt(minor), currency));

/** The sheet's fields, pre-filled from the goal. */
export function goalDraft(g: GoalDto): GoalDraft {
  return {
    name: g.name,
    memberId: g.memberId,
    target: toInput(g.target, g.currency),
    dueDate: g.dueDate ?? '',
    strategy: g.strategy ?? 'avalanche',
    extraPayment: toInput(g.extraPayment, g.currency),
    linkedAccountIds: [...g.linkedAccountIds],
  };
}

/** Typed amount → minor units; '' → null; undefined when it isn't a valid amount (above zero if `positive`). */
function amount(raw: string, currency: string, positive: boolean): string | null | undefined {
  const s = raw.trim().replace(',', '.');
  if (!s) return null;
  try {
    const m = parseMoney(s, currency).amount;
    return m < 0n || (positive && m === 0n) ? undefined : String(m);
  } catch {
    return undefined;
  }
}

/** The patch for the draft, sent with the goal's version; or what to fix first. */
export function goalPatch(
  g: GoalDto,
  d: GoalDraft,
): { ok: true; patch: UpdateGoalRequest } | { ok: false; error: GoalDraftError } {
  const name = d.name.trim();
  if (!name) return { ok: false, error: 'name' };
  const target = amount(d.target, g.currency, true);
  const extra = amount(d.extraPayment, g.currency, false);
  if (target === undefined || extra === undefined) return { ok: false, error: 'amount' };
  let dueDate: CalendarDate | null = null;
  if (d.dueDate.trim()) {
    try {
      dueDate = calendarDate(d.dueDate.trim());
    } catch {
      return { ok: false, error: 'date' };
    }
  }
  if (g.type === 'sinking_fund' && (target === null || dueDate === null))
    return { ok: false, error: 'sinking_fund' };
  const debt = g.type === 'debt_payoff';
  if (debt && d.linkedAccountIds.length === 0) return { ok: false, error: 'debts' };
  return {
    ok: true,
    patch: {
      name,
      memberId: d.memberId,
      target,
      dueDate,
      linkedAccountIds: d.linkedAccountIds,
      ...(debt ? { strategy: d.strategy, extraPayment: extra } : {}),
      version: g.version,
    },
  };
}

/**
 * Accounts the goal can link: debts for a payoff plan, otherwise savings, of the goal's own books. An archived
 * account stays listed while the goal still links it, so saving doesn't drop it unseen.
 */
export function linkableAccounts(accounts: readonly AccountDto[], g: GoalDto): AccountDto[] {
  const want = g.type === 'debt_payoff' ? 'liability' : 'asset';
  return accounts.filter(
    (a) => a.entityId === g.entityId && a.type === want && (!a.archived || g.linkedAccountIds.includes(a.id)),
  );
}
