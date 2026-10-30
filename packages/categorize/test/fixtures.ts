import { calendarDate } from '@montra/domain';
import type { PipelineDeps, PipelineItem, RuleRecord, Subject } from '../src/index.js';

export const d = calendarDate;

export function subject(over: Partial<Subject> = {}): Subject {
  return {
    payee: 'Shell Oil',
    payeeKey: 'SHELL OIL',
    description: 'SHELL OIL 57444 HOUSTON TX',
    rawDescription: 'SHELL OIL 57444 HOUSTON TX',
    amountMinor: -4200n,
    exponent: 2,
    accountId: 'acct-1',
    entityId: 'ent-personal',
    date: d('2026-10-14'), // a Wednesday
    ...over,
  };
}

export function item(over: Partial<PipelineItem> = {}): PipelineItem {
  return {
    ...subject(),
    id: 'row-1',
    currency: 'USD',
    accountType: 'checking',
    entityType: 'personal',
    defaultMemberId: null,
    ...over,
  };
}

let seq = 0;
export function rule(over: Partial<RuleRecord> = {}): RuleRecord {
  seq += 1;
  return {
    id: `rule-${seq}`,
    name: `Rule ${seq}`,
    entityId: null,
    priority: 100,
    conditions: { all: [{ field: 'payee', op: 'contains', value: 'shell' }] },
    actions: { categoryId: 'cat-fuel' },
    enabled: true,
    createdAt: `2026-01-01T00:${String(Math.floor(seq / 60) % 60).padStart(2, '0')}:${String(seq % 60).padStart(2, '0')}Z`,
    ...over,
  };
}

export function deps(over: Partial<PipelineDeps> = {}): PipelineDeps {
  return {
    rules: [],
    history: () => [],
    transferCandidates: () => [],
    threshold: 0.8,
    entityOfCategory: (id) => (id.startsWith('biz-') ? 'ent-business' : 'ent-personal'),
    ...over,
  };
}
