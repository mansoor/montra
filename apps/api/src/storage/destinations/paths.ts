/** Folder layout and readable names in someone's storage (ADR-0030 §4). Pure, so it's tested on its own. */
import type { StorageFileKind } from '@montra/schemas';

export const KIND_FOLDERS: Record<StorageFileKind, string> = {
  statement: 'statements',
  receipt: 'receipts',
  payslip: 'payslips',
  lease: 'leases',
  invoice: 'invoices',
  other: 'other',
};

const EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/heic': 'heic',
  'image/heif': 'heif',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/tiff': 'tif',
  'application/pdf': 'pdf',
  'text/csv': 'csv',
  'text/plain': 'txt',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/x-ofx': 'ofx',
  'application/x-qif': 'qif',
  'application/zip': 'zip',
};

const NAME_MAX = 120;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i;

/** A name every desktop and S3 can hold: no separators or characters Windows refuses, no control characters, not too long. */
export function cleanName(raw: string, max = NAME_MAX): string {
  let s = raw
    .normalize('NFC')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '');
  if (s.length > max) s = s.slice(0, max).trim();
  if (!s || /^\.+$/.test(s)) s = 'file';
  if (WINDOWS_RESERVED.test(s)) s = `_${s}`;
  return s;
}

/** Splits off an extension that looks like one, otherwise takes it from the MIME type. */
export function splitName(fileName: string, mime: string): { stem: string; ext: string } {
  const m = /^(.*)\.([A-Za-z0-9]{1,8})$/.exec(fileName.trim());
  if (m && m[1]) return { stem: m[1], ext: m[2]!.toLowerCase() };
  return { stem: fileName, ext: EXTENSIONS[mime.split(';')[0]!.trim().toLowerCase()] ?? 'bin' };
}

/** The last 8 hex digits of an id. Montra's ids are UUIDv7, whose first digits are a timestamp and repeat within a minute. */
export const shortId = (id: string) => id.replace(/-/g, '').slice(-8);

/** `Montra/<workspace>` by default. */
export function defaultFolder(workspaceName: string): string {
  return `Montra/${cleanName(workspaceName, 80)}`;
}

/** `<folder>/receipts/2026/2026-11-10 Costco receipt (9c41d07e).jpg` */
export function filePath(
  folder: string,
  file: { id: string; kind: string; file_name: string; mime: string; created_at: Date },
): string {
  const kindFolder = KIND_FOLDERS[file.kind as StorageFileKind] ?? 'other';
  const day = file.created_at.toISOString().slice(0, 10);
  const { stem, ext } = splitName(file.file_name, file.mime);
  const name = `${day} ${cleanName(stem, NAME_MAX - 24)} (${shortId(file.id)}).${ext}`;
  return `${folder}/${kindFolder}/${day.slice(0, 4)}/${name}`;
}

/** `<folder>/backups/Smith household-backup-2026-11-10 (5b2f81aa).zip` */
export function backupPath(folder: string, fileName: string, exportId: string): string {
  const { stem, ext } = splitName(fileName, 'application/zip');
  return `${folder}/backups/${cleanName(stem, NAME_MAX - 24)} (${shortId(exportId)}).${ext}`;
}
