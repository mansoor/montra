import { describe, expect, it } from 'vitest';
import { VaultError, type VaultErrorCode } from '../src/storage/destinations/index.js';

// The vault's side of the destination port (ADR-0054 §12): how each failure is handled, before any adapter exists.
describe('VaultError (ADR-0054 §12)', () => {
  const all: VaultErrorCode[] = [
    'retry_later',
    'send_cap',
    'read_cap',
    'connection',
    'identity_changed',
    'hash_mismatch',
    'unavailable',
    'unreachable',
    'not_allowed_host',
    'refused',
    'failed',
    'invalid_code',
    'old_code',
    'secret_needed',
    'invalid_key',
    'other_app',
    'not_a_vault',
    'key_revoked',
    'key_expired',
    'key_invalid',
    'key_signed',
    'not_permitted',
  ];

  it('holds for the daily caps without counting them as failures', () => {
    for (const code of all) {
      expect(new VaultError(code).countsAsFailure, code).toBe(code !== 'send_cap' && code !== 'read_cap');
    }
  });

  it('stops the whole connection for a connection problem, a different vault or a key that no longer works', () => {
    expect(all.filter((code) => new VaultError(code).stopsConnection)).toEqual([
      'connection',
      'identity_changed',
      'key_revoked',
      'key_expired',
      'key_invalid',
      'key_signed',
    ]);
    // A key that lacks a permission stops the connection only when it may not send.
    expect(new VaultError('not_permitted', { permission: 'documents.send' }).stopsConnection).toBe(true);
    expect(new VaultError('not_permitted', { permission: 'documents.delete' }).stopsConnection).toBe(false);
  });

  it('says why a key needs replacing, for the key problems only', () => {
    expect(all.filter((code) => new VaultError(code).keyProblem !== null)).toEqual([
      'key_revoked',
      'key_expired',
      'key_invalid',
      'key_signed',
    ]);
    expect(new VaultError('key_signed').keyProblem).toBe('signed');
  });

  it('tries again on its own only after a wait, a server failure or a dropped connection', () => {
    expect(all.filter((code) => new VaultError(code).retryable)).toEqual([
      'retry_later',
      'unreachable',
      'failed',
    ]);
  });

  it('shows the vault’s own words for a connection problem, and Montra’s otherwise, never the detail', () => {
    const e = new VaultError('connection', {
      vaultMessage: 'Montra is paused in the vault.',
      detail: 'trace',
    });
    expect(e.shown).toBe('Montra is paused in the vault.');
    expect(new VaultError('connection').shown).toBe(e.message);
    const refused = new VaultError('refused', { vaultMessage: 'ignored here', detail: 'trace' });
    expect(refused.shown).toBe(refused.message);
    for (const code of all) expect(new VaultError(code, { detail: 'trace' }).message).not.toContain('trace');
  });
});
