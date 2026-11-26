// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AskAccountDto, AskAnswerDto } from '@montra/api-client';
import { AccountAnswer, AskBox } from '@/components/reports/ask-box';

const ask = vi.fn();
vi.mock('@/lib/browser-api', () => ({ browserApi: { ask: (...args: unknown[]) => ask(...args) } }));

// Ask about one account (RPT-06, ADR-0058): the account page's figures, a link to it, and buttons when several fit.
const blank: AskAccountDto = {
  phrase: 'skylark home loan',
  topic: 'payoff',
  outcome: 'answered',
  account: { id: 'a1', name: 'Skylark Home Loan', kind: 'mortgage' },
  choices: [],
  currency: 'USD' as AskAccountDto['currency'],
  balance: '19980090',
  payoffDate: null,
  paymentsLeft: null,
  interestRemaining: null,
  next: null,
  interestPaid: null,
  interestPeriods: [],
  paymentsBefore: null,
};
// Dates and money arrive as plain JSON strings.
const html = (answer: object) =>
  renderToStaticMarkup(
    <AccountAnswer base="/w/w1" answer={{ ...blank, ...answer } as AskAccountDto} onPick={() => {}} />,
  );
const text = (markup: string) => markup.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

describe('AccountAnswer', () => {
  it('says when a loan is paid off, with the payments and interest left, and links to it', () => {
    const out = html({ payoffDate: '2055-12-01', paymentsLeft: 359, interestRemaining: '23167270' });
    expect(text(out)).toContain('Skylark Home Loan will be paid off on Dec 1, 2055.');
    expect(text(out)).toContain('359 payments left');
    expect(text(out)).toContain('Amount owed $199,800.90');
    expect(text(out)).toContain('Interest left to pay $231,672.70');
    expect(out).toContain('href="/w/w1/accounts/a1"');
    expect(text(out)).toContain('Open Skylark Home Loan');
  });

  it('gives the next payment and its split', () => {
    const out = text(
      html({
        topic: 'next_payment',
        next: { date: '2026-12-01', total: '119910', principal: '20010', interest: '99900', escrow: '0' },
      }),
    );
    expect(out).toContain('The next payment on Skylark Home Loan is due Dec 1, 2026.');
    expect(out).toContain('Payment $1,199.10');
    expect(out).toContain('Principal $200.10');
    expect(out).toContain('Interest $999.00');
    expect(out).not.toContain('Escrow');
  });

  it('gives interest paid since tracking began, or in each period', () => {
    const ever = text(html({ topic: 'interest_paid', interestPaid: '100000', paymentsBefore: 2 }));
    expect(ever).toContain('Interest paid on Skylark Home Loan since tracking began.');
    expect(ever).toContain('Interest $1,000.00');
    expect(ever).toContain('The 2 payments made before tracking began aren’t counted');
    const year = text(
      html({
        topic: 'interest_paid',
        interestPaid: '100000',
        interestPeriods: [{ label: 'this year', from: '2026-01-01', to: '2026-11-25', amount: '100000' }],
      }),
    );
    expect(year).toContain('this year $1,000.00');
  });

  it('words a balance by the kind of account', () => {
    const checking = { id: 'c1', name: 'Checking', kind: 'checking' as const };
    expect(text(html({ topic: 'balance', account: checking, balance: '125000' }))).toContain(
      'Current balance $1,250.00',
    );
    const brokerage = { id: 'i1', name: 'Brokerage', kind: 'investment' as const };
    expect(text(html({ topic: 'balance', account: brokerage, balance: '125000' }))).toContain(
      'Current value $1,250.00',
    );
  });

  it('says a loan kept as its balance needs tracking for a payoff date, and gives what is owed', () => {
    const out = text(
      html({
        outcome: 'needs_tracking',
        account: { id: 'l1', name: 'Car loan', kind: 'loan' },
        balance: '1500000',
      }),
    );
    expect(out).toContain('Car loan is kept as just its balance');
    expect(out).toContain('Amount owed $15,000.00');
    expect(out).toContain('Open Car loan');
  });

  it('names nothing but the asker’s words when no account matches', () => {
    const out = text(html({ outcome: 'no_match', account: null, currency: null, balance: null }));
    expect(out).toContain('No account matches “skylark home loan”.');
    expect(out).not.toContain('Skylark Home Loan');
  });
});

describe('AskBox', () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeAll(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });
  beforeEach(() => {
    ask.mockReset();
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  const account = (over: Partial<AskAccountDto>): AskAnswerDto => ({
    question: 'How much do I owe on my Chase card?',
    kind: 'account',
    understood: true,
    metric: null,
    categories: [],
    payee: null,
    currency: null,
    periods: [],
    transactions: [],
    account: { ...blank, phrase: 'Chase card', topic: 'owed', ...over },
  });

  it('shows the accounts that tie as buttons, and asks again about the one picked', async () => {
    const choices = [
      { id: 'k1', name: 'Chase Freedom', kind: 'credit_card' as const },
      { id: 'k2', name: 'Chase Sapphire', kind: 'credit_card' as const },
    ];
    ask.mockResolvedValueOnce(
      account({ outcome: 'choose', account: null, currency: null, balance: null, choices }),
    );
    ask.mockResolvedValueOnce(account({ account: choices[1]!, balance: '67890' }));
    act(() => root.render(<AskBox workspaceId="w1" />));
    const input = host.querySelector('input')!;
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      set.call(input, 'How much do I owe on my Chase card?');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(ask).toHaveBeenLastCalledWith('w1', { question: 'How much do I owe on my Chase card?' });
    expect(host.textContent).toContain('More than one account fits “Chase card”.');
    const buttons = [...host.querySelectorAll('[data-testid="ask-account-choose"] button')];
    expect(buttons.map((b) => b.textContent)).toEqual(['Chase Freedom', 'Chase Sapphire']);
    await act(async () => {
      (buttons[1] as HTMLButtonElement).click();
    });
    expect(ask).toHaveBeenLastCalledWith('w1', {
      question: 'How much do I owe on my Chase card?',
      accountId: 'k2',
    });
    expect(host.querySelector('[data-testid="ask-account"]')?.textContent).toContain('$678.90');
  });

  it('still shows an amount answer', async () => {
    ask.mockResolvedValueOnce({
      question: 'How much did I spend on dining out?',
      kind: 'amount',
      understood: true,
      metric: 'spending',
      categories: ['Dining out'],
      payee: null,
      currency: 'USD',
      periods: [
        {
          label: 'this month',
          from: '2026-11-01',
          to: '2026-11-25',
          amount: '4500',
          drill: { from: '2026-11-01', to: '2026-11-25' },
        },
      ],
      transactions: [],
    } as unknown as AskAnswerDto);
    act(() => root.render(<AskBox workspaceId="w1" />));
    const input = host.querySelector('input')!;
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      set.call(input, 'How much did I spend on dining out?');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(host.querySelector('[data-testid="ask-period"]')?.textContent).toContain('$45.00');
  });
});
