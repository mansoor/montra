/**
 * The categorization pipeline (AI-01..06, FAM-05; 04 §5). Cheapest and most certain first:
 *
 *   1 receipt lines (the caller, before this) → 2 rules → 3 transfer/match → 4 personal history
 *   → file category → reference merchant → 5 AI → 6 review queue.
 *
 * Rules and transfers always close an item. History, file-category and merchant hints close it when they reach
 * the threshold. Below the threshold they are kept as a fallback, the item still goes to the AI, and the more
 * confident of the two wins. The AI is called once, with every item still open. If it fails, the pipeline
 * degrades to the fallbacks and the review queue; it never throws.
 */
import { applyRules, type RulesResult } from './rules.js';
import { amountBand, historySuggestion, type HistorySuggestion } from './history.js';
import { transferSuggestion } from './transfers.js';
import type { AiSuggestion, Decision, PipelineDeps, PipelineItem, Step, TransferCandidate } from './types.js';

interface Candidate {
  step: Step;
  categoryId: string | null;
  confidence: number;
  explanation: string;
  transfer: TransferCandidate | null;
}

interface Work {
  item: PipelineItem;
  rules: RulesResult;
  history: HistorySuggestion | null;
  closed: Candidate | null;
  fallback: Candidate | null;
  ai: AiSuggestion | null;
}

function better(a: Candidate | null, b: Candidate): Candidate {
  return a && a.confidence >= b.confidence ? a : b;
}

export async function runPipeline(items: readonly PipelineItem[], deps: PipelineDeps): Promise<Decision[]> {
  const threshold = deps.threshold;
  const work: Work[] = items.map((item) => {
    const rules = applyRules(deps.rules, item);
    const history = item.payeeKey
      ? historySuggestion(deps.history(item.payeeKey), amountBand(item.amountMinor, item.exponent))
      : null;
    const w: Work = { item, rules, history, closed: null, fallback: null, ai: null };

    if (rules.actions.categoryId) {
      w.closed = {
        step: 'rule',
        categoryId: rules.actions.categoryId,
        confidence: 1,
        explanation: `Matched rule '${rules.ruleName}'`,
        transfer: null,
      };
      return w;
    }
    const transfer = transferSuggestion(item, deps.transferCandidates(item));
    if (transfer) {
      w.closed = {
        step: 'transfer',
        categoryId: null,
        confidence: transfer.confidence,
        explanation: transfer.explanation,
        transfer: transfer.candidate,
      };
      return w;
    }
    const hints: Candidate[] = [];
    if (history)
      hints.push({
        step: 'history',
        categoryId: history.categoryId,
        confidence: history.confidence,
        explanation: history.explanation,
        transfer: null,
      });
    if (item.fileCategoryId)
      hints.push({
        step: 'file',
        categoryId: item.fileCategoryId,
        confidence: 0.9,
        explanation: `From the file's category "${item.fileCategoryName ?? ''}"`,
        transfer: null,
      });
    if (item.merchant?.categoryId)
      hints.push({
        step: 'merchant',
        categoryId: item.merchant.categoryId,
        confidence: 0.8,
        explanation: `Known merchant: ${item.merchant.name}`,
        transfer: null,
      });
    for (const h of hints) {
      if (h.confidence >= threshold) {
        w.closed = h;
        return w;
      }
      w.fallback = better(w.fallback, h);
    }
    return w;
  });

  const open = work.filter((w) => !w.closed);
  if (deps.ai && open.length > 0) {
    let suggestions: ReadonlyMap<string, AiSuggestion> = new Map();
    try {
      suggestions = await deps.ai(open.map((w) => w.item));
    } catch {
      // Graceful degradation (06 §1): fallbacks and the review queue.
    }
    for (const w of open) {
      const s = suggestions.get(w.item.id);
      if (!s) continue;
      w.ai = s;
      if (s.categoryId)
        w.fallback = better(w.fallback, {
          step: 'ai',
          categoryId: s.categoryId,
          confidence: s.confidence,
          explanation: s.explanation,
          transfer: null,
        });
    }
  }

  return work.map((w) => decide(w, deps));
}

function decide(w: Work, deps: PipelineDeps): Decision {
  const { item, rules } = w;
  const chosen: Candidate = w.closed ??
    w.fallback ?? {
      step: 'none',
      categoryId: null,
      confidence: 0,
      explanation: 'Needs review',
      transfer: null,
    };
  const a = rules.actions;
  const memberId =
    a.memberId ?? w.history?.memberId ?? (w.ai?.memberId || null) ?? item.defaultMemberId ?? null;
  const entityId =
    (chosen.categoryId ? deps.entityOfCategory(chosen.categoryId) : null) ?? a.entityId ?? item.entityId;
  const tags = new Set<string>(a.tags ?? []);
  if (chosen.step === 'ai') for (const t of w.ai?.tags ?? []) tags.add(t);

  const meetsThreshold = chosen.confidence >= deps.threshold;
  const autoApply =
    a.markReviewed === true ||
    (chosen.step === 'transfer'
      ? meetsThreshold && chosen.confidence >= 0.95
      : meetsThreshold && chosen.categoryId !== null);

  return {
    id: item.id,
    step: chosen.step,
    categoryId: chosen.categoryId,
    entityId,
    memberId,
    tags: [...tags],
    renamePayee: a.renamePayee ?? null,
    transfer: chosen.transfer,
    confidence: chosen.confidence,
    explanation: chosen.explanation,
    ruleId: chosen.step === 'rule' ? rules.ruleId : null,
    matchedRuleIds: rules.matchedRuleIds,
    autoApply,
  };
}
