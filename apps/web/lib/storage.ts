/** The workspace's own storage (ADR-0030): turning the settings form into a request, and its status into words. */
import type { StorageConnectionInput, StorageDestinationDto } from '@montra/api-client';

export interface ConnectionForm {
  kind: 's3' | 'webdav';
  endpoint: string;
  region: string;
  bucket: string;
  pathStyle: boolean;
  accessKeyId: string;
  secretAccessKey: string;
  url: string;
  username: string;
  password: string;
}

export const emptyConnection = (d?: StorageDestinationDto | null): ConnectionForm => ({
  kind: d?.kind ?? 's3',
  endpoint: d?.s3?.endpoint ?? '',
  region: d?.s3?.region ?? 'us-east-1',
  bucket: d?.s3?.bucket ?? '',
  pathStyle: d?.s3?.pathStyle ?? false,
  accessKeyId: '',
  secretAccessKey: '',
  url: d?.webdav?.url ?? '',
  username: d?.webdav?.username ?? '',
  password: '',
});

/**
 * The connection to send. A secret left blank is left out, so a saved one is kept; for S3 both halves are needed together.
 * Returns null when what's there can't make a request yet.
 */
export function toConnection(f: ConnectionForm): StorageConnectionInput | null {
  if (f.kind === 's3') {
    if (!f.bucket.trim()) return null;
    const secret =
      f.accessKeyId.trim() && f.secretAccessKey
        ? { secret: { accessKeyId: f.accessKeyId.trim(), secretAccessKey: f.secretAccessKey } }
        : {};
    return {
      kind: 's3',
      s3: {
        ...(f.endpoint.trim() ? { endpoint: f.endpoint.trim() } : {}),
        region: f.region.trim() || 'us-east-1',
        bucket: f.bucket.trim().toLowerCase(),
        pathStyle: f.pathStyle,
      },
      ...secret,
    };
  }
  if (!f.url.trim() || !f.username.trim()) return null;
  return {
    kind: 'webdav',
    webdav: { url: f.url.trim(), username: f.username.trim() },
    ...(f.password ? { secret: { password: f.password } } : {}),
  };
}

export const hasSecret = (f: ConnectionForm) =>
  f.kind === 's3' ? Boolean(f.accessKeyId.trim() && f.secretAccessKey) : Boolean(f.password);

/** One line on how copying is going, as an i18n key and its values. */
export function storageSummary(d: StorageDestinationDto): { key: string; values?: Record<string, number> } {
  if (d.status === 'paused') return { key: 'storage.summary_paused' };
  if (d.status === 'failing') return { key: 'storage.summary_failing' };
  if (d.files.pending > 0) return { key: 'storage.summary_copying', values: { n: d.files.pending } };
  if (d.files.failed > 0) return { key: 'storage.summary_failed', values: { n: d.files.failed } };
  return { key: 'storage.summary_ok', values: { n: d.files.done } };
}

/** Where things go, as shown to the owner: the bucket or the server, then the folder. */
export function storageWhere(d: StorageDestinationDto): string {
  const place = d.s3
    ? `${d.s3.bucket}${d.s3.endpoint ? ` · ${new URL(d.s3.endpoint).host}` : ''}`
    : d.webdav
      ? new URL(d.webdav.url).host
      : '';
  return `${place} / ${d.folder}`;
}
