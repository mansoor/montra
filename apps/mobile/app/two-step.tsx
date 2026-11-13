/** Two-step verification settings (AUTH-04, AUTH-06), from More. */
import { t } from '../src/i18n';
import { Screen, Title } from '../src/ui/components';
import { TwoStep } from '../src/ui/TwoStep';

export default function TwoStepScreen() {
  return (
    <Screen testID="two-step-screen">
      <Title>{t('mobile.auth.two_step_title')}</Title>
      <TwoStep />
    </Screen>
  );
}
