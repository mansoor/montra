/**
 * A portfolio's contacts and tenants on the phone (RNT-22): who to call for each property, with tap-to-call and
 * tap-to-email, and where each tenant lives now. Read-only, kept for offline viewing; editing is on the web.
 */
import { useLocalSearchParams } from 'expo-router';
import { Linking, Pressable, View } from 'react-native';
import type { RentalContactDto } from '@montra/schemas';
import { contactsByProperty, mailtoUrl, telUrl, tenantsByHome } from '../../src/features/rentals';
import { useCached } from '../../src/features/use-cached';
import { t } from '../../src/i18n';
import { useSession } from '../../src/session/SessionProvider';
import { Banner, Body, Card, Row, Screen, Small, Title } from '../../src/ui/components';
import { useTheme } from '../../src/ui/theme';

function Link({ url, label, testID }: { url: string | null; label: string; testID: string }) {
  const th = useTheme();
  if (!url) return null;
  return (
    <Pressable
      testID={testID}
      accessibilityRole="link"
      accessibilityLabel={label}
      onPress={() => void Linking.openURL(url)}
      hitSlop={8}
    >
      <Small color={th.primary}>{label}</Small>
    </Pressable>
  );
}

function ContactCard({ c }: { c: RentalContactDto }) {
  const tel = telUrl(c.phone);
  const mail = mailtoUrl(c.email);
  return (
    <Card testID="rental-contact">
      <Small>{t(`rentals.contact_role_${c.role}`)}</Small>
      <Body>{c.companyName}</Body>
      {c.contactPerson ? <Small>{c.contactPerson}</Small> : null}
      {c.accountNumber ? (
        <Small>
          {t('rentals.account_number')}: {c.accountNumber}
        </Small>
      ) : null}
      <View style={{ flexDirection: 'row', gap: 16, marginTop: 4 }}>
        <Link url={tel} label={c.phone ?? ''} testID="rental-contact-call" />
        <Link url={mail} label={c.email ?? ''} testID="rental-contact-email" />
      </View>
    </Card>
  );
}

export default function RentalContacts() {
  const { entityId = '' } = useLocalSearchParams<{ entityId: string }>();
  const { state: session, api } = useSession();
  const ws = session.status === 'signed_in' ? session.workspace.id : '';
  const data = useCached(
    ws,
    `rentals:${entityId}:people`,
    async () => {
      const [properties, contacts, tenants] = await Promise.all([
        api.rentalProperties(ws, entityId),
        api.rentalContacts(ws, entityId),
        api.rentalTenants(ws, entityId),
      ]);
      return { properties, contacts, tenants };
    },
    Boolean(ws && entityId),
  );
  const d = data.data;
  const groups = d ? contactsByProperty(d.contacts, d.properties, t('mobile.rentals.whole_portfolio')) : [];

  return (
    <Screen testID="rental-contacts">
      {data.stale ? <Banner tone="warning" text={t('mobile.plan.offline')} /> : null}
      {data.error ? <Banner tone="danger" text={data.error} /> : null}
      <Small>{t('mobile.rentals.edit_on_web')}</Small>
      {d ? (
        <>
          <Title>{t('rentals.contacts')}</Title>
          {groups.length === 0 ? <Body muted>{t('mobile.rentals.no_contacts')}</Body> : null}
          {groups.map((g) => (
            <View key={g.propertyId ?? 'portfolio'} style={{ gap: 8 }}>
              <Body>{g.propertyName}</Body>
              {g.contacts.map((c) => (
                <ContactCard key={`${g.propertyId}:${c.id}`} c={c} />
              ))}
            </View>
          ))}

          <Title>{t('rentals.tab_tenants')}</Title>
          {d.tenants.length === 0 ? <Body muted>{t('mobile.rentals.no_tenants')}</Body> : null}
          {tenantsByHome(d.tenants).map((x) => (
            <Row
              key={x.id}
              title={x.name}
              subtitle={
                x.current
                  ? `${t('rentals.lives_at')}: ${x.current.propertyName} · ${x.current.unitLabel}`
                  : t('mobile.rentals.no_current_home')
              }
              right={
                telUrl(x.phone) ? (
                  <Link url={telUrl(x.phone)} label={t('mobile.rentals.call')} testID="rental-tenant-call" />
                ) : undefined
              }
              testID="rental-tenant"
            />
          ))}
        </>
      ) : null}
    </Screen>
  );
}
