/**
 * Rules editor model (UP-02, 04 §6): a form-friendly draft of a rule's conditions and actions, and the
 * conversions to and from the API's `RuleConditions` / `RuleActions`. The API validates again (RE2 regexes,
 * amount ranges); the checks here give instant feedback while typing.
 */
import type { RuleCondition, RuleConditions, RuleDto } from '@montra/schemas';
import type { CreateRuleInput } from '@montra/api-client';

export type RuleField = RuleCondition['field'];
export type RuleOp = RuleCondition['op'];

/** Fields offered for transaction rules (item_text applies to receipt lines, which arrive in Phase 4). */
export const RULE_FIELDS = [
  'payee',
  'description',
  'raw_description',
  'amount',
  'account',
  'entity',
  'date_dow',
] as const satisfies readonly RuleField[];

const TEXT_OPS: RuleOp[] = ['contains', 'equals', 'starts_with', 'regex'];
export const OPS_BY_FIELD: Record<RuleField, RuleOp[]> = {
  payee: TEXT_OPS,
  description: TEXT_OPS,
  raw_description: TEXT_OPS,
  item_text: TEXT_OPS,
  amount: ['between', 'gt', 'lt', 'equals'],
  account: ['in'],
  entity: ['in'],
  date_dow: ['in'],
};

export const isTextField = (f: RuleField) => OPS_BY_FIELD[f] === TEXT_OPS;
export const isListField = (f: RuleField) => f === 'account' || f === 'entity' || f === 'date_dow';

export interface ConditionDraft {
  key: string;
  field: RuleField;
  op: RuleOp;
  /** Text, or the amount (lower bound for `between`). */
  value: string;
  /** Upper bound for `between`. */
  value2: string;
  /** Ids for account/entity, "0".."6" for weekdays. */
  values: string[];
  /** Case-insensitive text match (default on). */
  ci: boolean;
}

export type ConditionItem =
  { kind: 'cond'; cond: ConditionDraft } | { kind: 'any'; key: string; conds: ConditionDraft[] };

export interface ActionsDraft {
  categoryId: string;
  memberId: string;
  tags: string;
  renamePayee: string;
  markReviewed: boolean;
}

export interface RuleDraft {
  name: string;
  /** '' = all books. */
  entityId: string;
  priority: number;
  enabled: boolean;
  items: ConditionItem[];
  actions: ActionsDraft;
}

let seq = 0;
export const newKey = () => `k${++seq}`;

export function emptyCondition(field: RuleField = 'payee'): ConditionDraft {
  return { key: newKey(), field, op: OPS_BY_FIELD[field][0]!, value: '', value2: '', values: [], ci: true };
}

export function emptyDraft(): RuleDraft {
  return {
    name: '',
    entityId: '',
    priority: 100,
    enabled: true,
    items: [{ kind: 'cond', cond: emptyCondition() }],
    actions: { categoryId: '', memberId: '', tags: '', renamePayee: '', markReviewed: false },
  };
}

/** Changing a condition's field resets the operator and values that don't fit the new field. */
export function withField(c: ConditionDraft, field: RuleField): ConditionDraft {
  if (c.field === field) return c;
  return { ...emptyCondition(field), key: c.key };
}

const DECIMAL = /^-?\d+(\.\d{1,4})?$/;
const normalizeDecimal = (s: string) => s.trim().replace(/,/g, '');

export type DraftError = { key: string; error: string };

function toCondition(c: ConditionDraft): RuleCondition | DraftError {
  if (isListField(c.field)) {
    if (c.values.length === 0) return { key: c.key, error: 'rules.error.pick_values' };
    return { field: c.field, op: 'in', value: c.values };
  }
  if (c.field === 'amount') {
    const a = normalizeDecimal(c.value);
    if (!DECIMAL.test(a)) return { key: c.key, error: 'rules.error.amount' };
    if (c.op === 'between') {
      const b = normalizeDecimal(c.value2);
      if (!DECIMAL.test(b)) return { key: c.key, error: 'rules.error.amount' };
      if (Number(a) > Number(b)) return { key: c.key, error: 'rules.error.range' };
      return { field: 'amount', op: 'between', value: [a, b] };
    }
    return { field: 'amount', op: c.op, value: a };
  }
  const text = c.value.trim();
  if (!text) return { key: c.key, error: 'rules.error.text' };
  if (c.op === 'regex') {
    if (text.length > 100) return { key: c.key, error: 'rules.error.regex_long' };
    try {
      new RegExp(text);
    } catch {
      return { key: c.key, error: 'rules.error.regex' };
    }
  }
  return { field: c.field, op: c.op, value: text, ...(c.ci ? {} : { ci: false }) };
}

const isError = (x: unknown): x is DraftError =>
  typeof x === 'object' && x !== null && 'error' in x && 'key' in x;

export function draftConditions(items: ConditionItem[]): { ok: true; value: RuleConditions } | DraftError {
  const all: RuleConditions['all'] = [];
  for (const item of items) {
    if (item.kind === 'cond') {
      const c = toCondition(item.cond);
      if (isError(c)) return c;
      all.push(c);
    } else {
      if (item.conds.length === 0) continue;
      const any: RuleCondition[] = [];
      for (const d of item.conds) {
        const c = toCondition(d);
        if (isError(c)) return c;
        any.push(c);
      }
      all.push({ any });
    }
  }
  if (all.length === 0) return { key: '', error: 'rules.error.no_conditions' };
  return { ok: true, value: { all } };
}

export const parseTagList = (s: string) =>
  [
    ...new Set(
      s
        .split(',')
        .map((x) => x.trim().replace(/^#/, ''))
        .filter(Boolean),
    ),
  ].slice(0, 10);

export function draftActions(a: ActionsDraft): CreateRuleInput['actions'] | DraftError {
  const out: CreateRuleInput['actions'] = {};
  if (a.categoryId) out.categoryId = a.categoryId;
  if (a.memberId) out.memberId = a.memberId;
  const tags = parseTagList(a.tags);
  if (tags.length) out.tags = tags;
  if (a.renamePayee.trim()) out.renamePayee = a.renamePayee.trim();
  if (a.markReviewed) out.markReviewed = true;
  if (Object.keys(out).length === 0) return { key: '', error: 'rules.error.no_actions' };
  return out;
}

/** The create/update body for a valid draft, or the first problem (an i18n key and the condition's key). */
export function draftToRequest(d: RuleDraft): { ok: true; value: CreateRuleInput } | DraftError {
  if (!d.name.trim()) return { key: 'name', error: 'rules.error.name' };
  const conditions = draftConditions(d.items);
  if (!('ok' in conditions)) return conditions;
  const actions = draftActions(d.actions);
  if (isError(actions)) return actions;
  return {
    ok: true,
    value: {
      name: d.name.trim(),
      entityId: d.entityId || null,
      priority: d.priority,
      enabled: d.enabled,
      conditions: conditions.value,
      actions,
    },
  };
}

function fromCondition(c: RuleCondition): ConditionDraft {
  const base = emptyCondition(c.field);
  const values = Array.isArray(c.value) ? c.value : [c.value];
  if (isListField(c.field)) return { ...base, op: 'in', values };
  if (c.field === 'amount' && c.op === 'between')
    return { ...base, op: 'between', value: values[0] ?? '', value2: values[1] ?? '' };
  return { ...base, op: c.op, value: values[0] ?? '', ci: c.ci !== false };
}

export function ruleToDraft(rule: RuleDto): RuleDraft {
  const a = rule.actions as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  return {
    name: rule.name,
    entityId: rule.entityId ?? '',
    priority: rule.priority,
    enabled: rule.enabled,
    items: rule.conditions.all.map((x) =>
      'any' in x
        ? { kind: 'any' as const, key: newKey(), conds: x.any.map(fromCondition) }
        : { kind: 'cond' as const, cond: fromCondition(x) },
    ),
    actions: {
      categoryId: str(a.categoryId),
      memberId: str(a.memberId),
      tags: Array.isArray(a.tags) ? (a.tags as string[]).join(', ') : '',
      renamePayee: str(a.renamePayee),
      markReviewed: a.markReviewed === true,
    },
  };
}

type T = (key: string, values?: Record<string, string | number>) => string;

/** One line per condition for the rules list, e.g. "Payee contains “shell” and Amount between -200 and -5". */
export function describeConditions(
  conditions: RuleConditions,
  t: T,
  names: (field: RuleField, id: string) => string = (_f, id) => id,
): string {
  const one = (c: RuleCondition): string => {
    const field = t(`rules.field.${c.field}`);
    const values = Array.isArray(c.value) ? c.value : [c.value];
    if (c.field === 'date_dow')
      return t('rules.describe.in', {
        field,
        values: values.map((v) => t(`rules.dow.${v}`)).join(', '),
      });
    if (isListField(c.field))
      return t('rules.describe.in', { field, values: values.map((v) => names(c.field, v)).join(', ') });
    if (c.op === 'between')
      return t('rules.describe.between', { field, from: values[0] ?? '', to: values[1] ?? '' });
    return t('rules.describe.op', { field, op: t(`rules.op.${c.op}`), value: values[0] ?? '' });
  };
  return conditions.all
    .map((x) => ('any' in x ? `(${x.any.map(one).join(` ${t('rules.or')} `)})` : one(x)))
    .join(` ${t('rules.and')} `);
}

export const ORIGIN_KEYS: Record<RuleDto['origin'], string> = {
  user: 'rules.origin.user',
  ai_suggested: 'rules.origin.ai_suggested',
  correction: 'rules.origin.correction',
};

/** Rules in evaluation order: priority, then oldest first (first match wins per field). */
export const sortRules = (rules: RuleDto[]) =>
  [...rules].sort((a, b) => a.priority - b.priority || a.createdAt.localeCompare(b.createdAt));
