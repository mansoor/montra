/**
 * A transfer between currencies on the transaction screen (CUR-08): the rate it got, the market rate for its date and
 * the FX cost, from the server's fresh copy; without a stored market rate it says so.
 */
import { screen } from '@testing-library/react-native';
import type { TransactionDto } from '@montra/schemas';
import type { LocalTransaction } from '@montra/sync';
import TransactionDetail from '../app/transaction/[id]';
import { fmtDate, fmtMoney, t } from '../src/i18n';
import { api } from './harness/api';
import { renderScreen, signedInAs } from './harness/render';
import { params } from './harness/router';
import { store } from './harness/sync';

const row: LocalTransaction = {
  id: 'txn-1',
  date: '2026-11-16',
  payee: null,
  description: 'Transfer',
  amount: '-110000',
  currency: 'USD',
  accountId: 'acct-usd',
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
};

const transferFx: NonNullable<TransactionDto['transferFx']> = {
  sent: { amount: '110000', currency: 'USD' },
  received: { amount: '100000', currency: 'EUR' },
  effectiveRate: '0.9090909091',
  marketRate: '0.9259259259',
  marketRateDate: '2026-11-13',
  baseCurrency: 'USD',
  cost: { amount: '2000', currency: 'USD' },
  costBps: 182,
};

const fresh = (fx: TransactionDto['transferFx']) =>
  ({ receipt: null, transferFx: fx }) as unknown as TransactionDto;

describe('transfer between currencies on the transaction screen', () => {
  beforeEach(async () => {
    await signedInAs('owner');
    await store.replaceReference({ accounts: [], categories: [], members: [], entities: [] });
    await store.putTransactions([row]);
    params.current = { id: 'txn-1' };
  });

  it('shows the rate it got, the market rate and the FX cost', async () => {
    api.getTransaction.mockResolvedValue(fresh(transferFx));
    await renderScreen(<TransactionDetail />);

    expect(await screen.findByTestId('txn-transfer-fx')).toBeOnTheScreen();
    expect(screen.getByText('1 USD = 0.9091 EUR')).toBeOnTheScreen();
    expect(
      screen.getByText(
        `1 USD = 0.9259 EUR · ${t('fx.transfer.market_date', { date: fmtDate('2026-11-13') })}`,
      ),
    ).toBeOnTheScreen();
    expect(
      screen.getByText(t('fx.transfer.cost_value', { amount: fmtMoney('2000', 'USD'), percent: '1.82' })),
    ).toBeOnTheScreen();
  });

  it('says when no market rate is stored for the date', async () => {
    api.getTransaction.mockResolvedValue(
      fresh({ ...transferFx, marketRate: null, marketRateDate: null, cost: null, costBps: null }),
    );
    await renderScreen(<TransactionDetail />);

    expect(await screen.findByTestId('txn-transfer-fx')).toBeOnTheScreen();
    expect(screen.getByText(t('fx.transfer.no_rate', { date: fmtDate('2026-11-16') }))).toBeOnTheScreen();
    expect(screen.queryByText(t('fx.transfer.cost'))).toBeNull();
  });

  it('shows nothing for other transactions', async () => {
    api.getTransaction.mockResolvedValue(fresh(null));
    await renderScreen(<TransactionDetail />);

    expect(await screen.findByTestId('txn-detail')).toBeOnTheScreen();
    expect(screen.queryByTestId('txn-transfer-fx')).toBeNull();
  });
});
