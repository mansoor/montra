/**
 * Bills (ADR-0048 §4) and their pages (ADR-0059 §4): a bill of two or more pages has Move up, Move down and Remove for
 * each page, as the receipt screen has. Removing asks first, and the last page can't be removed.
 */
import { Alert, type AlertButton } from 'react-native';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react-native';
import type { HouseholdBillDto } from '@montra/schemas';
import Bills from '../app/bills';
import { t } from '../src/i18n';
import { api } from './harness/api';
import { renderScreen, signedInAs } from './harness/render';

const bill = (over: Partial<HouseholdBillDto> = {}): HouseholdBillDto => ({
  id: 'bill-1',
  entityId: 'ent-personal',
  billerId: 'biller-1',
  billerName: 'City Power',
  categoryId: 'cat-utilities',
  memberId: null,
  status: 'open',
  amount: '8450',
  currency: 'USD',
  dueDate: '2026-12-05' as HouseholdBillDto['dueDate'],
  billDate: '2026-11-20' as HouseholdBillDto['dueDate'],
  periodStart: null,
  periodEnd: null,
  fileIds: ['f-1', 'f-2', 'f-3'],
  transactionId: null,
  warnings: [],
  version: 4,
  ...over,
});

const openPages = async () => {
  await fireEvent.press(await screen.findByTestId('bill-pages-toggle'));
  return within(screen.getByTestId('bill-pages'));
};

describe('bills', () => {
  beforeEach(async () => {
    await signedInAs('owner');
  });

  it('lists the bills with a fold for the pages of a bill of two or more pages', async () => {
    api.householdBills.mockResolvedValue([
      bill(),
      bill({ id: 'bill-2', billerName: 'Water Co', fileIds: ['f-9'] }),
    ]);
    await renderScreen(<Bills />);

    expect(await screen.findAllByTestId('bill-row')).toHaveLength(2);
    expect(api.householdBills).toHaveBeenCalledWith('ws-1');
    // Only the three-page bill has the fold, and its pages stay folded until it's opened.
    expect(screen.getAllByTestId('bill-pages-toggle')).toHaveLength(1);
    expect(screen.getByText(t('mobile.bills.pages', { count: 3 }))).toBeOnTheScreen();
    expect(screen.queryByTestId('bill-pages')).toBeNull();

    const pages = await openPages();
    expect(pages.getAllByTestId('bill-page-up')).toHaveLength(3);
    expect(
      pages.getByText(`${t('record_pages.hint_bill')} ${t('record_pages.vault_note')}`),
    ).toBeOnTheScreen();
  });

  it('moves a page up or down, and not past either end', async () => {
    api.householdBills.mockResolvedValue([bill()]);
    api.setHouseholdBillPages.mockResolvedValue(bill({ fileIds: ['f-2', 'f-1', 'f-3'], version: 5 }));
    await renderScreen(<Bills />);
    const pages = await openPages();

    expect(pages.getByLabelText(t('record_pages.move_up', { n: 1 }))).toBeDisabled();
    expect(pages.getByLabelText(t('record_pages.move_down', { n: 3 }))).toBeDisabled();

    await fireEvent.press(pages.getByLabelText(t('record_pages.move_up', { n: 2 })));
    expect(api.setHouseholdBillPages).toHaveBeenCalledWith('ws-1', 'bill-1', {
      version: 4,
      fileIds: ['f-2', 'f-1', 'f-3'],
    });

    // The next change goes with the bill's new version.
    await fireEvent.press(
      within(screen.getByTestId('bill-pages')).getByLabelText(t('record_pages.move_down', { n: 2 })),
    );
    expect(api.setHouseholdBillPages).toHaveBeenLastCalledWith('ws-1', 'bill-1', {
      version: 5,
      fileIds: ['f-2', 'f-3', 'f-1'],
    });
  });

  it('removes a page after asking, and has no page controls once one page is left', async () => {
    const alert = jest.spyOn(Alert, 'alert');
    api.householdBills.mockResolvedValue([bill({ fileIds: ['f-1', 'f-2'] })]);
    api.setHouseholdBillPages.mockResolvedValue(bill({ fileIds: ['f-1'], version: 5 }));
    await renderScreen(<Bills />);
    const pages = await openPages();

    await fireEvent.press(pages.getByLabelText(t('record_pages.remove', { n: 2 })));
    expect(alert).toHaveBeenCalledWith(
      t('record_pages.remove_title', { n: 2 }),
      t('record_pages.remove_body'),
      expect.any(Array),
    );
    // Nothing is removed until the removal is confirmed.
    expect(api.setHouseholdBillPages).not.toHaveBeenCalled();

    const buttons = alert.mock.calls[0]![2] as AlertButton[];
    const confirm = buttons.find((b) => b.text === t('record_pages.remove_confirm'))!;
    expect(confirm.style).toBe('destructive');
    await act(async () => confirm.onPress!());

    expect(api.setHouseholdBillPages).toHaveBeenCalledWith('ws-1', 'bill-1', {
      version: 4,
      fileIds: ['f-1'],
    });
    await waitFor(() => expect(screen.queryByTestId('bill-pages-toggle')).toBeNull());
    expect(screen.getByTestId('bill-row')).toBeOnTheScreen();
    alert.mockRestore();
  });

  it('shows a viewer no page controls', async () => {
    await signedInAs('viewer');
    api.householdBills.mockResolvedValue([bill()]);
    await renderScreen(<Bills />);

    expect(await screen.findByTestId('bill-row')).toBeOnTheScreen();
    expect(screen.queryByTestId('bill-pages-toggle')).toBeNull();
    expect(screen.queryByTestId('scan-bill')).toBeNull();
  });
});
