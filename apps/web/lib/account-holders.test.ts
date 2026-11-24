import { describe, expect, it } from 'vitest';
import { accountNumberInput, canManageAccountNumber, holdersToSave } from './account-holders';

// An account's holders (ACC-15) and its full number (ACC-16). The shaping itself is tested in @montra/domain.
describe('the full account number on the web', () => {
  it('is typed in, shown and removed by owners and admins', () => {
    expect(canManageAccountNumber('owner')).toBe(true);
    expect(canManageAccountNumber('admin')).toBe(true);
    for (const role of ['partner', 'member', 'viewer', 'accountant'] as const)
      expect(canManageAccountNumber(role), role).toBe(false);
    expect(canManageAccountNumber(undefined)).toBe(false);
    expect(canManageAccountNumber(null)).toBe(false);
  });

  it('uses the shared shaping', () => {
    expect(accountNumberInput('0012-3456 7890 4321')).toBe('0012345678904321');
    expect(holdersToSave([{ name: '', memberId: 'm-1' }])).toEqual([{ memberId: 'm-1' }]);
  });
});
