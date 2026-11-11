/**
 * A business's logo and domain on the phone (ADR-0032), as they print on invoices. The logo is picked from Files or
 * Photos and checked by the server; the domain is checked here the same way the server does (`normalizeDomain`). The
 * rest of the profile is changed on the web.
 */
import { useCallback, useEffect, useState } from 'react';
import { Image, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import * as DocumentPicker from 'expo-document-picker';
import { normalizeDomain, type BusinessProfileDto } from '@montra/schemas';
import { t } from '../../src/i18n';
import { useSession } from '../../src/session/SessionProvider';
import { Banner, Body, Button, Card, Field, Screen, Small, Title } from '../../src/ui/components';
import { useTheme } from '../../src/ui/theme';

export default function BusinessSettings() {
  const th = useTheme();
  const { entityId } = useLocalSearchParams<{ entityId: string }>();
  const { state: session, api } = useSession();
  const ws = session.status === 'signed_in' ? session.workspace.id : '';
  const [profile, setProfile] = useState<BusinessProfileDto | null>(null);
  const [domain, setDomain] = useState('');
  const [headers, setHeaders] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!ws || !entityId) return;
    try {
      const [p, h] = await Promise.all([
        api.businesses(ws).then((all) => all.find((b) => b.entityId === entityId) ?? null),
        api.authHeaders(),
      ]);
      setProfile(p);
      setDomain(p?.domain ?? '');
      setHeaders(h);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [api, ws, entityId]);
  useEffect(() => void load(), [load]);

  const act = async (work: () => Promise<unknown>, done: string) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await work();
      setNotice(done);
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const pickLogo = async () => {
    const r = await DocumentPicker.getDocumentAsync({
      type: ['image/png', 'image/jpeg'],
      copyToCacheDirectory: true,
    });
    if (r.canceled || !r.assets[0]) return;
    const a = r.assets[0];
    await act(
      () => api.setBusinessLogo(ws, entityId, { uri: a.uri, name: a.name, type: a.mimeType ?? 'image/png' }),
      t('business.logo_saved'),
    );
  };

  const saveDomain = async () => {
    const value = domain.trim() ? normalizeDomain(domain) : null;
    if (domain.trim() && !value) return setError(t('business.domain_invalid'));
    await act(() => api.updateBusiness(ws, entityId, { domain: value }), t('business.profile_saved'));
  };

  if (!profile) {
    return (
      <Screen testID="business-settings-screen">
        {error ? <Banner tone="danger" text={error} /> : <Small>{t('mobile.common.loading')}</Small>}
      </Screen>
    );
  }

  return (
    <Screen testID="business-settings-screen">
      {error ? <Banner tone="danger" text={error} /> : null}
      {notice ? <Banner text={notice} /> : null}
      <Title>{profile.legalName ?? profile.name}</Title>

      <Card testID="business-logo">
        <Body style={{ fontWeight: '700' }}>{t('business.logo')}</Body>
        <Small>{t('business.logo_hint')}</Small>
        <View
          style={{
            height: 72,
            borderRadius: th.radius,
            backgroundColor: '#ffffff',
            alignItems: 'center',
            justifyContent: 'center',
            padding: th.space(1),
          }}
        >
          {profile.logoFileId ? (
            <Image
              accessibilityLabel={t('business.logo_alt')}
              source={{ uri: api.businessLogoUrl(ws, entityId, profile.logoFileId), headers }}
              style={{ width: '100%', height: '100%' }}
              resizeMode="contain"
            />
          ) : (
            <Small color="#6b7280">{t('business.no_logo')}</Small>
          )}
        </View>
        <Button
          kind="secondary"
          label={profile.logoFileId ? t('business.logo_replace') : t('business.logo_choose')}
          onPress={() => void pickLogo()}
          busy={busy}
          testID="business-logo-pick"
        />
        {profile.logoFileId ? (
          <Button
            kind="secondary"
            label={t('business.logo_remove')}
            onPress={() => void act(() => api.removeBusinessLogo(ws, entityId), t('business.logo_removed'))}
            disabled={busy}
            testID="business-logo-remove"
          />
        ) : null}
      </Card>

      <Card testID="business-domain">
        <Field
          label={t('business.domain')}
          value={domain}
          onChangeText={setDomain}
          placeholder="example.com"
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          maxLength={300}
          testID="business-domain-field"
        />
        <Small>{t('business.domain_hint')}</Small>
        <Button label={t('business.save_profile')} onPress={() => void saveDomain()} busy={busy} />
      </Card>

      <Card>
        {profile.email ? <Body>{profile.email}</Body> : null}
        {profile.address ? <Small>{profile.address}</Small> : null}
        <Small>{t('mobile.business.profile_on_web')}</Small>
      </Card>
    </Screen>
  );
}
