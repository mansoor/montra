/** Sign-in (AUTH-01): what the API says when signing in fails is shown on the form. */
import { fireEvent, screen } from '@testing-library/react-native';
import SignIn from '../app/sign-in';
import { ApiError } from '../src/api/client';
import { t } from '../src/i18n';
import { api } from './harness/api';
import { renderScreen } from './harness/render';

describe('sign-in', () => {
  it('shows the error the API answers with, and stays on the form', async () => {
    api.me.mockRejectedValue(new ApiError(403, 'forbidden', 'This login has no access to Montra.'));
    api.workspaces.mockResolvedValue([]);
    await renderScreen(<SignIn />);

    const submit = await screen.findByTestId('sign-in-submit');
    expect(submit).toBeDisabled();
    await fireEvent.changeText(screen.getByTestId('email'), 'ada@example.com');
    expect(submit).toBeEnabled();
    await fireEvent.press(submit);

    expect(await screen.findByText('This login has no access to Montra.')).toBeOnTheScreen();
    expect(screen.getByTestId('email')).toBeOnTheScreen();
    expect(screen.getByText(t('mobile.signin.dev_note'))).toBeOnTheScreen();
  });
});
