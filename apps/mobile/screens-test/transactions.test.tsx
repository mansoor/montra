/** Transactions (08 §3): the list reads the offline store, newest first, and says so when there's nothing. */
import { act, fireEvent, screen } from '@testing-library/react-native';
import type { LocalTransaction } from '@montra/sync';
import Transactions from '../app/(tabs)/transactions';
import { fmtMoney, t } from '../src/i18n';
import { renderScreen, signedInAs } from './harness/render';
import { router } from './harness/router';
import { store } from './harness/sync';

const txn = (over: Partial<LocalTransaction> & Pick<LocalTransaction, 'id' | 'date'>): LocalTransaction => ({
  payee: null,
  description: '',
  amount: '-1000',
  currency: 'USD',
  accountId: 'acct-1',
  categoryId: null,
  categoryName: null,
  memberId: null,
  memo: null,
  tags: [],
  reviewState: 'none',
  status: 'posted',
  suggestedCategoryId: null,
  confidence: null,
  explanation: null,
  merchantName: null,
  version: '1',
  pending: false,
  server: null,
  ...over,
});

/** Lets the store's read answer, and the list lay out the rows it renders in batches. */
const settle = () => act(async () => jest.runOnlyPendingTimers());

describe('transactions', () => {
  beforeEach(async () => {
    jest.useFakeTimers();
    await signedInAs('owner');
  });

  it('lists the transactions in the offline store, newest first', async () => {
    await store.putTransactions([
      txn({
        id: 't-1',
        date: '2026-11-18',
        merchantName: 'Corner Market',
        amount: '-4250',
        categoryName: 'Groceries',
      }),
      txn({ id: 't-2', date: '2026-11-20', payee: 'Acme Payroll', amount: '250000' }),
      txn({
        id: 't-3',
        date: '2026-11-19',
        description: 'ATM withdrawal',
        reviewState: 'needs_review',
        pending: true,
      }),
    ]);
    await renderScreen(<Transactions />);
    await settle();

    const rows = await screen.findAllByTestId('txn-row');
    expect(rows.map((r) => r.props.accessibilityLabel)).toEqual([
      expect.stringContaining('Acme Payroll'),
      expect.stringContaining('ATM withdrawal'),
      expect.stringContaining('Corner Market'),
    ]);
    expect(screen.getByText(fmtMoney('-4250', 'USD'))).toBeOnTheScreen();
    expect(screen.getByText(fmtMoney('250000', 'USD'))).toBeOnTheScreen();
    // Under the name: the category, or that it needs review and is waiting to sync.
    expect(screen.getByText(/Groceries$/)).toBeOnTheScreen();
    expect(
      screen.getByText(`${t('mobile.txn.needs_review')} · ${t('mobile.txn.pending')}`, { exact: false }),
    ).toBeOnTheScreen();
    expect(screen.queryByText(t('mobile.txn.empty'))).toBeNull();

    await fireEvent.press(rows[0]!);
    expect(router.push).toHaveBeenCalledWith('/transaction/t-2');
  });

  it('says there is nothing when the store has no transactions', async () => {
    await renderScreen(<Transactions />);
    await settle();

    expect(screen.getByText(t('mobile.txn.empty'))).toBeOnTheScreen();
    expect(screen.queryAllByTestId('txn-row')).toHaveLength(0);
  });
});
