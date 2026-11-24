/**
 * Rules engine (UP-02, 04 §6). Conditions are AND-ed; an `{ any: [...] }` group is OR-ed. Regexes run on RE2
 * (`re2js`, linear time), so a user-written pattern can't cause ReDoS.
 *
 * Field semantics:
 * - `payee` matches the payee text or the normalized payee key (either one).
 * - `description`, `raw_description` and `item_text` are text fields. A missing value never matches.
 * - `amount` compares the **signed** amount from the account's view in major units. An outflow of $42 is
 *   -42.00, so "fuel between $5 and $200" is written `between ["-200.00", "-5.00"]`.
 * - `account` and `entity` compare ids with `equals` or `in`.
 * - `date_dow` is the day of the week, 0 = Sunday … 6 = Saturday.
 * - `added_by` and `category` are for receipt-line rules only (owner, 2026-11-24). `added_by` compares the member
 *   linked to the login that added the receipt; `category` compares the line's category, with `equals` or `in`.
 * - Text comparison collapses whitespace and is case-insensitive unless `ci: false`.
 *
 * A receipt line's rules run in two steps. Step 1 (`applyRules` with no `categoryId` on the subject) decides the
 * category: a rule with a `category` condition can't match yet. The caller then settles the category (a rule, item
 * history or AI). Step 2 (`applyMemberRules`, with the line's category on the subject) decides the member: every rule
 * runs again in the same order, so one that checks the category takes part like any other.
 */
import { isoDayOfWeek, type Decimal } from '@montra/domain';
import { RE2JS } from 're2js';
import { compareMinorToDecimal, normText, parseRuleDecimal } from './text.js';
import type {
  CompiledRule,
  RuleActions,
  RuleCondition,
  RuleConditions,
  RuleRecord,
  RuleScope,
  Subject,
} from './types.js';

export class RuleError extends Error {
  readonly path: string;
  constructor(message: string, path: string) {
    super(message);
    this.name = 'RuleError';
    this.path = path;
  }
}

const TEXT_FIELDS = new Set(['payee', 'description', 'raw_description', 'item_text']);
/** Conditions only a receipt line has (owner, 2026-11-24). */
const RECEIPT_LINE_FIELDS = new Set(['added_by', 'category']);
const TEXT_OPS = new Set(['equals', 'contains', 'starts_with', 'regex', 'in']);
const AMOUNT_OPS = new Set(['equals', 'between', 'gt', 'lt']);
const ID_OPS = new Set(['equals', 'in']);
const DOW_OPS = new Set(['equals', 'in']);
const MAX_REGEX = 100;

interface Issue {
  path: string;
  message: string;
}

function conditionIssues(c: RuleCondition, path: string): Issue[] {
  const out: Issue[] = [];
  const bad = (message: string) => out.push({ path, message });
  const isArray = Array.isArray(c.value);
  if (TEXT_FIELDS.has(c.field)) {
    if (!TEXT_OPS.has(c.op)) bad(`"${c.op}" can't be used with ${c.field}`);
    else if (c.op === 'in') {
      if (!isArray || (c.value as string[]).length === 0) bad('"in" needs a list of values');
    } else if (isArray || typeof c.value !== 'string') bad(`"${c.op}" needs a single text value`);
    else if (c.op === 'regex') {
      if (c.value.length > MAX_REGEX) bad(`The pattern is longer than ${MAX_REGEX} characters`);
      else {
        try {
          RE2JS.compile(c.value, c.ci === false ? 0 : RE2JS.CASE_INSENSITIVE);
        } catch (err) {
          bad(`Invalid pattern: ${(err as Error).message}`);
        }
      }
    } else if (c.value.trim() === '') bad('The value is empty');
  } else if (c.field === 'amount') {
    if (!AMOUNT_OPS.has(c.op)) bad(`"${c.op}" can't be used with amount`);
    else if (c.op === 'between') {
      const v = c.value;
      if (!Array.isArray(v) || v.length !== 2) bad('"between" needs two amounts');
      else {
        const lo = parseRuleDecimal(v[0]!);
        const hi = parseRuleDecimal(v[1]!);
        if (!lo || !hi) bad('"between" needs two decimal amounts, e.g. "-200.00"');
        else if (compareDecimals(lo, hi) > 0) bad('The first amount must not be greater than the second');
      }
    } else if (isArray || typeof c.value !== 'string' || !parseRuleDecimal(c.value))
      bad(`"${c.op}" needs one decimal amount, e.g. "-5.00"`);
  } else if (
    c.field === 'account' ||
    c.field === 'entity' ||
    c.field === 'added_by' ||
    c.field === 'category'
  ) {
    if (!ID_OPS.has(c.op)) bad(`"${c.op}" can't be used with ${c.field}`);
    else if (c.op === 'in' && (!isArray || (c.value as string[]).length === 0))
      bad('"in" needs a list of values');
    else if (c.op === 'equals' && (isArray || typeof c.value !== 'string' || c.value === ''))
      bad('"equals" needs a single value');
  } else if (c.field === 'date_dow') {
    if (!DOW_OPS.has(c.op)) bad(`"${c.op}" can't be used with date_dow`);
    else {
      const values = Array.isArray(c.value) ? c.value : [c.value];
      if (c.op === 'in' && !isArray) bad('"in" needs a list of values');
      else if (c.op === 'equals' && isArray) bad('"equals" needs a single value');
      else if (values.length === 0 || values.some((v) => !/^[0-6]$/.test(v)))
        bad('Days of the week are 0 (Sunday) to 6 (Saturday)');
    }
  } else {
    bad(`Unknown field "${String(c.field)}"`);
  }
  return out;
}

function compareDecimals(a: Decimal, b: Decimal): number {
  return compareMinorToDecimal(a.coefficient, a.scale, b);
}

function actionIssues(a: RuleActions, scope: RuleScope): Issue[] {
  const out: Issue[] = [];
  if (a.household !== undefined) {
    if (scope !== 'receipt_line')
      out.push({ path: 'actions.household', message: 'Only receipt-item rules can set Household' });
    else if (a.household !== true)
      out.push({ path: 'actions.household', message: 'Household is set with true, or left out' });
    else if (a.memberId)
      out.push({ path: 'actions.household', message: 'Choose a member or Household, not both' });
  }
  if (a.tags !== undefined) {
    if (
      !Array.isArray(a.tags) ||
      a.tags.some((t) => typeof t !== 'string' || t.trim() === '' || t.length > 50)
    )
      out.push({ path: 'actions.tags', message: 'Tags must be non-empty text of at most 50 characters' });
  }
  if (a.renamePayee !== undefined && a.renamePayee !== null && a.renamePayee.trim() === '')
    out.push({ path: 'actions.renamePayee', message: 'The new payee name is empty' });
  if (a.unitId && !a.propertyId) out.push({ path: 'actions.unitId', message: 'A unit needs its property' });
  const any =
    Boolean(a.categoryId) ||
    Boolean(a.entityId) ||
    Boolean(a.memberId) ||
    a.household === true ||
    (a.tags?.length ?? 0) > 0 ||
    Boolean(a.renamePayee) ||
    Boolean(a.propertyId) ||
    a.markReviewed === true;
  if (!any) out.push({ path: 'actions', message: 'A rule needs at least one action' });
  return out;
}

/** Each condition with its path, groups flattened. */
function eachCondition(conditions: RuleConditions): Array<{ c: RuleCondition; path: string }> {
  return conditions.all.flatMap((entry, i) =>
    'any' in entry
      ? entry.any.map((c, j) => ({ c, path: `conditions.all[${i}].any[${j}]` }))
      : [{ c: entry, path: `conditions.all[${i}]` }],
  );
}

function scopeIssues(conditions: RuleConditions, actions: RuleActions, scope: RuleScope): Issue[] {
  const out: Issue[] = [];
  const conds = eachCondition(conditions);
  if (scope !== 'receipt_line') {
    for (const { c, path } of conds)
      if (RECEIPT_LINE_FIELDS.has(c.field))
        out.push({
          path,
          message: `Only receipt-item rules can check ${c.field === 'added_by' ? 'who added the receipt' : 'the category'}`,
        });
    return out;
  }
  // Step 2 decides the member once the category is known: a rule that checks the category can't also set it.
  const checksCategory = conds.find(({ c }) => c.field === 'category');
  if (checksCategory && (actions.categoryId || actions.entityId))
    out.push({
      path: checksCategory.path,
      message: "A rule that checks the category can't set the category or the books",
    });
  return out;
}

function issues(conditions: RuleConditions, actions: RuleActions, scope: RuleScope): Issue[] {
  const out: Issue[] = [];
  if (!conditions || !Array.isArray(conditions.all) || conditions.all.length === 0)
    out.push({ path: 'conditions.all', message: 'A rule needs at least one condition' });
  else
    conditions.all.forEach((entry, i) => {
      if ('any' in entry) {
        if (!Array.isArray(entry.any) || entry.any.length === 0)
          out.push({
            path: `conditions.all[${i}].any`,
            message: 'An "any" group needs at least one condition',
          });
        else entry.any.forEach((c, j) => out.push(...conditionIssues(c, `conditions.all[${i}].any[${j}]`)));
      } else out.push(...conditionIssues(entry, `conditions.all[${i}]`));
    });
  out.push(...actionIssues(actions ?? {}, scope));
  // Checked once the shapes are sound.
  if (out.length === 0) out.push(...scopeIssues(conditions, actions ?? {}, scope));
  return out;
}

/**
 * Problems with a rule, as "path: message" lines; empty when the rule is valid. `scope` defaults to `transaction`,
 * which refuses the receipt-line conditions (`added_by`, `category`) and the household action.
 */
export function validateRule(
  conditions: RuleConditions,
  actions: RuleActions,
  scope: RuleScope = 'transaction',
): string[] {
  return issues(conditions, actions, scope).map((i) => `${i.path}: ${i.message}`);
}

// ----- Compilation ---------------------------------------------------------------------------------------

type Predicate = (s: Subject) => boolean;

function textValues(s: Subject, field: string): string[] {
  switch (field) {
    case 'payee':
      return [s.payee, s.payeeKey].filter((v): v is string => typeof v === 'string' && v !== '');
    case 'description':
      return s.description ? [s.description] : [];
    case 'raw_description':
      return s.rawDescription ? [s.rawDescription] : [];
    case 'item_text':
      return s.itemText ? [s.itemText] : [];
    default:
      return [];
  }
}

function compileCondition(c: RuleCondition): Predicate {
  const ci = c.ci !== false;
  if (TEXT_FIELDS.has(c.field)) {
    const get = (s: Subject) => textValues(s, c.field).map((v) => normText(v, ci));
    if (c.op === 'regex') {
      const re = RE2JS.compile(c.value as string, ci ? RE2JS.CASE_INSENSITIVE : 0);
      return (s) => textValues(s, c.field).some((v) => re.test(normText(v, false)));
    }
    if (c.op === 'in') {
      const set = new Set((c.value as string[]).map((v) => normText(v, ci)));
      return (s) => get(s).some((v) => set.has(v));
    }
    const needle = normText(c.value as string, ci);
    if (c.op === 'equals') return (s) => get(s).some((v) => v === needle);
    if (c.op === 'starts_with') return (s) => get(s).some((v) => v.startsWith(needle));
    return (s) => get(s).some((v) => v.includes(needle));
  }
  if (c.field === 'amount') {
    const cmp = (s: Subject, d: Decimal) => compareMinorToDecimal(s.amountMinor, s.exponent, d);
    if (c.op === 'between') {
      const [lo, hi] = (c.value as string[]).map((v) => parseRuleDecimal(v)!);
      return (s) => cmp(s, lo!) >= 0 && cmp(s, hi!) <= 0;
    }
    const d = parseRuleDecimal(c.value as string)!;
    if (c.op === 'gt') return (s) => cmp(s, d) > 0;
    if (c.op === 'lt') return (s) => cmp(s, d) < 0;
    return (s) => cmp(s, d) === 0;
  }
  if (c.field === 'account' || c.field === 'entity' || c.field === 'added_by' || c.field === 'category') {
    const ids = new Set((Array.isArray(c.value) ? c.value : [c.value]).map((v) => v.toLowerCase()));
    if (c.field === 'account') return (s) => ids.has(s.accountId.toLowerCase());
    if (c.field === 'entity') return (s) => ids.has(s.entityId.toLowerCase());
    // Not known yet (the category in step 1), or none: no match.
    const of = c.field === 'added_by' ? (s: Subject) => s.addedByMemberId : (s: Subject) => s.categoryId;
    return (s) => {
      const v = of(s);
      return typeof v === 'string' && ids.has(v.toLowerCase());
    };
  }
  // date_dow: ISO 0=Monday … 6=Sunday → 0=Sunday … 6=Saturday
  const days = new Set((Array.isArray(c.value) ? c.value : [c.value]).map(Number));
  return (s) => days.has((isoDayOfWeek(s.date) + 1) % 7);
}

/** Compiles one rule. Throws `RuleError` (with the path of the first problem) when the rule is invalid. */
export function compileRule(r: RuleRecord): CompiledRule {
  const problems = issues(r.conditions, r.actions, r.scope ?? 'transaction');
  if (problems.length > 0) throw new RuleError(problems[0]!.message, problems[0]!.path);
  const parts: Predicate[] = r.conditions.all.map((entry) => {
    if ('any' in entry) {
      const ors = entry.any.map(compileCondition);
      return (s: Subject) => ors.some((p) => p(s));
    }
    return compileCondition(entry);
  });
  return {
    record: r,
    matches: (s: Subject) => parts.every((p) => p(s)),
  };
}

/** Compiles enabled rules in evaluation order (priority, then age). Invalid rules are reported, not thrown. */
export function compileRules(records: readonly RuleRecord[]): {
  rules: CompiledRule[];
  errors: Array<{ ruleId: string; message: string }>;
} {
  const ordered = records
    .filter((r) => r.enabled)
    .slice()
    .sort(
      (a, b) =>
        a.priority - b.priority ||
        (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0) ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
  const rules: CompiledRule[] = [];
  const errors: Array<{ ruleId: string; message: string }> = [];
  for (const r of ordered) {
    try {
      rules.push(compileRule(r));
    } catch (err) {
      const e = err as RuleError;
      errors.push({ ruleId: r.id, message: e.path ? `${e.path}: ${e.message}` : e.message });
    }
  }
  return { rules, errors };
}

export interface RulesResult {
  /** `memberId` or `household` (never both) come from one rule: the first to set either. */
  actions: RuleActions;
  /** The rule that set the category, or the first matching rule when none did. */
  ruleId: string | null;
  ruleName: string | null;
  /** The rule that set the property (AI-02), when one did. */
  propertyRuleName: string | null;
  /** The rule that set the member or Household, when one did. */
  memberRuleId: string | null;
  memberRuleName: string | null;
  matchedRuleIds: string[];
}

/** Runs rules in order. The first matching rule wins for each action field; tags are the union. */
export function applyRules(rules: readonly CompiledRule[], s: Subject): RulesResult {
  const actions: RuleActions = {};
  const matched: CompiledRule[] = [];
  let categoryRule: CompiledRule | null = null;
  let propertyRule: CompiledRule | null = null;
  let memberRule: CompiledRule | null = null;
  const tags = new Set<string>();
  for (const rule of rules) {
    if (!rule.matches(s)) continue;
    matched.push(rule);
    const a = rule.record.actions;
    if (a.categoryId && actions.categoryId === undefined) {
      actions.categoryId = a.categoryId;
      categoryRule = rule;
    }
    if (a.entityId && actions.entityId === undefined) actions.entityId = a.entityId;
    if ((a.memberId || a.household === true) && !memberRule) {
      memberRule = rule;
      if (a.memberId) actions.memberId = a.memberId;
      else actions.household = true;
    }
    if (a.renamePayee && actions.renamePayee === undefined) actions.renamePayee = a.renamePayee;
    if (a.markReviewed !== undefined && actions.markReviewed === undefined)
      actions.markReviewed = a.markReviewed;
    // The property and its unit come from the same rule.
    if (a.propertyId && actions.propertyId === undefined) {
      actions.propertyId = a.propertyId;
      actions.unitId = a.unitId ?? null;
      propertyRule = rule;
    }
    for (const t of a.tags ?? []) tags.add(t);
  }
  if (tags.size > 0) actions.tags = [...tags];
  const named = categoryRule ?? matched[0] ?? null;
  return {
    actions,
    ruleId: named?.record.id ?? null,
    ruleName: named?.record.name ?? null,
    propertyRuleName: propertyRule?.record.name ?? null,
    memberRuleId: memberRule?.record.id ?? null,
    memberRuleName: memberRule?.record.name ?? null,
    matchedRuleIds: matched.map((r) => r.record.id),
  };
}

export interface MemberRuleResult {
  /** Null: the household. */
  memberId: string | null;
  ruleId: string;
  ruleName: string;
}

/**
 * Step 2 of a receipt line's rules: the member, once the line's category is settled. `categoryId` on the subject is
 * the line's category (null when it has none). Every rule runs, in order; the first to set a member or Household
 * wins. Null when none does.
 */
export function applyMemberRules(
  rules: readonly CompiledRule[],
  s: Subject & { categoryId: string | null },
): MemberRuleResult | null {
  const r = applyRules(rules, s);
  if (!r.memberRuleId) return null;
  return {
    memberId: r.actions.household ? null : (r.actions.memberId ?? null),
    ruleId: r.memberRuleId,
    ruleName: r.memberRuleName ?? '',
  };
}
