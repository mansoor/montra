import { describe, expect, it } from 'vitest';
import { checkPassword, DEFAULT_POLICY, normalizePolicy, personalWords, strengthOf } from '../src/index.js';

describe('strength (AUTH-02)', () => {
  it('scores long but common passwords low, and random passphrases high', () => {
    expect(strengthOf('password1234').score).toBeLessThan(2);
    expect(strengthOf('qwertyuiop123').score).toBeLessThan(2);
    expect(strengthOf('violet-tractor-mango-ledger-91').score).toBe(4);
    expect(strengthOf('password1234').warning).toBeTruthy();
  });

  it('marks down a password built from the person’s own email or name', () => {
    const words = personalWords({ email: 'avery.testperson@example.test', name: 'Avery Testperson' });
    expect(words).toEqual(
      expect.arrayContaining(['montra', 'avery', 'testperson', 'avery.testperson@example.test']),
    );
    const pw = 'testpersonavery2026';
    expect(strengthOf(pw, words).score).toBeLessThan(strengthOf(pw).score);
  });
});

describe('the policy', () => {
  it('rejects short and weak passwords, saying which', () => {
    expect(checkPassword('Tr0ub4dor&3', DEFAULT_POLICY).problems).toContain('too_short');
    expect(checkPassword('password12345678', DEFAULT_POLICY).problems).toEqual(['too_weak']);
    const ok = checkPassword('violet-tractor-mango-ledger-91', DEFAULT_POLICY);
    expect(ok).toMatchObject({ ok: true, problems: [], length: 30 });
    expect(checkPassword('violet-tractor-mango-ledger-91', { minLength: 32, minScore: 3 }).problems).toEqual([
      'too_short',
    ]);
  });

  it('counts characters as people see them', () => {
    expect(checkPassword('🔑'.repeat(12), { minLength: 12, minScore: 0 }).length).toBe(12);
  });

  it('keeps a stored policy within its limits', () => {
    expect(normalizePolicy({ minLength: '8', minScore: '9' })).toEqual({ minLength: 12, minScore: 4 });
    expect(normalizePolicy({ minLength: 200, minScore: -1 })).toEqual({ minLength: 64, minScore: 0 });
    expect(normalizePolicy({ minLength: 'x' })).toEqual(DEFAULT_POLICY);
    expect(normalizePolicy({ minLength: 16, minScore: 2 })).toEqual({ minLength: 16, minScore: 2 });
  });
});
