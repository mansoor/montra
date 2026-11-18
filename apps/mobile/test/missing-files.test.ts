import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { catalogs } from '@montra/i18n';
import { MissingFileDto, type MissingFileDto as MissingFile } from '@montra/schemas';
import { createApi } from '../src/api/client';
import {
  MISSING_FILE_TYPES,
  missingFilesFor,
  missingFileUses,
  possibleDuplicate,
  providedAgainMessage,
  showsMissingFiles,
} from '../src/features/missing-files';
import { reviewBadge } from '../src/features/tax-forms';

// Review → "Files to provide again" on the phone (ADR-0054 §5a, VLT-10; PR 5b): the list, its words, the badge and the
// calls. Pure: the server decides who sees which file.
const en = catalogs.en!;
const missing = (over: Partial<MissingFile> = {}): MissingFile => ({
  fileId: '00000000-0000-4000-8000-000000000001',
  fileName: 'Grocer.png',
  group: 'receipts',
  uploadedAt: '2026-03-14T10:00:00.000Z',
  missingSince: '2026-11-17T10:00:00.000Z',
  reason: 'Family Document Vault didn’t give this file back to Montra.',
  usedBy: [{ kind: 'payslip', id: '00000000-0000-4000-8000-000000000002', label: 'Acme · 2026-03-14' }],
  ...over,
});

describe('files to provide again', () => {
  it('uses the API’s own shape', () => {
    expect(MissingFileDto.parse(missing())).toEqual(missing());
  });

  it('is for everyone but a viewer', () => {
    expect(showsMissingFiles('viewer')).toBe(false);
    for (const role of ['owner', 'admin', 'partner', 'accountant', 'member'] as const)
      expect(showsMissingFiles(role), role).toBe(true);
  });

  it('says what uses each file, else its group', () => {
    expect(missingFileUses(missing())).toEqual([
      { key: 'missing_files.used_by.payslip', label: 'Acme · 2026-03-14' },
    ]);
    expect(missingFileUses(missing({ usedBy: [], group: 'tax_documents' }))).toEqual([
      { key: 'vault.group.tax_documents', label: null },
    ]);
    expect(missingFileUses(missing({ usedBy: [], group: null }))).toEqual([]);
  });

  it('says whether the file came back the same, and whether it goes to the vault again', () => {
    expect(providedAgainMessage({ hashChanged: false, queuedForVault: true }, 'a.png')).toEqual({
      key: 'missing_files.done_sent',
      values: { name: 'a.png' },
    });
    expect(providedAgainMessage({ hashChanged: true, queuedForVault: false }, 'a.png').key).toBe(
      'missing_files.done_changed',
    );
  });

  it('offers the types a paper may be', () => {
    expect(Object.keys(MISSING_FILE_TYPES).sort()).toEqual([
      'application/pdf',
      'image/jpeg',
      'image/png',
      'image/webp',
    ]);
  });
});

describe('the Review badge counts files to provide again', () => {
  it('adds them to the transactions and tax forms, ignoring a count not loaded', () => {
    expect(reviewBadge(3, 2, 4)).toBe(9);
    expect(reviewBadge(3, null, 4)).toBe(7);
    expect(reviewBadge(3, 2, null)).toBe(5);
    expect(reviewBadge(3, 2)).toBe(5);
  });

  it('keeps one counter per login and workspace', async () => {
    const a = missingFilesFor('u1:w1');
    expect(missingFilesFor('u1:w1')).toBe(a);
    expect(missingFilesFor('u1:w2')).not.toBe(a);
    await a.refresh(async () => 2, true);
    expect(a.get()).toBe(2);
  });
});

describe('the API calls', () => {
  it('lists and uploads at the web’s endpoints, the upload as FormData', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const f = (async (url: string, init: RequestInit = {}) => {
      calls.push({ url, init });
      const body = init.method === 'GET' ? { data: [missing()] } : { fileId: missing().fileId };
      return new Response(JSON.stringify(body), { status: 200 });
    }) as unknown as typeof fetch;
    const api = createApi({ baseUrl: 'http://api', token: async () => 'dev:a@b.co', fetch: f });
    expect((await api.listMissingFiles('w1')).map((x) => x.fileName)).toEqual(['Grocer.png']);
    await api.provideMissingFile('w1', missing().fileId, {
      uri: 'file:///cache/again.pdf',
      name: 'again.pdf',
      type: 'application/pdf',
    });
    // "Upload anyway", after the possible-duplicate warning.
    await api.provideMissingFile(
      'w1',
      missing().fileId,
      { uri: 'file:///cache/again.pdf', name: 'again.pdf', type: 'application/pdf' },
      true,
    );
    expect(calls.map((c) => [c.init.method, c.url])).toEqual([
      ['GET', 'http://api/v1/workspaces/w1/missing-files'],
      ['POST', `http://api/v1/workspaces/w1/missing-files/${missing().fileId}`],
      ['POST', `http://api/v1/workspaces/w1/missing-files/${missing().fileId}?anyway=true`],
    ]);
    expect(calls[1]!.init.body).toBeInstanceOf(FormData);
  });
});

describe('the words the list uses', () => {
  it('are all in the catalog', () => {
    const root = join(__dirname, '..');
    const text = ['src/ui/MissingFiles.tsx', 'app/review.tsx']
      .map((p) => readFileSync(join(root, p), 'utf8'))
      .join('\n');
    const keys = [...text.matchAll(/\bt\(\s*'([a-z0-9_.]+)'/g)].map((m) => m[1]!);
    expect(keys.length).toBeGreaterThan(5);
    const dynamic = [
      ...(['receipt', 'statement', 'payslip', 'tax_form', 'bill', 'lease', 'document'] as const).map(
        (k) => `missing_files.used_by.${k}`,
      ),
      'missing_files.done',
      'missing_files.done_sent',
      'missing_files.done_changed',
      'missing_files.done_changed_sent',
    ];
    expect([...keys, ...dynamic].filter((k) => !(k in en))).toEqual([]);
  });
});

describe('a possible duplicate (the owner’s clarification, 2026-11-18)', () => {
  it('knows the API’s warning, with its words, and nothing else', () => {
    expect(
      possibleDuplicate({ status: 409, code: 'file.possible_duplicate', message: 'This looks like a duplicate.' }),
    ).toBe('This looks like a duplicate.');
    expect(possibleDuplicate({ status: 409, code: 'file.not_missing', message: 'x' })).toBeNull();
    expect(possibleDuplicate(new Error('offline'))).toBeNull();
    expect(possibleDuplicate(null)).toBeNull();
    for (const k of ['files.duplicate_anyway_confirm', 'missing_files.duplicate_cancelled', 'common.cancel'])
      expect(k in en, k).toBe(true);
  });
});
