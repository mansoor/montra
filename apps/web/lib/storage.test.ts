import { describe, expect, it } from 'vitest';
import type { StorageDestinationDto } from '@montra/api-client';
import { emptyConnection, hasSecret, storageSummary, storageWhere, toConnection } from './storage';

// The workspace's own storage settings (ADR-0030).
const destination = (over: Partial<StorageDestinationDto> = {}): StorageDestinationDto => ({
  id: '00000000-0000-4000-8000-000000000001',
  kind: 's3',
  label: 'Backblaze',
  s3: {
    endpoint: 'https://s3.us-west-004.backblazeb2.com',
    region: 'us-west-004',
    bucket: 'family-files',
    pathStyle: true,
    accessKeyHint: '0001',
  },
  webdav: null,
  folder: 'Montra/Home',
  mirrorFiles: true,
  fileKinds: ['statement', 'receipt', 'payslip', 'lease', 'invoice', 'other'],
  deleteWithMontra: false,
  keepBackups: 12,
  canDelete: true,
  status: 'active',
  lastSuccessAt: '2026-11-10T10:00:00.000Z',
  lastError: null,
  lastErrorAt: null,
  files: { pending: 0, done: 4, failed: 0, skipped: 0 },
  lastBackup: null,
  createdAt: '2026-11-01T10:00:00.000Z',
  version: 3,
  ...over,
});

describe('toConnection', () => {
  it('sends S3 settings, and the secret only when both halves are there', () => {
    const f = { ...emptyConnection(), bucket: ' Family-Files ', accessKeyId: 'AKIA1', secretAccessKey: '' };
    expect(toConnection(f)).toEqual({
      kind: 's3',
      s3: { region: 'us-east-1', bucket: 'family-files', pathStyle: false },
    });
    expect(hasSecret(f)).toBe(false);
    const full = { ...f, secretAccessKey: 's', endpoint: 'https://s3.example.com ' };
    expect(toConnection(full)).toMatchObject({
      s3: { endpoint: 'https://s3.example.com' },
      secret: { accessKeyId: 'AKIA1', secretAccessKey: 's' },
    });
    expect(hasSecret(full)).toBe(true);
    expect(toConnection(emptyConnection())).toBeNull();
  });

  it('sends WebDAV settings, keeping the saved password when it’s left blank', () => {
    const f = {
      ...emptyConnection(),
      kind: 'webdav' as const,
      url: 'https://cloud.example.com/dav/',
      username: 'sam',
    };
    expect(toConnection(f)).toEqual({
      kind: 'webdav',
      webdav: { url: 'https://cloud.example.com/dav/', username: 'sam' },
    });
    expect(toConnection({ ...f, password: 'p' })).toMatchObject({ secret: { password: 'p' } });
    expect(toConnection({ ...f, username: '' })).toBeNull();
  });

  it('starts a change from what’s saved, never with a secret', () => {
    const f = emptyConnection(destination());
    expect(f).toMatchObject({
      kind: 's3',
      bucket: 'family-files',
      pathStyle: true,
      accessKeyId: '',
      secretAccessKey: '',
    });
  });
});

describe('storageSummary and storageWhere', () => {
  it('says what matters most first', () => {
    expect(storageSummary(destination({ status: 'failing' })).key).toBe('storage.summary_failing');
    expect(storageSummary(destination({ files: { pending: 2, done: 4, failed: 0, skipped: 0 } }))).toEqual({
      key: 'storage.summary_copying',
      values: { n: 2 },
    });
    expect(storageSummary(destination())).toEqual({ key: 'storage.summary_ok', values: { n: 4 } });
  });

  it('shows the bucket and host, then the folder', () => {
    expect(storageWhere(destination())).toBe('family-files · s3.us-west-004.backblazeb2.com / Montra/Home');
    expect(
      storageWhere(
        destination({
          kind: 'webdav',
          s3: null,
          webdav: { url: 'https://nas.example.com/dav/', username: 'sam' },
        }),
      ),
    ).toBe('nas.example.com / Montra/Home');
  });
});
