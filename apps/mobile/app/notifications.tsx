/** The inbox on the phone (NOT-01). Read live: it isn't kept on the device. */
import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'expo-router';
import type { NotificationDto } from '@montra/schemas';
import { t } from '../src/i18n';
import { useSession } from '../src/session/SessionProvider';
import { Banner, Body, Button, Row, Screen, Small } from '../src/ui/components';

export default function Notifications() {
  const router = useRouter();
  const { state: session, api } = useSession();
  const ws = session.status === 'signed_in' ? session.workspace.id : '';
  const [items, setItems] = useState<NotificationDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setItems((await api.notifications(ws)).data);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [api, ws]);

  useEffect(() => {
    if (ws) void load();
  }, [load, ws]);

  const read = async (id: string) => {
    await api.markNotificationRead(ws, id).catch(() => undefined);
    await load();
  };

  return (
    <Screen testID="notifications">
      {error ? <Banner tone="danger" text={error} /> : null}
      {items && items.length === 0 ? <Body muted>{t('notifications.empty')}</Body> : null}
      {items?.some((n) => !n.read) ? (
        <Button
          kind="secondary"
          label={t('notifications.mark_all')}
          onPress={() => void api.markAllNotificationsRead(ws).then(load)}
          testID="notifications-read-all"
        />
      ) : null}
      {items?.map((n) => (
        <Row
          key={n.id}
          title={n.title}
          subtitle={n.body || undefined}
          right={!n.read ? <Small>{t('notifications.unread')}</Small> : undefined}
          onPress={() => void read(n.id)}
          testID="notification-row"
        />
      ))}
      <Button
        kind="secondary"
        label={t('notifications.settings')}
        onPress={() => router.push('/notification-settings')}
        testID="notifications-settings"
      />
    </Screen>
  );
}
