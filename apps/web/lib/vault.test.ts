import { describe, expect, it } from 'vitest';
import {
  VaultConnectionDto as VaultConnectionSchema,
  VAULT_GROUP_DEFAULTS,
  VAULT_GROUPS,
} from '@montra/schemas';
import type { VaultConnectionDto } from '@montra/api-client';
import {
  canManageVault,
  canSeeVault,
  cleanPastedCode,
  clockIsOff,
  vaultHost,
  vaultStatusLine,
  vaultStep,
  vaultTone,
} from './vault';

// The Family Document Vault card in Settings → Storage (ADR-0054 §2, §13).
const connection = (over: Partial<VaultConnectionDto> = {}): VaultConnectionDto => ({
  id: '00000000-0000-4000-8000-000000000001',
  stage: 'connected',
  status: 'active',
  address: 'https://vault.example.com',
  householdName: 'The Smiths',
  publicKey: 'ed25519:Bm0rbJ7Q8V3d8w7c2b1aXyZ0123456789abcdefghij',
  fingerprint: 'ce2d 6777 0439 61a5 d947 31bb 086a 4fb4',
  newKey: null,
  actingAs: 'Sam',
  groups: VAULT_GROUPS.map((group) => ({ group, mode: VAULT_GROUP_DEFAULTS[group], vaultKind: null })),
  vaultKinds: [{ key: 'utility_bill', name: 'Utility / bill' }],
  describeMore: false,
  deleteWithMontra: false,
  canDelete: false,
  items: { queued: 0, pending: 0, received: 0, filed: 0, notKept: 0, failed: 0, outOfReach: 0 },
  heldUntil: { sending: null, reading: null },
  clockOffsetMs: 120,
  keyRotation: 'none',
  lastSuccessAt: '2026-11-17T10:00:00.000Z',
  lastError: null,
  lastErrorAt: null,
  createdAt: '2026-11-17T09:00:00.000Z',
  version: 3,
  ...over,
});

describe('who sees the vault card', () => {
  it('shows it to owners and admins whose plan has the vault, and lets only an owner change it', () => {
    expect(canSeeVault('owner', ['ownStorage', 'familyVault'])).toBe(true);
    expect(canSeeVault('admin', ['familyVault'])).toBe(true);
    expect(canSeeVault('owner', ['ownStorage'])).toBe(false);
    for (const role of ['partner', 'viewer', 'accountant', 'member'] as const) {
      expect(canSeeVault(role, ['familyVault']), role).toBe(false);
    }
    expect(canManageVault('owner')).toBe(true);
    expect(canManageVault('admin')).toBe(false);
  });
});

describe('vaultStep and vaultStatusLine', () => {
  it('walks the three steps of connecting', () => {
    expect(vaultStep(null)).toBe('start');
    expect(vaultStep(connection({ stage: 'register', status: 'needs_vault', householdName: null }))).toBe(
      'register',
    );
    expect(vaultStatusLine(connection({ stage: 'register', status: 'needs_vault' }))).toEqual({
      key: 'vault.status_register',
    });
    expect(vaultStatusLine(connection({ stage: 'approval', status: 'needs_vault' }))).toEqual({
      key: 'vault.status_approval',
      values: { name: 'The Smiths' },
    });
    expect(vaultStatusLine(connection({ stage: 'approval', householdName: null })).key).toBe(
      'vault.status_approval_unnamed',
    );
    expect(vaultStatusLine(connection())).toEqual({
      key: 'vault.status_connected',
      values: { name: 'The Smiths' },
    });
  });

  it('says when the connection needs someone, is failing or is paused', () => {
    expect(vaultStatusLine(connection({ status: 'needs_vault' })).key).toBe('vault.status_needs_vault');
    expect(vaultStatusLine(connection({ status: 'failing' })).key).toBe('vault.status_failing');
    expect(vaultStatusLine(connection({ status: 'paused' })).key).toBe('vault.status_paused');
    expect(vaultTone(connection())).toBe('good');
    expect(vaultTone(connection({ status: 'needs_vault' }))).toBe('bad');
    expect(vaultTone(connection({ status: 'paused' }))).toBe('muted');
    expect(vaultTone(connection({ stage: 'approval', status: 'needs_vault' }))).toBe('muted');
  });
});

describe('small helpers', () => {
  it('shows the vault’s host, warns about a clock that is off, and cleans a pasted code', () => {
    expect(vaultHost('https://vault.example.com:8443')).toBe('vault.example.com:8443');
    expect(vaultHost(null)).toBe('');
    expect(clockIsOff(null)).toBe(false);
    expect(clockIsOff(30_000)).toBe(false);
    expect(clockIsOff(-180_000)).toBe(true);
    expect(cleanPastedCode('  fdvapp1.eyJ1\ncmwi OiJ \r\n')).toBe('fdvapp1.eyJ1cmwiOiJ');
  });

  it('keeps its fixture in step with the API’s DTO, which never carries a private key', () => {
    expect(VaultConnectionSchema.parse(connection())).toEqual(connection());
    expect(Object.keys(connection())).not.toContain('privateKey');
  });
});
