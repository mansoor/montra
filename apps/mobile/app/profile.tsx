/**
 * Your profile (OPS-13, TZ-01): your name and your own time zone, as on the web's Settings → Profile (`PATCH /v1/me`).
 * The language, date format and first day of the week stay on the web: the phone writes dates and amounts the way the
 * phone's own settings do, so changing them here would change nothing here. Keeping original photos (BAK-08) is the
 * same choice as on the web, saved as soon as it's switched.
 */
import { useEffect, useState } from 'react';
import { Switch, View } from 'react-native';
import type { MeDto } from '@montra/schemas';
import { deviceTimeZone, errorText, profileRequest } from '../src/features/settings-edit';
import { t } from '../src/i18n';
import { useSession } from '../src/session/SessionProvider';
import { Banner, Body, Button, Card, Field, Screen, Small, useToast } from '../src/ui/components';
import { haptic } from '../src/ui/haptics';

export default function Profile() {
  const session = useSession();
  const { api } = session;
  const toast = useToast();
  const [me, setMe] = useState<MeDto | null>(null);
  const [name, setName] = useState('');
  const [zone, setZone] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [savingPhotos, setSavingPhotos] = useState(false);
  const here = deviceTimeZone();

  useEffect(() => {
    api.me().then(
      (m) => {
        setMe(m);
        setName(m.displayName);
        setZone(m.timeZone);
      },
      (err: unknown) => setError(errorText(err, t)),
    );
  }, [api]);

  const built = me ? profileRequest({ displayName: name, timeZone: zone }, me) : null;
  const changed = built?.ok ? Object.keys(built.value).length > 0 : Boolean(built);

  const save = async () => {
    if (!built) return;
    if (!built.ok) return setError(t(built.error));
    setBusy(true);
    setError(null);
    try {
      const next = await api.updateMe(built.value);
      setMe(next);
      setName(next.displayName);
      setZone(next.timeZone);
      haptic.success();
      toast.show(t('profile.saved'));
      void session.refresh();
    } catch (err) {
      setError(errorText(err, t));
    } finally {
      setBusy(false);
    }
  };

  const setKeepOriginal = async (keepOriginalPhotos: boolean) => {
    setSavingPhotos(true);
    setError(null);
    try {
      setMe(await api.updateMe({ keepOriginalPhotos }));
      haptic.success();
      void session.refresh();
    } catch (err) {
      setError(errorText(err, t));
    } finally {
      setSavingPhotos(false);
    }
  };

  return (
    <Screen testID="profile">
      {error ? <Banner tone="danger" text={error} /> : null}
      {me ? (
        <Card>
          <Small>{t('security.signed_in_as', { email: me.email })}</Small>
          <Field
            label={t('profile.display_name')}
            value={name}
            onChangeText={setName}
            maxLength={100}
            autoComplete="name"
            textContentType="name"
            testID="profile-name"
          />
          <Field
            label={t('profile.time_zone')}
            value={zone}
            onChangeText={setZone}
            autoCapitalize="none"
            autoCorrect={false}
            testID="profile-time-zone"
          />
          <Small>{t('profile.time_zone_hint')}</Small>
          {here && here !== zone.trim() ? (
            <Button
              kind="secondary"
              label={t('mobile.settings.use_phone_zone', { zone: here })}
              onPress={() => setZone(here)}
              testID="profile-use-phone-zone"
            />
          ) : null}
          <Button
            label={t('profile.save')}
            busy={busy}
            disabled={!changed}
            onPress={() => void save()}
            testID="profile-save"
          />
          <Body muted>{t('mobile.settings.profile_on_web')}</Body>
        </Card>
      ) : null}
      {me ? (
        <Card>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
            <View style={{ flex: 1 }}>
              <Body>{t('profile.keep_original_photos')}</Body>
            </View>
            <Switch
              value={me.keepOriginalPhotos}
              disabled={savingPhotos}
              onValueChange={(v) => void setKeepOriginal(v)}
              accessibilityLabel={t('profile.keep_original_photos')}
              testID="profile-keep-original-photos"
            />
          </View>
          <Small>{t('profile.keep_original_photos_hint')}</Small>
        </Card>
      ) : null}
    </Screen>
  );
}
