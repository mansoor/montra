import { decodeText } from './decode.js';
import { parseDelimited, type Sheet } from './grid.js';
import { readOfx } from './ofx.js';
import { readQif } from './qif.js';

/** Reads a text statement (CSV/TSV, QIF or OFX/QFX) into its sheets. Throws when an OFX file has no `<OFX>`. */
export function readTextSheets(fileType: 'csv' | 'qif' | 'ofx', bytes: Uint8Array): Sheet[] {
  const { text } = decodeText(bytes);
  if (fileType === 'qif') return [readQif(text)];
  if (fileType === 'ofx') return [readOfx(text)];
  return [parseDelimited(text)];
}
