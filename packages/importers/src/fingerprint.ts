import { createHash } from 'node:crypto';
import type { FileType } from './decode.js';

/**
 * File-shape fingerprint for reusing import profiles (IMP-04): file type, normalized header tokens and
 * column count. Headerless files use the column count and the shape of the first data row.
 */
export function fingerprint(
  fileType: FileType,
  header: string[] | null,
  width: number,
  firstRow?: string[],
): string {
  const tokens = header
    ? header.map((h) =>
        h
          .toLowerCase()
          .normalize('NFKD')
          .replace(/[^a-z0-9]/g, ''),
      )
    : (firstRow ?? []).map((c) => (/^\d/.test(c) ? (/[.,]\d{2}$/.test(c) ? 'n' : 'd') : c ? 't' : '_'));
  return createHash('sha256')
    .update(`${fileType === 'xls' ? 'xlsx' : fileType}|${header ? 'h' : 'nh'}|${width}|${tokens.join(',')}`)
    .digest('hex')
    .slice(0, 32);
}
