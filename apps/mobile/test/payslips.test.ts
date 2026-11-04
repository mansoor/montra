import { describe, expect, it, vi } from 'vitest';
import type { PayslipDto } from '@montra/schemas';
import { createApi } from '../src/api/client';
import { canConfirm, linesBySection } from '../src/features/payslips';

const line = (lineNo: number, section: PayslipDto['lines'][number]['section'], code: string) => ({
  id: `l${lineNo}`,
  lineNo,
  section,
  code,
  label: code,
  amount: '100',
  ytd: null,
  accountId: null,
});

describe('linesBySection', () => {
  it('follows the order of a payslip and skips empty sections', () => {
    const groups = linesBySection({
      lines: [line(3, 'tax', 'fed_tax'), line(2, 'earning', 'bonus'), line(1, 'earning', 'salary')],
    });
    expect(groups.map((g) => g.section)).toEqual(['earning', 'tax']);
    expect(groups[0]!.lines.map((l) => l.code)).toEqual(['salary', 'bonus']);
  });
});

describe('canConfirm', () => {
  const ok = {
    status: 'needs_review' as const,
    payDate: '2026-11-01' as PayslipDto['payDate'],
    gap: '0',
    lines: [line(1, 'earning', 'salary')],
  };

  it('needs a dated payslip that adds up and has not posted', () => {
    expect(canConfirm(ok)).toBe(true);
    expect(canConfirm({ ...ok, gap: '250' })).toBe(false);
    expect(canConfirm({ ...ok, payDate: null })).toBe(false);
    expect(canConfirm({ ...ok, lines: [] })).toBe(false);
    expect(canConfirm({ ...ok, status: 'posted' })).toBe(false);
  });
});

describe('the API client', () => {
  it('sends the chosen deposit, including "none of these", when confirming', async () => {
    const fetchFn = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response(JSON.stringify({ id: 'p1' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetchFn);
    const api = createApi({ baseUrl: 'http://api', token: async () => 't' });
    await api.confirmPayslip('w1', 'p1', { version: 2, depositTransactionId: null });
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe('http://api/v1/workspaces/w1/payslips/p1/confirm');
    expect(JSON.parse(String(init?.body))).toEqual({ version: 2, depositTransactionId: null });
    vi.unstubAllGlobals();
  });
});
