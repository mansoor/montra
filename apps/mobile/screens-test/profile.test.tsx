/** Your profile (OPS-13, TZ-01): Save waits for a change, a zone the phone doesn't know is refused, a change is sent. */
import { act, fireEvent, screen } from '@testing-library/react-native';
import Profile from '../app/profile';
import { t } from '../src/i18n';
import { api } from './harness/api';
import { me, renderScreen, signedInAs } from './harness/render';

describe('profile', () => {
  beforeEach(async () => {
    await signedInAs('member', me({ displayName: 'Ada', timeZone: 'America/Los_Angeles' }));
  });

  it('keeps Save off until the name or time zone changes', async () => {
    await renderScreen(<Profile />);

    expect(await screen.findByDisplayValue('Ada')).toBeOnTheScreen();
    expect(screen.getByTestId('profile-save')).toBeDisabled();

    await fireEvent.changeText(screen.getByTestId('profile-name'), 'Ada Lovelace');
    expect(screen.getByTestId('profile-save')).toBeEnabled();

    // Back to what's saved: nothing to send again.
    await fireEvent.changeText(screen.getByTestId('profile-name'), 'Ada ');
    expect(screen.getByTestId('profile-save')).toBeDisabled();
  });

  it("shows an error for a time zone that doesn't exist, and sends nothing", async () => {
    await renderScreen(<Profile />);

    await fireEvent.changeText(await screen.findByTestId('profile-time-zone'), 'Mars/Olympus_Mons');
    await fireEvent.press(screen.getByTestId('profile-save'));

    expect(await screen.findByText(t('mobile.settings.time_zone_invalid'))).toBeOnTheScreen();
    expect(api.updateMe).not.toHaveBeenCalled();
  });

  it('sends only what changed, then says it saved', async () => {
    // The "saved" toast goes away on a timer.
    jest.useFakeTimers();
    api.updateMe.mockResolvedValue(me({ displayName: 'Ada', timeZone: 'Europe/London' }));
    await renderScreen(<Profile />);

    await fireEvent.changeText(await screen.findByTestId('profile-time-zone'), ' Europe/London ');
    await fireEvent.press(screen.getByTestId('profile-save'));

    expect(api.updateMe).toHaveBeenCalledWith({ timeZone: 'Europe/London' });
    expect(await screen.findByText(t('profile.saved'))).toBeOnTheScreen();
    expect(screen.getByDisplayValue('Europe/London')).toBeOnTheScreen();
    expect(screen.getByTestId('profile-save')).toBeDisabled();

    await act(async () => jest.runOnlyPendingTimers());
    expect(screen.queryByText(t('profile.saved'))).toBeNull();
  });
});
