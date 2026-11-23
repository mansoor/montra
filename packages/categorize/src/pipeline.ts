/**
 * The categorization pipeline (AI-01..06, FAM-05; 04 §5). Cheapest and most certain first:
 *
 *   1 receipt lines (the caller, before this) → 2 rules → 3 transfer/match (or a transfer made by hand before)
 *   → 4 personal history
 *   → file category → reference merchant → 5 AI → 6 review queue.
 *
 * Rules and transfers always close an item. History, file-category and merchant hints close it when they reach
 * the threshold. Below the threshold they are kept as a fallback, the item still goes to the AI, and the more
 * confident of the two wins. The AI is called once, with every item still open. If it fails, the pipeline
 * degrades to the fallbacks and the review queue; it never throws.
 *
 * Then, for lines that land in rental books (AI-02), the property and unit in the same order: rules, the payee's
 * history, an address or unit in the text, then AI (called once with every line still open). A line whose property
 * someone set, and a transfer, get none.
 */
import { applyRules, type RulesResult } from './rules.js';
import { amountBand, historySuggestion, type HistorySuggestion } from './history.js';
import { rememberedTransfer, transferSuggestion } from './transfers.js';
import { propertyFromText, propertyHistorySuggestion, unitFromText, type PropertyHint } from './property.js';
import type {
  AiPropertySuggestion,
  AiSuggestion,
  Decision,
  PipelineDeps,
  PipelineItem,
  PropertyDecision,
  PropertyOption,
  PropertyQuestion,
  PropertyStep,
  Step,
  TransferCandidate,
} from './types.js';

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
    const candidates = deps.transferCandidates(item);
    const paired = transferSuggestion(item, candidates);
    // A transfer the person made by hand for this payee wins over a weaker pair (amount only, or an account named by
    // its last 4 digits), but not over a sure one.
    const remembered =
      item.payeeKey && deps.transferMemory && !(paired && paired.confidence >= 0.95)
        ? rememberedTransfer(item, deps.transferMemory(item.payeeKey), candidates)
        : null;
    const transfer = remembered ?? paired;
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

  const decisions = work.map((w) => decide(w, deps));
  await decideProperties(work, decisions, deps);
  return decisions;
}

// ----- AI-02: property and unit --------------------------------------------------------------------------------

interface PropertyCandidate extends PropertyHint {
  step: PropertyStep;
}

interface PropertyWork {
  w: Work;
  decision: Decision;
  entityId: string;
  options: readonly PropertyOption[];
  closed: PropertyCandidate | null;
  fallback: PropertyCandidate | null;
}

const betterProperty = (a: PropertyCandidate | null, b: PropertyCandidate): PropertyCandidate =>
  a && a.confidence >= b.confidence ? a : b;

const textOf = (i: PipelineItem) => [i.payee ?? '', i.description, i.rawDescription ?? ''].join(' ');

/** A property without a unit takes the unit the text names, when the property has units. */
function withUnit(
  c: PropertyCandidate,
  options: readonly PropertyOption[],
  item: PipelineItem,
): PropertyCandidate {
  if (c.unitId) return c;
  const units = options.find((p) => p.id === c.propertyId)?.units ?? [];
  const u = units.length ? unitFromText(textOf(item), units) : null;
  return u ? { ...c, unitId: u.id, explanation: `${c.explanation}; the text names ${u.label}` } : c;
}

async function decideProperties(
  work: readonly Work[],
  decisions: Decision[],
  deps: PipelineDeps,
): Promise<void> {
  if (!deps.properties) return;
  const threshold = deps.propertyThreshold ?? deps.threshold;
  const pending: PropertyWork[] = [];
  work.forEach((w, i) => {
    const decision = decisions[i]!;
    if (w.item.keepProperty || decision.step === 'transfer') return;
    const entityId = decision.entityId ?? w.item.entityId;
    const options = deps.properties!(entityId);
    if (options.length === 0) return;
    const pw: PropertyWork = { w, decision, entityId, options, closed: null, fallback: null };
    pending.push(pw);
    const a = w.rules.actions;
    const ruled = a.propertyId ? options.find((p) => p.id === a.propertyId) : undefined;
    if (ruled) {
      const unit = a.unitId ? ruled.units.find((u) => u.id === a.unitId) : undefined;
      pw.closed = withUnit(
        {
          step: 'rule',
          propertyId: ruled.id,
          unitId: unit?.id ?? null,
          confidence: 1,
          explanation: `Matched rule '${w.rules.propertyRuleName ?? ''}'`,
        },
        options,
        w.item,
      );
      return;
    }
    const hints: PropertyCandidate[] = [];
    const history =
      w.item.payeeKey && deps.propertyHistory
        ? propertyHistorySuggestion(deps.propertyHistory(w.item.payeeKey), options)
        : null;
    if (history) hints.push(withUnit({ step: 'history', ...history }, options, w.item));
    const text = propertyFromText(textOf(w.item), options);
    if (text) hints.push({ step: 'text', ...text });
    for (const h of hints) {
      if (h.confidence >= threshold) {
        pw.closed = h;
        return;
      }
      pw.fallback = betterProperty(pw.fallback, h);
    }
  });

  const open = pending.filter((p) => !p.closed);
  if (deps.aiProperty && open.length > 0) {
    let suggestions: ReadonlyMap<string, AiPropertySuggestion> = new Map();
    try {
      suggestions = await deps.aiProperty(
        open.map((p): PropertyQuestion => ({
          item: p.w.item,
          entityId: p.entityId,
          categoryId: p.decision.categoryId,
        })),
      );
    } catch {
      // Graceful degradation: the fallbacks, or no property.
    }
    for (const p of open) {
      const s = suggestions.get(p.w.item.id);
      const property = s?.propertyId ? p.options.find((o) => o.id === s.propertyId) : undefined;
      if (!s || !property) continue;
      const unit = s.unitId ? property.units.find((u) => u.id === s.unitId) : undefined;
      p.fallback = betterProperty(
        p.fallback,
        withUnit(
          {
            step: 'ai',
            propertyId: property.id,
            unitId: unit?.id ?? null,
            confidence: s.confidence,
            explanation: s.explanation,
          },
          p.options,
          p.w.item,
        ),
      );
    }
  }

  for (const p of pending) {
    const chosen = p.closed ?? p.fallback;
    if (!chosen) continue;
    const needed = chosen.step === 'ai' ? Math.max(threshold, deps.aiThreshold ?? threshold) : threshold;
    // The line's split can carry the property only when it is in the property's books: the category applied there,
    // or, uncategorized, the account's own books.
    const fits = (p.decision.autoApply && p.decision.categoryId !== null) || p.entityId === p.w.item.entityId;
    const p0 = p.options.find((o) => o.id === chosen.propertyId)!;
    const unit = chosen.unitId ? p0.units.find((u) => u.id === chosen.unitId) : undefined;
    const property: PropertyDecision = {
      propertyId: chosen.propertyId,
      unitId: chosen.unitId,
      label: unit ? `${p0.name}, ${unit.label}` : p0.name,
      step: chosen.step,
      confidence: chosen.confidence,
      explanation: chosen.explanation,
      autoApply: chosen.confidence >= needed && fits,
    };
    p.decision.property = property;
  }
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

  const meetsThreshold =
    chosen.confidence >= (chosen.step === 'ai' ? (deps.aiThreshold ?? deps.threshold) : deps.threshold);
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
    property: null,
  };
}
