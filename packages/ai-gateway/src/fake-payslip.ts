/**
 * Deterministic payslips for the fake provider (tests, e2e). The same fake images as receipts carry the text
 * (`encodeFakeReceiptImage`); `parsePayslipText` is the fake model: plain line parsing, no guessing.
 */

const LINE_KINDS: [RegExp, 'earning' | 'pre_tax' | 'tax' | 'post_tax' | 'employer', string][] = [
  [/employer|match/i, 'employer', 'match'],
  [/roth/i, 'post_tax', 'roth_401k'],
  [/401\(?k\)?/i, 'pre_tax', '401k'],
  [/\bhsa\b/i, 'pre_tax', 'hsa'],
  [/health|medical/i, 'pre_tax', 'health'],
  [/federal/i, 'tax', 'fed_tax'],
  [/state/i, 'tax', 'state_tax'],
  [/social security|oasdi/i, 'tax', 'social_security'],
  [/medicare/i, 'tax', 'medicare'],
  [/union/i, 'post_tax', 'union_dues'],
  [/overtime/i, 'earning', 'overtime'],
  [/bonus/i, 'earning', 'bonus'],
  [/salary|regular|wages/i, 'earning', 'salary'],
];

const date = (text: string, label: RegExp) => label.exec(text)?.[1] ?? null;

/** Reads "Label  1,234.56 [ytd 9,876.54]" lines, the pay date and period, the employer and net pay. */
export function parsePayslipText(text: string) {
  const lines: {
    section: (typeof LINE_KINDS)[number][1];
    code: string;
    label: string;
    amount: string;
    ytd: string | null;
  }[] = [];
  let netPay: string | null = null;
  for (const raw of text.split('\n')) {
    const m = /^(.*?)\s+\$?([\d,]+\.\d{2})(?:\s+ytd\s+\$?([\d,]+\.\d{2}))?\s*$/i.exec(raw.trim());
    if (!m) continue;
    const label = m[1]!.trim();
    const amount = m[2]!.replace(/,/g, '');
    if (/net pay|take.?home/i.test(label)) {
      netPay = amount;
      continue;
    }
    if (/gross|total/i.test(label)) continue;
    const kind = LINE_KINDS.find(([re]) => re.test(label));
    lines.push({
      section: kind?.[1] ?? 'post_tax',
      code: kind?.[2] ?? 'other',
      label,
      amount,
      ytd: m[3]?.replace(/,/g, '') ?? null,
    });
  }
  return {
    employer: /^employer:\s*(.+)$/im.exec(text)?.[1]?.trim() ?? null,
    employee: /^employee:\s*(MEMBER_\d+)\b/im.exec(text)?.[1] ?? null,
    payDate: date(text, /pay date:?\s*(\d{4}-\d{2}-\d{2})/i),
    periodStart: date(text, /period:?\s*(\d{4}-\d{2}-\d{2})/i),
    periodEnd: date(text, /period:?\s*\d{4}-\d{2}-\d{2}\s*(?:to|-|–)\s*(\d{4}-\d{2}-\d{2})/i),
    currency: /\b(USD|EUR|GBP|CAD|AUD|INR)\b/.exec(text)?.[1] ?? null,
    lines,
    netPay,
    confidence: lines.length && netPay ? 0.95 : 0.3,
  };
}
