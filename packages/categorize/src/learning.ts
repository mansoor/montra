/** Learning from corrections (AI-05): after N identical corrections for a payee, offer a rule. */
import type { CorrectionRecord, RuleProposal } from './types.js';

/**
 * `corrections` are for one payee key, oldest first. Returns a rule proposal when at least `minEvidence`
 * corrections set the same field to the same value (the most recent wins a tie). The `name` is the payee; the
 * caller adds the target label ("Shell → Fuel").
 */
export function proposeRuleFromCorrections(
  corrections: readonly CorrectionRecord[],
  minEvidence = 2,
): RuleProposal | null {
  const groups = new Map<
    string,
    { field: 'category' | 'member'; value: string; count: number; last: number }
  >();
  corrections.forEach((c, i) => {
    if (c.toValue === null || (c.field !== 'category' && c.field !== 'member')) return;
    const key = `${c.field}:${c.toValue}`;
    const g = groups.get(key) ?? { field: c.field, value: c.toValue, count: 0, last: -1 };
    g.count += 1;
    g.last = i;
    groups.set(key, g);
  });
  let best: { field: 'category' | 'member'; value: string; count: number; last: number } | null = null;
  for (const g of groups.values())
    if (!best || g.count > best.count || (g.count === best.count && g.last > best.last)) best = g;
  if (!best || best.count < minEvidence) return null;

  const latestPayee = [...corrections].reverse().find((c) => c.payee && c.payee.trim() !== '')?.payee;
  const payeeKey = corrections[corrections.length - 1]!.payeeKey;
  const payee = (latestPayee ?? payeeKey).trim();
  return {
    payeeKey,
    name: payee,
    conditions: { all: [{ field: 'payee', op: 'contains', value: payee, ci: true }] },
    actions: best.field === 'category' ? { categoryId: best.value } : { memberId: best.value },
    evidence: best.count,
  };
}
