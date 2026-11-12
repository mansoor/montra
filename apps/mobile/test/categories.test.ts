import { describe, expect, it } from 'vitest';
import type { CategoryGroupDto } from '@montra/schemas';
import { defaultEntityId, groupChoices, nameTaken, suggestedName } from '../src/features/categories';

const entities = [
  { id: 'biz', type: 'business' as const },
  { id: 'home', type: 'personal' as const },
];
const group = (id: string, kind: CategoryGroupDto['kind'], entityId = 'home'): CategoryGroupDto => ({
  id,
  entityId,
  name: id,
  kind,
});

describe('adding a category on the phone (ACC-11)', () => {
  it('puts it in the books the picker is showing, else Personal', () => {
    expect(defaultEntityId(entities, [{ entityId: 'biz' }, { entityId: 'biz' }])).toBe('biz');
    expect(defaultEntityId(entities, [{ entityId: 'biz' }, { entityId: 'home' }])).toBe('home');
    expect(defaultEntityId(entities, [])).toBe('home');
    expect(defaultEntityId([], [])).toBeNull();
  });

  it('offers the groups for its kind, the usual one first', () => {
    const groups = [
      group('fixed', 'fixed'),
      group('income', 'income'),
      group('daily', 'daily'),
      group('fun', 'fun'),
    ];
    expect(groupChoices(groups, 'personal', 'expense').map((g) => g.id)).toEqual(['daily', 'fixed', 'fun']);
    expect(groupChoices(groups, 'personal', 'income').map((g) => g.id)).toEqual(['income']);
    expect(
      groupChoices(
        [group('rev', 'income', 'biz'), group('exp', 'business', 'biz')],
        'business',
        'expense',
      ).map((g) => g.id),
    ).toEqual(['exp']);
  });

  it('turns the search text into the name, and spots one already taken', () => {
    expect(suggestedName('  bag   fee ')).toBe('Bag fee');
    expect(suggestedName('   ')).toBe('');
    const cats = [{ entityId: 'home', type: 'expense' as const, name: 'Groceries' }];
    expect(nameTaken(cats, 'home', 'expense', ' groceries ')).toBe(true);
    expect(nameTaken(cats, 'home', 'income', 'Groceries')).toBe(false);
    expect(nameTaken(cats, 'biz', 'expense', 'Groceries')).toBe(false);
  });
});
