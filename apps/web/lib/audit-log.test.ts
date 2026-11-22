import { describe, expect, it } from 'vitest';
import type { AuditEntryDto } from '@montra/schemas';
import { AUDIT_BOOKKEEPING_SUBJECTS } from '@montra/schemas';
import { catalogs, createTranslator } from '@montra/i18n';
import {
  AUDIT_SUBJECT_TYPES,
  auditActionText,
  auditChanges,
  auditRecordName,
  auditWho,
  fieldLabel,
  formatAuditValue,
  groupAuditEntries,
  humanize,
  staffActionText,
  subjectTypeLabel,
  triggerOp,
} from './audit-log';
import { settingsGroupsFor, settingsTabOf } from './settings-sections';

const { t } = createTranslator('en-US', catalogs);

const entry = (over: Partial<AuditEntryDto> = {}): AuditEntryDto => ({
  id: '1',
  at: '2026-11-21T10:00:00.000Z',
  actorUserId: 'u1',
  actorName: 'Sam',
  actorType: 'user',
  action: 'transaction.insert',
  subjectType: 'transaction',
  subjectId: 't1',
  diff: null,
  ...over,
});

describe('audit log in words (NFR-03)', () => {
  it('names a trigger row by its record and what happened', () => {
    expect(auditActionText(entry(), t)).toBe('Transaction added');
    expect(auditActionText(entry({ action: 'bank_account.update', subjectType: 'bank_account' }), t)).toBe(
      'Account changed',
    );
    expect(auditActionText(entry({ action: 'posting.delete', subjectType: 'posting' }), t)).toBe(
      'Journal line deleted',
    );
  });

  it('names an action a service wrote, and falls back to plain words for one it doesn’t know', () => {
    expect(auditActionText(entry({ action: 'reconciliation.undo', subjectType: 'reconciliation' }), t)).toBe(
      'Reconciliation undone',
    );
    expect(auditActionText(entry({ action: 'journal_entry.unlock', subjectType: 'journal_entry' }), t)).toBe(
      'Journal entry unlocked',
    );
    expect(auditActionText(entry({ action: 'widget.frobbed', subjectType: 'widget' }), t)).toBe(
      'Widget: frobbed',
    );
    expect(subjectTypeLabel('some_new_table', t)).toBe('Some new table');
  });

  it('knows a trigger operation from an action that only looks like one', () => {
    expect(triggerOp('transaction.insert', 'transaction')).toBe('insert');
    expect(triggerOp('import_batch.discarded', 'import_batch')).toBeNull();
    expect(triggerOp('workspace.insert', 'file')).toBeNull();
  });

  it('has a label for every record type, the bookkeeping ones included', () => {
    for (const type of AUDIT_SUBJECT_TYPES) expect(subjectTypeLabel(type, t)).not.toMatch(/^audit\./);
    for (const type of AUDIT_BOOKKEEPING_SUBJECTS) expect(AUDIT_SUBJECT_TYPES).toContain(type);
  });

  it('says who: a person, Montra for someone, support, or someone who has left', () => {
    expect(auditWho(entry(), t)).toBe('Sam');
    expect(auditWho(entry({ actorType: 'worker' }), t)).toBe('Montra, for Sam');
    expect(auditWho(entry({ actorType: 'worker', actorName: null, actorUserId: null }), t)).toBe(
      'Montra, in the background',
    );
    expect(auditWho(entry({ actorType: 'support' }), t)).toBe('Montra support, with your permission');
    expect(auditWho(entry({ actorName: null }), t)).toBe('Someone no longer in this workspace');
    expect(auditWho(entry({ actorName: null, actorUserId: null }), t)).toBe('Montra');
  });

  it('finds a name for the record, the new one after a rename, never a redacted value', () => {
    expect(auditRecordName(entry({ diff: { id: 'x', description: 'Corner shop' } }))).toBe('Corner shop');
    expect(auditRecordName(entry({ diff: { name: ['Old', 'New'] } }))).toBe('New');
    expect(auditRecordName(entry({ diff: { name_enc: '[redacted]' } }))).toBeNull();
    expect(auditRecordName(entry({ diff: { name: '[redacted]', title: 'Lease' } }))).toBe('Lease');
    expect(auditRecordName(entry({ diff: null }))).toBeNull();
    expect(auditRecordName(entry({ diff: { name: 'x'.repeat(80) } }))).toHaveLength(60);
  });

  it('lists what changed: before and after, or what was added, without the quiet columns', () => {
    expect(
      auditChanges(
        entry({
          action: 'transaction.update',
          diff: { amount: ['-100', '-120'], updated_at: ['a', 'b'] },
        }),
      ),
    ).toEqual([{ field: 'amount', before: '-100', after: '-120' }]);
    expect(
      auditChanges(entry({ diff: { id: 't1', workspace_id: 'w', description: 'Shop', memo: null } })),
    ).toEqual([{ field: 'description', after: 'Shop' }]);
    expect(
      auditChanges(entry({ action: 'rule.delete', subjectType: 'rule', diff: { name: 'Coffee', note: '' } })),
    ).toEqual([{ field: 'name', before: 'Coffee' }]);
    expect(
      auditChanges(
        entry({
          action: 'reconciliation.undo',
          subjectType: 'reconciliation',
          diff: { reason: 'Wrong file' },
        }),
      ),
    ).toEqual([{ field: 'reason', after: 'Wrong file' }]);
    // A JSON column's change is the keys inside it that differ.
    expect(
      auditChanges(
        entry({
          action: 'transaction.update',
          diff: {
            spec: [
              { type: 'standard', amount: '-1250', description: 'Shop', splits: [{ amount: '-1250' }] },
              { type: 'standard', amount: '-1300', description: 'Shop', splits: [{ amount: '-1300' }] },
            ],
          },
        }),
      ),
    ).toEqual([
      { field: 'spec.amount', before: '-1250', after: '-1300' },
      { field: 'spec.splits', before: [{ amount: '-1250' }], after: [{ amount: '-1300' }] },
    ]);
    const many = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`f${i}`, i]));
    expect(auditChanges(entry({ diff: many }))).toHaveLength(30);
  });

  it('writes fields and values as short text', () => {
    expect(fieldLabel('category_group_id')).toBe('Category group');
    expect(fieldLabel('spec.description')).toBe('Spec: description');
    expect(fieldLabel('tax_id_enc')).toBe('Tax id');
    expect(formatAuditValue(null)).toBe('—');
    expect(formatAuditValue(true)).toBe('true');
    expect(formatAuditValue({ a: 1 })).toBe('{"a":1}');
    expect(formatAuditValue('y'.repeat(200))).toHaveLength(120);
    expect(humanize('bank_feed.account_linked')).toBe('Bank feed: account linked');
  });

  it('groups the rows one save wrote: same time, same person', () => {
    const at = '2026-11-21T10:00:00.000Z';
    const groups = groupAuditEntries([
      entry({ id: '5', at }),
      entry({ id: '4', at, action: 'journal_entry.insert', subjectType: 'journal_entry' }),
      entry({ id: '3', at, actorUserId: 'u2' }),
      entry({ id: '2', at: '2026-11-21T09:00:00.000Z' }),
      entry({ id: '1', at: '2026-11-21T09:00:00.000Z', actorType: 'worker' }),
    ]);
    expect(groups.map((g) => g.entries.map((e) => e.id))).toEqual([['5', '4'], ['3'], ['2'], ['1']]);
    expect(groups.map((g) => g.key)).toEqual(['5', '3', '2', '1']);
    expect(groupAuditEntries([])).toEqual([]);
  });
});

describe('staff log in words (OPS-01)', () => {
  it('names what staff did', () => {
    expect(staffActionText('plan.give', t)).toBe('Gave a workspace a plan');
    expect(staffActionText('support.view', t)).toBe('Opened a workspace with support access');
    expect(staffActionText('something.new', t)).toBe('Something: new');
  });
});

describe('who sees the audit log', () => {
  it('is in Settings → Data for owners and admins only', () => {
    const tabsOf = (role: string) => settingsGroupsFor(role).flatMap((g) => g.tabs);
    expect(tabsOf('owner')).toContain('audit-log');
    expect(tabsOf('admin')).toContain('audit-log');
    for (const role of ['partner', 'viewer', 'accountant', 'member'])
      expect(tabsOf(role)).not.toContain('audit-log');
    expect(settingsTabOf('audit-log', 'admin')).toBe('audit-log');
    expect(settingsTabOf('audit-log', 'partner')).toBe('profile');
    expect(settingsGroupsFor('owner').find((g) => g.tabs.includes('audit-log'))?.key).toBe('data');
  });
});
