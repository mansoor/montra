/**
 * Byte → text decoding for statement files. Banks still ship Windows-1252 and UTF-16 ("Unicode text" from
 * Excel), so the encoding is sniffed: BOM first, then strict UTF-8, then Windows-1252 as the fallback.
 */
export type TextEncodingName = 'utf-8' | 'utf-16le' | 'utf-16be' | 'windows-1252';

export interface DecodedText {
  text: string;
  encoding: TextEncodingName;
}

export function decodeText(bytes: Uint8Array): DecodedText {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { text: new TextDecoder('utf-8').decode(bytes.subarray(3)), encoding: 'utf-8' };
  }
  if (bytes[0] === 0xff && bytes[1] === 0xfe)
    return { text: new TextDecoder('utf-16le').decode(bytes.subarray(2)), encoding: 'utf-16le' };
  if (bytes[0] === 0xfe && bytes[1] === 0xff)
    return { text: new TextDecoder('utf-16be').decode(bytes.subarray(2)), encoding: 'utf-16be' };
  // UTF-16 without BOM: every other byte is NUL for ASCII-heavy text.
  const sample = bytes.subarray(0, 400);
  let nulOdd = 0;
  let nulEven = 0;
  for (let i = 0; i < sample.length; i++) {
    if (sample[i] !== 0) continue;
    if (i % 2) nulOdd++;
    else nulEven++;
  }
  if (sample.length > 20 && nulOdd > sample.length / 4)
    return { text: new TextDecoder('utf-16le').decode(bytes), encoding: 'utf-16le' };
  if (sample.length > 20 && nulEven > sample.length / 4)
    return { text: new TextDecoder('utf-16be').decode(bytes), encoding: 'utf-16be' };
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), encoding: 'utf-8' };
  } catch {
    return { text: new TextDecoder('windows-1252').decode(bytes), encoding: 'windows-1252' };
  }
}

export type FileType = 'csv' | 'xlsx' | 'xls' | 'pdf';

/** Detects the file type from magic bytes, falling back to the extension for text files. */
export function detectFileType(bytes: Uint8Array, fileName: string): FileType | null {
  const head = [...bytes.subarray(0, 8)];
  const is = (sig: number[]) => sig.every((b, i) => head[i] === b);
  if (is([0x25, 0x50, 0x44, 0x46])) return 'pdf'; // %PDF
  if (is([0x50, 0x4b, 0x03, 0x04]))
    return /\.xlsx$/i.test(fileName) || !/\.(docx|zip)$/i.test(fileName) ? 'xlsx' : null;
  if (is([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) return 'xls'; // OLE2 compound file
  if (/\.(csv|tsv|txt)$/i.test(fileName)) return 'csv';
  // Unknown extension: accept if it looks like text.
  const sample = bytes.subarray(0, 512);
  const binary = [...sample].filter((b) => b < 9 || (b > 13 && b < 32)).length;
  return binary === 0 ? 'csv' : null;
}
