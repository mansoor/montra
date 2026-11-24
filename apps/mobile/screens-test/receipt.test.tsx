/**
 * Receipt review (RCP-06): the Splits card follows the categories as they are picked, before anything is saved, and
 * lines of the same category make one split. The owner's report of 2026-11-21: the splits stayed as the server last
 * grouped them until Save (fixed in PR #180).
 */
import { fireEvent, screen, within } from '@testing-library/react-native';
import type { CategoryDto, ReceiptDto, ReceiptLineDto } from '@montra/schemas';
import ReceiptReview from '../app/receipts/[id]';
import { fmtMoney, t } from '../src/i18n';
import { api } from './harness/api';
import { renderScreen, signedInAs } from './harness/render';
import { params } from './harness/router';
import { store } from './harness/sync';

const category = (id: string, name: string): CategoryDto => ({
  id,
  entityId: 'ent-personal',
  name,
  type: 'expense',
  group: null,
  taxLineCode: null,
});
const categories = [category('cat-groceries', 'Groceries'), category('cat-household', 'Household')];

const line = (id: string, n: number, rawText: string, lineTotal: string, categoryId: string | null) =>
  ({
    id,
    lineNo: n,
    rawText,
    expandedName: null,
    qty: null,
    unitPrice: null,
    lineTotal,
    discount: '0',
    taxable: false,
    isReturn: false,
    categoryId,
    entityId: null,
    memberId: null,
    categorization: null,
    memberReason: null,
  }) satisfies ReceiptLineDto;

const group = (categoryId: string | null, lineIds: string[], total: string) => ({
  categoryId,
  entityId: null,
  memberId: null,
  lineIds,
  subtotal: total,
  tax: '0',
  discount: '0',
  fees: '0',
  tip: '0',
  total,
});

/** Milk is groceries; bread and soap aren't categorized yet, so the server has two splits. */
const receipt: ReceiptDto = {
  id: 'rcpt-1',
  entityId: 'ent-personal',
  status: 'needs_review',
  source: 'camera',
  fileIds: [],
  merchant: 'Corner Market',
  storeAddress: null,
  storePhone: null,
  storeWebsite: null,
  receiptDate: '2026-11-20',
  localTime: null,
  currency: 'USD',
  subtotal: '1000',
  tax: '0',
  taxIncluded: false,
  discount: '0',
  fees: '0',
  tip: '0',
  total: '1000',
  cardLast4: null,
  validationGap: '0',
  lines: [
    line('l-milk', 1, 'MILK', '300', 'cat-groceries'),
    line('l-bread', 2, 'BREAD', '200', null),
    line('l-soap', 3, 'SOAP', '500', null),
  ],
  groups: [group('cat-groceries', ['l-milk'], '300'), group(null, ['l-bread', 'l-soap'], '700')],
  transactionId: null,
  matchScore: null,
  candidates: [],
  fxRate: null,
  tripId: null,
  orderRef: null,
  extraction: null,
  stalled: null,
  likelyDuplicates: [],
  retainUntil: '2033-11-20',
  createdAt: '2026-11-20T18:00:00Z',
  version: '3',
};

const usd = (minor: string) => fmtMoney(minor, 'USD');

/** The Splits card's rows as [category, amount] pairs. */
const splits = () => {
  const card = within(screen.getByTestId('receipt-splits'));
  const texts = card
    .getAllByText(/./)
    .map((n) => String(n.props.children))
    .filter((s) => s !== t('mobile.receipts.splits'));
  const rows: Array<[string, string]> = [];
  for (let i = 0; i < texts.length; i += 2) rows.push([texts[i]!, texts[i + 1]!]);
  return rows;
};

/** Taps a line and picks a category for it, as on the phone. */
const pick = async (rawText: string, categoryName: string) => {
  await fireEvent.press(screen.getByText(rawText));
  await fireEvent.press(await screen.findByTestId(`category-${categoryName}`));
};

describe('receipt review', () => {
  beforeEach(async () => {
    await signedInAs('owner');
    await store.replaceReference({ accounts: [], categories, members: [], entities: [] });
    params.current = { id: 'rcpt-1' };
    api.getReceipt.mockResolvedValue(receipt);
  });

  it("shows the server's splits until a category is picked", async () => {
    await renderScreen(<ReceiptReview />);

    expect(await screen.findByTestId('receipt-splits')).toBeOnTheScreen();
    expect(api.getReceipt).toHaveBeenCalledWith('ws-1', 'rcpt-1');
    expect(splits()).toEqual([
      ['Groceries', usd('300')],
      [t('mobile.receipts.uncategorized'), usd('700')],
    ]);
    expect(screen.queryByTestId('receipt-save')).toBeNull();
  });

  it('updates the splits as each line is categorized, before saving', async () => {
    await renderScreen(<ReceiptReview />);
    await screen.findByTestId('receipt-splits');

    await pick('SOAP', 'Household');
    expect(splits()).toEqual([
      ['Groceries', usd('300')],
      [t('mobile.receipts.uncategorized'), usd('200')],
      ['Household', usd('500')],
    ]);
    // Nothing is sent until Save.
    expect(screen.getByTestId('receipt-save')).toBeOnTheScreen();
    expect(api.updateReceipt).not.toHaveBeenCalled();
  });

  it('shows lines of the same category as one split', async () => {
    await renderScreen(<ReceiptReview />);
    await screen.findByTestId('receipt-splits');

    await pick('SOAP', 'Household');
    await pick('BREAD', 'Groceries');

    expect(splits()).toEqual([
      ['Groceries', usd('500')],
      ['Household', usd('500')],
    ]);
    const card = within(screen.getByTestId('receipt-splits'));
    expect(card.getAllByText('Groceries')).toHaveLength(1);
    expect(card.queryByText(t('mobile.receipts.uncategorized'))).toBeNull();
    expect(api.updateReceipt).not.toHaveBeenCalled();
  });
});
