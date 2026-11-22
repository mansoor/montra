/** Helpers for the staff console's reference data editor (OPS-05). */
import { ColumnMappingDto } from '@montra/schemas';

/** "50" → 5000, "12.5" → 1250: a percentage as basis points, or null when it isn't one between 0 and 100. */
export function percentToBps(text: string): number | null {
  const m = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(text.trim());
  if (!m) return null;
  const bps = Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'));
  return bps <= 10000 ? bps : null;
}

/** 5000 → "50", 1250 → "12.5". */
export function bpsToPercent(bps: number): string {
  const whole = String(Math.trunc(bps / 100));
  const frac = String(bps % 100)
    .padStart(2, '0')
    .replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole;
}

export type MappingCheck = { ok: true; mapping: ColumnMappingDto } | { ok: false; problem: string };

/**
 * Reads the mapping JSON typed in the console and checks it as the API will (the importer's ColumnMapping shape), so
 * the form can say what's wrong before saving.
 */
export function readMappingJson(text: string): MappingCheck {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, problem: 'json' };
  }
  const parsed = ColumnMappingDto.safeParse(raw);
  if (parsed.success) return { ok: true, mapping: parsed.data };
  const issue = parsed.error.issues[0];
  return { ok: false, problem: issue ? `${issue.path.join('.') || 'mapping'}: ${issue.message}` : 'mapping' };
}

/** A starting point for a new layout: the common Date, Description, Amount file. */
export const MAPPING_EXAMPLE = JSON.stringify(
  {
    headerRow: 0,
    dataStart: 1,
    date: 0,
    dateFormat: 'MM/DD/YYYY',
    description: [1],
    amount: 2,
    sign: 'normal',
    decimal: '.',
  },
  null,
  2,
);
