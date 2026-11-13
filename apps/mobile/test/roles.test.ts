import { describe, expect, it } from 'vitest';
import type { MemberRole } from '@montra/schemas';
import { abilitiesOf, canChangeOn } from '../src/features/roles';

// AUTH-18: the phone shows each role what the API lets it do (AUTH-14..17).
const books = [
  { id: 'P', access: 'write' as const },
  { id: 'B', access: 'write' as const },
];
const as = (role: MemberRole, entities: { id: string; access?: 'read' | 'write' }[] = books) =>
  abilitiesOf({ role, entities });

describe('abilitiesOf', () => {
  it('lets owners and admins do everything', () => {
    for (const role of ['owner', 'admin'] as const)
      expect(as(role)).toMatchObject({ record: true, setUp: true, importFiles: true, backUp: true });
  });

  it('lets a partner set up and import, but not back up the workspace', () => {
    expect(as('partner')).toMatchObject({ record: true, setUp: true, importFiles: true, backUp: false });
  });

  it('keeps a member to recording money', () => {
    expect(as('member')).toMatchObject({ record: true, setUp: false, importFiles: false, backUp: false });
  });

  it('gives a viewer nothing to change', () => {
    const v = as('viewer', [{ id: 'P', access: 'read' }]);
    expect(v).toMatchObject({ record: false, setUp: false, importFiles: false, backUp: false });
    expect(v.writes('P')).toBe(false);
  });

  it('follows each book’s access', () => {
    const a = as('accountant', [
      { id: 'P', access: 'read' },
      { id: 'B', access: 'write' },
    ]);
    expect(a.record).toBe(true);
    expect(a.writes('B')).toBe(true);
    expect(a.writes('P')).toBe(false);
    // Only read-only books: nothing to record anywhere.
    expect(as('partner', [{ id: 'B', access: 'read' }])).toMatchObject({ record: false, importFiles: false });
  });

  it('leaves a workspace cached before access was sent to the server', () => {
    const old = as('partner', [{ id: 'P' }]);
    expect(old.record).toBe(true);
    expect(old.writes('P')).toBe(true);
  });

  it('decides a transaction by its account’s books', () => {
    const a = as('accountant', [
      { id: 'P', access: 'read' },
      { id: 'B', access: 'write' },
    ]);
    const accounts = [
      { id: 'home', entityId: 'P' },
      { id: 'shop', entityId: 'B' },
    ];
    expect(canChangeOn(a, accounts, 'shop')).toBe(true);
    expect(canChangeOn(a, accounts, 'home')).toBe(false);
    expect(canChangeOn(as('viewer'), accounts, 'shop')).toBe(false);
  });
});
