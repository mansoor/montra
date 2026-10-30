import Papa from 'papaparse';
import ExcelJS from 'exceljs';

/** A sheet as rows of trimmed strings, exactly as displayed in the file (no type coercion). */
export interface Sheet {
  name: string;
  rows: string[][];
}

const DELIMITERS = [',', ';', '\t', '|'];

/** Parses CSV/TSV text, auto-detecting the delimiter. Quoted fields, embedded newlines and BOMs are handled. */
export function parseDelimited(text: string): Sheet {
  const clean = text.replace(/^\uFEFF/, '');
  const delimiter = detectDelimiter(clean);
  const result = Papa.parse<string[]>(clean, { delimiter, skipEmptyLines: false });
  const rows = result.data.map((r) => r.map((c) => (c ?? '').trim()));
  while (rows.length && rows.at(-1)!.every((c) => c === '')) rows.pop();
  return { name: 'CSV', rows };
}

/** Picks the delimiter that splits the first lines into the most consistent number of columns. */
export function detectDelimiter(text: string): string {
  const lines = text
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .slice(0, 30);
  let best = ',';
  let bestScore = -1;
  for (const d of DELIMITERS) {
    const counts = lines.map((l) => Papa.parse<string[]>(l, { delimiter: d }).data[0]?.length ?? 1);
    const freq = new Map<number, number>();
    counts.forEach((c) => freq.set(c, (freq.get(c) ?? 0) + 1));
    const [mode = 1, modeCount = 0] = [...freq.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0] ?? [];
    // Prefer more columns, consistently; a single column means the delimiter isn't used.
    const score = mode > 1 ? modeCount * 100 + mode : 0;
    if (score > bestScore) {
      best = d;
      bestScore = score;
    }
  }
  return best;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** Reads every worksheet of an XLSX file as display text. Dates become YYYY-MM-DD; numbers keep their format. */
export async function readXlsx(bytes: Uint8Array): Promise<Sheet[]> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
  );
  const sheets: Sheet[] = [];
  workbook.eachSheet((ws) => {
    const rows: string[][] = [];
    const width = ws.actualColumnCount;
    ws.eachRow({ includeEmpty: true }, (row, rowNumber) => {
      const cells: string[] = [];
      for (let c = 1; c <= width; c++) {
        const cell = row.getCell(c);
        const v = cell.value;
        if (v instanceof Date) {
          cells.push(`${v.getUTCFullYear()}-${pad(v.getUTCMonth() + 1)}-${pad(v.getUTCDate())}`);
        } else if (typeof v === 'number') {
          // Stored doubles: 12 significant digits removes binary noise (0.1 + 0.2) without losing cents.
          cells.push(String(Number(v.toPrecision(12))));
        } else if (v && typeof v === 'object' && 'result' in v) {
          const r = (v as { result: unknown }).result;
          cells.push(typeof r === 'number' ? String(Number(r.toPrecision(12))) : String(r ?? '').trim());
        } else {
          cells.push((cell.text ?? '').trim());
        }
      }
      rows[rowNumber - 1] = cells;
    });
    for (let i = 0; i < rows.length; i++) rows[i] ??= [];
    while (rows.length && rows.at(-1)!.every((c) => c === '')) rows.pop();
    sheets.push({ name: ws.name, rows });
  });
  return sheets;
}
