import { describe, expect, it } from 'vitest';
import { catalogs } from '@montra/i18n';
import { MissingFileDto } from '@montra/schemas';
import type { MissingFileDto as MissingFile } from '@montra/api-client';
import { MISSING_FILE_USES, missingFileUses, providedAgainKey } from './missing-files';
import { vaultCounts, vaultBadge, vaultOpenProblemKey, VAULT_OPEN_PROBLEMS } from './vault';

// Review → "Files to provide again" (ADR-0054 §5a, PR 5b).
const en = catalogs.en!;
const missing = (over: Partial<MissingFile> = {}): MissingFile => ({
  fileId: '00000000-0000-4000-8000-000000000001',
  fileName: 'Grocer.png',
  group: 'receipts',
  uploadedAt: '2026-03-14T10:00:00.000Z',
  missingSince: '2026-11-17T10:00:00.000Z',
  reason: 'Family Document Vault didn’t give this file back to Montra.',
  usedBy: [{ kind: 'receipt', id: '00000000-0000-4000-8000-000000000002', label: 'Grocer · 2026-03-14' }],
  ...over,
});

describe('files to provide again', () => {
  it('keeps its fixture in step with the API’s DTO', () => {
    expect(MissingFileDto.parse(missing())).toEqual(missing());
  });

  it('says what uses each file, else its group', () => {
    expect(missingFileUses(missing())).toEqual([
      { key: 'missing_files.used_by.receipt', label: 'Grocer · 2026-03-14' },
    ]);
    expect(missingFileUses(missing({ usedBy: [] }))).toEqual([{ key: 'vault.group.receipts', label: null }]);
    expect(missingFileUses(missing({ usedBy: [], group: null }))).toEqual([]);
    expect(
      missingFileUses(missing({ usedBy: [{ kind: 'lease', id: missing().fileId, label: '' }] })),
    ).toEqual([{ key: 'missing_files.used_by.lease', label: null }]);
  });

  it('says whether the file came back the same, and whether it goes to the vault again', () => {
    expect(providedAgainKey({ hashChanged: false, queuedForVault: false })).toBe('missing_files.done');
    expect(providedAgainKey({ hashChanged: false, queuedForVault: true })).toBe('missing_files.done_sent');
    expect(providedAgainKey({ hashChanged: true, queuedForVault: false })).toBe('missing_files.done_changed');
    expect(providedAgainKey({ hashChanged: true, queuedForVault: true })).toBe(
      'missing_files.done_changed_sent',
    );
  });

  it('has every message it and the vault’s new words use', () => {
    const keys = [
      ...MISSING_FILE_USES.map((k) => `missing_files.used_by.${k}`),
      'missing_files.done',
      'missing_files.done_sent',
      'missing_files.done_changed',
      'missing_files.done_changed_sent',
      ...VAULT_OPEN_PROBLEMS.map(vaultOpenProblemKey),
      ...vaultCounts({
        items: { queued: 1, pending: 0, received: 1, filed: 1, notKept: 1, failed: 1, outOfReach: 1 },
        files: { onlyInVault: 1, missing: 1 },
      } as never).map((c) => c.key),
      vaultBadge({
        fileId: missing().fileId,
        location: 'vault',
        missing: { since: missing().missingSince, reason: 'x' },
        vault: null,
      })!.key,
      'vault.badge_only_in_vault',
    ];
    expect(keys.filter((k) => !(k in en))).toEqual([]);
    for (const k of keys.filter((k) => k.startsWith('missing_files.done'))) expect(en[k]).toContain('{name}');
  });
});
