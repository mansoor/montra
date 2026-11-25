/**
 * An account's holders (ACC-15) and its number masked to the last four (ACC-16) on the phone's account screen: shown
 * from the synced account, edited online by those who set the books up.
 */
import { fireEvent, screen } from '@testing-library/react-native';
import type { AccountDto, FamilyMemberDto } from '@montra/schemas';
import Register from '../app/accounts/[id]';
import { t } from '../src/i18n';
import { api } from './harness/api';
import { renderScreen, signedInAs, WS } from './harness/render';
import { params } from './harness/router';
import { refresh, store } from './harness/sync';

const member = (id: string, name: string): FamilyMemberDto => ({
  id,
  name,
  relationship: 'self',
  birthDate: null,
  color: null,
  status: 'active',
  isDependent: false,
  linkedUserId: null,
});

const joint = {
  id: 'acct-joint',
  entityId: 'ent-personal',
  name: 'Joint checking',
  kind: 'checking',
  type: 'asset',
  currency: 'USD',
  institution: 'Credit Union',
  last4: '4321',
  accountNumberMasked: '••••4321',
  fullNumberKept: true,
  holders: [
    { name: 'Ada Lovelace', memberId: 'm-ada' },
    { name: 'Ben Lovelace', memberId: 'm-ben' },
  ],
  balance: { amount: '100000', currency: 'USD' },
  archived: false,
  hidden: false,
  defaultMemberId: null,
  loanId: null,
  planType: null,
  employerId: null,
  employerContributions: false,
  cycle: { statementDay: null, dueDay: null, payFromAccountId: null, payRule: null, payFixed: null },
  purchasePrice: null,
  purchaseDate: null,
  loanAccountId: null,
  dueDate: null,
  reconciledThrough: null,
  planning: {
    creditLimit: null,
    interestRateBps: null,
    interestRatePpm: null,
    minPayment: null,
    lowBalance: '0',
  },
} as AccountDto;

async function open(account: AccountDto) {
  await store.replaceReference({
    accounts: [account],
    categories: [],
    members: [
      member('m-ada', 'Ada Lovelace'),
      member('m-ben', 'Ben Lovelace'),
      member('m-cy', 'Cy Lovelace'),
    ],
    entities: [],
  });
  params.current = { id: account.id };
  await renderScreen(<Register />);
}

describe('holders on the account screen', () => {
  it('shows the holders and the number masked to its last four', async () => {
    await signedInAs('owner');
    await open(joint);
    expect(await screen.findByTestId('account-holders-line')).toHaveTextContent(
      'Ada Lovelace and Ben Lovelace',
    );
    expect(screen.getByTestId('account-number-masked')).toHaveTextContent('••••4321');
  });

  it('says when none are listed', async () => {
    await signedInAs('owner');
    await open({ ...joint, holders: [], last4: null, accountNumberMasked: null, fullNumberKept: false });
    expect(await screen.findByTestId('account-holders-line')).toHaveTextContent(t('accounts.holders_none'));
    expect(screen.queryByTestId('account-number-masked')).toBeNull();
  });

  it('adds a holder from the family list and saves the whole list', async () => {
    api.setAccountHolders.mockResolvedValue(joint);
    await signedInAs('owner');
    await open(joint);
    await fireEvent.press(await screen.findByTestId('account-holders-edit'));
    // Nothing changed yet, so nothing to save.
    expect(screen.getByTestId('account-holders-save')).toBeDisabled();
    await fireEvent.press(screen.getByTestId('account-holders-add'));
    await fireEvent.press(await screen.findByTestId('account-holder-2-member-m-cy'));
    await fireEvent.press(screen.getByTestId('account-holders-save'));
    await screen.findByTestId('account-holders-edit');
    expect(api.setAccountHolders).toHaveBeenCalledWith(WS, 'acct-joint', [
      { name: 'Ada Lovelace', memberId: 'm-ada' },
      { name: 'Ben Lovelace', memberId: 'm-ben' },
      { memberId: 'm-cy' },
    ]);
    expect(refresh).toHaveBeenCalled();
  });

  it('shows what the server says when a change is refused', async () => {
    api.setAccountHolders.mockRejectedValue(new Error('An account can list up to 4 holders'));
    await signedInAs('owner');
    await open(joint);
    await fireEvent.press(await screen.findByTestId('account-holders-edit'));
    await fireEvent.press(screen.getByTestId('account-holders-add'));
    await fireEvent.changeText(screen.getAllByLabelText(t('accounts.holders_name'))[2]!, 'Trust');
    await fireEvent.press(screen.getByTestId('account-holders-save'));
    expect(await screen.findByText('An account can list up to 4 holders')).toBeOnTheScreen();
  });

  it('is read-only for a viewer', async () => {
    await signedInAs('viewer');
    await open(joint);
    await screen.findByTestId('account-holders-line');
    expect(screen.queryByTestId('account-holders-edit')).toBeNull();
  });
});
