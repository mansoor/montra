import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AmortizationRowDto, LoanDto } from '@montra/api-client';
import {
  LoanOwedChart,
  LoanScheduleChart,
  PaidSoFar,
  ScheduleSection,
} from '@/components/accounts/loan-charts';

// A $200,000.00 mortgage at 6%, one payment recorded (ADR-0024).
const loan = {
  id: 'l1',
  entityId: 'e1',
  propertyId: null,
  loanAccountId: 'a1',
  name: 'Home mortgage',
  startDate: null,
  interestMethod: 'monthly',
  principal: '20000000',
  rateBps: 600,
  termMonths: 360,
  firstPaymentDate: '2026-10-27',
  escrowTaxes: '0',
  escrowInsurance: '0',
  payment: '119910',
  totalPayment: '119910',
  scheduledBalance: '19980090',
  paymentsMade: 1,
  paymentsBefore: 0,
  payingAccountId: null,
  autoRecord: false,
  graceDays: 0,
  lateFee: null,
  lateFeeBps: null,
  next: null,
  payoffDate: '2026-12-27',
  interestRemaining: '199801',
  interestPaid: '100000',
  principalPaid: '19910',
  currency: 'USD',
  version: 1,
} as unknown as LoanDto;

const row = (n: number, date: string, paid: boolean, balance: string, lateFee = '0') =>
  ({
    number: n,
    date,
    payment: '119910',
    interest: '100000',
    principal: '19910',
    escrow: '0',
    balance,
    transactionId: paid ? `t${n}` : null,
    lateFee,
  }) as AmortizationRowDto;

const rows = [
  row(1, '2026-10-27', true, '19980090', '2500'),
  row(2, '2026-11-27', false, '19960180'),
  row(3, '2026-12-27', false, '0'),
];

describe('loan charts', () => {
  it('opens the schedule on the table, with a switch to the chart', () => {
    const html = renderToStaticMarkup(
      <ScheduleSection loan={loan} rows={rows} table={<table data-testid="the-table" />} />,
    );
    expect(html).toContain('data-testid="the-table"');
    expect(html).toMatch(/aria-pressed="true"[^>]*data-testid="loan-schedule-view-table"/);
    expect(html).toMatch(/aria-pressed="false"[^>]*data-testid="loan-schedule-view-chart"/);
    expect(html).toContain('aria-label="Show the schedule as"');
  });

  it('draws a stacked bar per payment, a late fee where one was paid, and today between paid and to come', () => {
    const html = renderToStaticMarkup(<LoanScheduleChart loan={loan} rows={rows} />);
    expect(html).toContain('role="img"');
    expect(html).toContain(
      'aria-label="Principal and interest in each payment on Home mortgage: 1 recorded, 2 to come."',
    );
    // Principal, interest and the late fee, named in the legend.
    expect(html).toContain('Principal');
    expect(html).toContain('Interest');
    expect(html).toContain('Late fee');
    expect(html.match(/data-faded="true"/g)).toHaveLength(2);
    expect(html).toContain('data-testid="chart-marker"');
    expect(html).toContain('>Today<');
    expect(html).toContain('Lighter bars are still to come.');
    expect(html).not.toContain('One bar per year');
  });

  it('says so when a long loan is shown by year', () => {
    const long = Array.from({ length: 121 }, (_, i) =>
      row(i + 1, `${2027 + Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}-01`, false, '0'),
    );
    const html = renderToStaticMarkup(<LoanScheduleChart loan={loan} rows={long} />);
    expect(html).toContain('One bar per year, as there are more than 120 payments.');
    expect(html).not.toContain('Late fee');
  });

  it('continues what’s owed to payoff, dashed, with the payoff month at the end', () => {
    const html = renderToStaticMarkup(
      <LoanOwedChart
        loan={loan}
        rows={rows}
        history={[
          { date: '2026-10-26', balance: '20000000' },
          { date: '2026-11-24', balance: '19980090' },
        ]}
        today="2026-11-24"
        name="Home mortgage"
      />,
    );
    expect(html).toContain('data-testid="chart-actual"');
    expect(html).toContain('data-testid="chart-projected"');
    expect(html).toContain('stroke-dasharray');
    expect(html).toContain('Paid off Dec 2026');
    expect(html).toContain('Projected from the payment schedule');
  });

  it('shows the projection alone for a loan with no history yet', () => {
    const html = renderToStaticMarkup(
      <LoanOwedChart loan={loan} rows={rows} history={[]} today="2026-11-24" name="Home mortgage" />,
    );
    expect(html).not.toContain('data-testid="chart-actual"');
    expect(html).toContain('data-testid="chart-projected"');
    expect(html).toContain('Paid off Dec 2026');
  });

  it('shows principal and interest paid so far against their totals', () => {
    const html = renderToStaticMarkup(<PaidSoFar loan={loan} />);
    expect(html).toContain('Principal paid $199.10 of $200,000.00');
    // Paid plus still to pay.
    expect(html).toContain('Interest paid $1,000.00 of about $2,998.01 total');
    expect(html).toContain('aria-valuenow="33"');
    expect(html).not.toContain('before tracking');
    const older = renderToStaticMarkup(<PaidSoFar loan={{ ...loan, paymentsBefore: 25 }} />);
    expect(older).toContain('Interest on payments made before tracking began isn’t included.');
  });
});
