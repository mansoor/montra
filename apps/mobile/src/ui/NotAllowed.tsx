import { t } from '../i18n';
import { Body, Card } from './components';

/**
 * Shown in place of a form the signed-in role can't use (AUTH-18), for a screen reached by a link or a share from
 * another app. The server would refuse the change anyway.
 */
export function NotAllowed({ testID = 'not-allowed' }: { testID?: string }) {
  return (
    <Card testID={testID}>
      <Body muted>{t('mobile.role.not_allowed')}</Body>
    </Card>
  );
}
