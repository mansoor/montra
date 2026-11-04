/**
 * What a bug report can include, and what goes to error tracking (NFR-13, OPS-09). Error messages can quote what's on screen, so long runs
 * of digits, which could be amounts or account numbers, and email addresses are taken out first.
 */
const MAX_ENTRIES = 50;
const entries: string[] = [];

export function scrubClientText(text: string): string {
  return text
    .replace(/[^\s@]+@[^\s@]+/g, '[email]')
    .replace(/\d[\d,.]{2,}\d/g, '#')
    .slice(0, 500);
}

export function recordClientLog(text: string): void {
  entries.push(scrubClientText(text));
  if (entries.length > MAX_ENTRIES) entries.shift();
}

export const recentClientLogs = (): string[] => [...entries];
