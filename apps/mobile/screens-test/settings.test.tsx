/**
 * Settings and its books screen by role (AUTH-18, OPS-13): owners and admins change the workspace's settings and its
 * books; a viewer sees them and can change nothing. The API refuses anything else; these check what the phone offers.
 */
import { act, fireEvent, screen } from '@testing-library/react-native';
import Books from '../app/books';
import Settings from '../app/settings';
import type { EntityDetailDto } from '../src/api/client';
import { t } from '../src/i18n';
import { api } from './harness/api';
import { renderScreen, signedInAs, WS } from './harness/render';
import { router } from './harness/router';

const planning = { categoryPriorities: {}, highInterestBps: 1000, receiptReminderMinor: '2500' };

const books: EntityDetailDto[] = [
  {
    id: 'ent-personal',
    type: 'personal',
    name: 'Personal',
    functionalCurrency: 'USD',
    businessType: null,
    fiscalYearStartMonth: 1,
    archived: false,
    lockedThrough: null,
    color: null,
  },
  {
    id: 'ent-shop',
    type: 'business',
    name: 'Corner Shop',
    functionalCurrency: 'USD',
    businessType: null,
    fiscalYearStartMonth: 1,
    archived: false,
    lockedThrough: null,
    color: null,
  },
];

/** Lets the screen's requests answer and their state settle. */
const settle = () => act(async () => undefined);

describe('settings', () => {
  beforeEach(() => {
    api.planningSettings.mockResolvedValue(planning);
  });

  it("shows an owner the workspace's receipt reminders, and opens the profile", async () => {
    await signedInAs('owner');
    await renderScreen(<Settings />);

    expect(await screen.findByTestId('settings-receipt-reminders')).toBeOnTheScreen();
    expect(api.planningSettings).toHaveBeenCalledWith(WS);
    expect(screen.getByTestId('settings-account')).toBeOnTheScreen();

    await fireEvent.press(screen.getByTestId('settings-profile'));
    expect(router.push).toHaveBeenCalledWith('/profile');
  });

  it("hides the workspace's receipt reminders from a viewer, who still has their own profile", async () => {
    await signedInAs('viewer');
    await renderScreen(<Settings />);

    expect(await screen.findByTestId('settings-profile')).toBeOnTheScreen();
    await settle();
    expect(api.planningSettings).toHaveBeenCalled();
    expect(screen.queryByTestId('settings-receipt-reminders')).toBeNull();
  });
});

describe('books', () => {
  beforeEach(() => {
    api.entities.mockResolvedValue(books);
  });

  it('lets an owner rename business books and add new ones', async () => {
    await signedInAs('owner');
    await renderScreen(<Books />);

    expect(await screen.findByTestId('books-name-ent-shop')).toBeOnTheScreen();
    expect(screen.getByTestId('books-add')).toBeOnTheScreen();
    expect(screen.queryByText(t('mobile.settings.books_read_only'))).toBeNull();
    // Rename stays off until the name changes.
    expect(screen.getByTestId('books-rename-ent-shop')).toBeDisabled();
    await fireEvent.changeText(screen.getByTestId('books-name-ent-shop'), 'Corner Shop LLC');
    expect(screen.getByTestId('books-rename-ent-shop')).toBeEnabled();
  });

  it('shows a viewer the books read-only, with nothing to change', async () => {
    await signedInAs('viewer');
    await renderScreen(<Books />);

    expect(await screen.findByText('Corner Shop')).toBeOnTheScreen();
    expect(screen.getAllByTestId('books-item')).toHaveLength(2);
    expect(screen.getByText(t('mobile.settings.books_read_only'))).toBeOnTheScreen();
    expect(screen.queryByTestId('books-add')).toBeNull();
    expect(screen.queryByTestId('books-name-ent-shop')).toBeNull();
    expect(screen.queryByTestId('books-rename-ent-shop')).toBeNull();
  });
});
