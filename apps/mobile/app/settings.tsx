/**
 * Settings (OPS-13): app lock (PLT-07), receipt reminders, notifications with quiet hours and the daily cap, the mobile
 * number where texts are on (ADR-0049 §6), your data, then your profile (name, time zone), family members, books and
 * entities, and where AI runs, each on its own screen, changed by whoever the web lets change them (others read them
 * there). The workspace's base currency and time zone are read-only, as on the web: they are set when the workspace is
 * made and no API changes them. Plans are bought on the web. Workspace switching, sign out (wipes, BAK-10), version.
 */
import { useCallback, useEffect, useState } from 'react';
import { Alert, Linking, Pressable, Switch, View } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import type {
  BillingDto,
  FamilyMemberDto,
  MeDto,
  NotificationPrefsDto,
  PlanningSettingsDto,
  PlanOfferDto,
} from '@montra/schemas';
import { aiUsedPercent, headlinePrice, otherPlans } from '../src/features/plans';
import { reminderChoices } from '../src/features/receipt-capture';
import { config } from '../src/config';
import { fmtMoney, t } from '../src/i18n';
import { LOCK_TIMEOUTS } from '../src/lock/policy';
import { useLockSettings } from '../src/lock/AppLock';
import { registerForPush, type PushStatus } from '../src/push/register';
import { useAbilities, useSession } from '../src/session/SessionProvider';
import { Body, Button, Card, Row, Screen, Segmented, Small } from '../src/ui/components';
import { useTheme } from '../src/ui/theme';

export default function Settings() {
  const th = useTheme();
  const router = useRouter();
  const lock = useLockSettings();
  const session = useSession();
  const can = useAbilities();
  const { state, api } = session;
  const [ai, setAi] = useState<string | null>(null);
  const [aiUsed, setAiUsed] = useState<number | null>(null);
  const [offers, setOffers] = useState<PlanOfferDto[]>([]);
  const [push, setPush] = useState<PushStatus | null>(null);
  const [me, setMe] = useState<MeDto | null>(null);
  const [family, setFamily] = useState<FamilyMemberDto[]>([]);
  const [plan, setPlan] = useState<BillingDto | null>(null);
  const [planning, setPlanning] = useState<PlanningSettingsDto | null>(null);
  const [texts, setTexts] = useState<NotificationPrefsDto['texts'] | null>(null);
  const currency = state.status === 'signed_in' ? state.workspace.baseCurrency : 'USD';

  const wsId = state.status === 'signed_in' ? state.workspace.id : null;

  useEffect(() => {
    if (!wsId) return;
    void api.billing(wsId).then(setPlan, () => undefined);
    void api.plans().then(setOffers, () => undefined);
    void api.planningSettings(wsId).then(setPlanning, () => undefined);
    void registerForPush(api, false).then(setPush, () => setPush('unavailable'));
  }, [api, wsId]);

  // Read again on coming back from a screen that changes them: the profile, family, AI mode, and the number (ADR-0049
  // §6: asked for only where texts are on; it couldn't be confirmed otherwise).
  useFocusEffect(
    useCallback(() => {
      void api.notificationPrefs().then(
        (p) => setTexts(p.texts),
        () => setTexts(null),
      );
      void api.me().then(setMe, () => undefined);
      if (!wsId) return;
      void api.familyMembers(wsId).then(setFamily, () => undefined);
      void api.aiSettings(wsId).then(
        (s) => {
          setAi(s.mode);
          setAiUsed(aiUsedPercent(s.usage?.share));
        },
        () => undefined,
      );
    }, [api, wsId]),
  );

  const signOut = () =>
    Alert.alert(t('mobile.settings.sign_out'), t('mobile.settings.sign_out_note'), [
      { text: t('mobile.common.cancel'), style: 'cancel' },
      { text: t('mobile.settings.sign_out'), style: 'destructive', onPress: () => void session.signOut() },
    ]);

  return (
    <Screen testID="settings">
      <Card>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
          <Body>{t('mobile.settings.lock')}</Body>
          <Switch
            value={lock.enabled}
            disabled={!lock.available}
            onValueChange={(v) => void lock.setEnabled(v)}
            accessibilityLabel={t('mobile.settings.lock')}
          />
        </View>
        {lock.enabled ? (
          <>
            <Small>{t('mobile.settings.lock_after')}</Small>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: th.space(2) }}>
              {LOCK_TIMEOUTS.map((o) => (
                <Pressable
                  key={o}
                  onPress={() => void lock.setTimeout(o)}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: lock.timeout === o }}
                  style={{
                    paddingHorizontal: 12,
                    paddingVertical: 8,
                    borderRadius: 16,
                    backgroundColor: lock.timeout === o ? th.primary : th.bg,
                  }}
                >
                  <Body style={{ color: lock.timeout === o ? th.onPrimary : th.text }}>
                    {t(`mobile.settings.lock.${o}`)}
                  </Body>
                </Pressable>
              ))}
            </View>
          </>
        ) : null}
      </Card>

      {/* Receipt reminders are the workspace's planning settings: owners and admins (AUTH-18, ADR-0053 Q5). */}
      {planning && can.workspaceSettings ? (
        <Card testID="settings-receipt-reminders">
          <Body>{t('mobile.settings.receipt_reminders')}</Body>
          <Small>{t('mobile.settings.receipt_reminders_hint')}</Small>
          <Segmented
            label={t('mobile.settings.receipt_reminders')}
            value={planning.receiptReminderMinor ?? 'off'}
            options={reminderChoices(planning.receiptReminderMinor).map((v) => ({
              value: v ?? 'off',
              label: v === null ? t('mobile.settings.off') : fmtMoney(v, currency).replace(/[.,]00$/, ''),
            }))}
            onChange={(v) => {
              if (state.status !== 'signed_in') return;
              const receiptReminderMinor = v === 'off' ? null : v;
              setPlanning({ ...planning, receiptReminderMinor });
              void api
                .updatePlanningSettings(state.workspace.id, { receiptReminderMinor })
                .then(setPlanning, () => setPlanning(planning));
            }}
          />
        </Card>
      ) : null}

      <Card>
        <Small>{t('mobile.settings.notifications')}</Small>
        {push === 'registered' ? (
          <Body>{t('mobile.settings.notifications_on')}</Body>
        ) : (
          <Button
            kind="secondary"
            label={t('mobile.settings.notifications_enable')}
            disabled={push === 'unavailable'}
            onPress={() => void registerForPush(api, true).then(setPush)}
          />
        )}
        <Row
          title={t('notifications.settings')}
          onPress={() => router.push('/notification-settings')}
          testID="settings-notifications"
        />
        {texts?.available ? (
          <Row
            title={t('phone.title')}
            subtitle={
              texts.phone
                ? t(texts.verified ? 'phone.current_verified' : 'phone.current_unverified', {
                    phone: texts.phone,
                  })
                : t('phone.none')
            }
            icon="phone"
            onPress={() => router.push('/mobile-number')}
            testID="settings-mobile-number"
          />
        ) : null}
      </Card>

      <Row
        title={t('settings.tab.data')}
        subtitle={t('mobile.settings.data_note')}
        onPress={() => router.push('/your-data')}
        testID="settings-your-data"
      />

      {state.status === 'signed_in' ? (
        <Card testID="settings-account">
          <Row
            title={t('mobile.settings.profile')}
            subtitle={
              me
                ? [
                    me.displayName || me.email,
                    t('mobile.settings.your_time_zone', { zone: me.timeZone }),
                  ].join(' · ')
                : undefined
            }
            icon="person"
            onPress={() => router.push('/profile')}
            testID="settings-profile"
          />
          <Row
            title={t('mobile.settings.family')}
            subtitle={family
              .filter((f) => f.status === 'active')
              .map((f) => f.name)
              .join(', ')}
            icon="family"
            onPress={() => router.push('/family')}
            testID="settings-family"
          />
          <Row
            title={t('mobile.settings.entities')}
            subtitle={state.workspace.entities.map((e) => e.name).join(', ')}
            icon="books"
            onPress={() => router.push('/books')}
            testID="settings-books"
          />
          <Row
            title={t('settings.tab.ai')}
            subtitle={ai ? t('mobile.settings.ai_mode', { mode: t(`ai.mode.${ai}`) }) : undefined}
            icon="ai"
            onPress={() => router.push('/ai-settings')}
            testID="settings-ai"
            last
          />
          {/* Set when the workspace is made; there is no API to change them, on the web either. */}
          <Small>
            {t('mobile.settings.books', {
              currency: state.workspace.baseCurrency,
              zone: state.workspace.timeZone,
            })}
          </Small>
          <Small>{t('mobile.settings.books_fixed')}</Small>
          {plan && plan.mode !== 'off' ? <Small>{plan.planName}</Small> : null}
          {plan && plan.mode !== 'off'
            ? otherPlans(offers, plan.plan).map((o) => {
                const price = headlinePrice(o);
                return (
                  <Body key={o.key}>
                    {price
                      ? t(
                          price.interval === 'year'
                            ? 'mobile.settings.plan_yearly'
                            : 'mobile.settings.plan_monthly',
                          {
                            name: o.name,
                            price: fmtMoney(price.amountMinor, price.currency),
                          },
                        )
                      : o.name}
                  </Body>
                );
              })
            : null}
          {plan && plan.mode !== 'off' ? <Small>{t('mobile.settings.plan_on_web')}</Small> : null}
        </Card>
      ) : null}

      {state.status === 'signed_in' ? (
        <Card>
          <Small>{t('mobile.settings.workspace')}</Small>
          {state.workspaces.map((w) => (
            <Row
              key={w.id}
              title={w.name}
              subtitle={w.id === state.workspace.id ? '✓' : undefined}
              onPress={() => void session.chooseWorkspace(w.id)}
            />
          ))}
          {aiUsed !== null ? (
            <View
              accessible
              accessibilityRole="progressbar"
              accessibilityLabel={t('mobile.settings.ai_used', { percent: aiUsed })}
              accessibilityValue={{ min: 0, max: 100, now: aiUsed }}
              testID="ai-usage-bar"
            >
              <Small>{t('mobile.settings.ai_used', { percent: aiUsed })}</Small>
              <View style={{ height: 6, borderRadius: 3, backgroundColor: th.border, overflow: 'hidden' }}>
                <View
                  style={{
                    width: `${aiUsed}%`,
                    height: 6,
                    backgroundColor: aiUsed >= 100 ? th.danger : aiUsed >= 80 ? th.warning : th.primary,
                  }}
                />
              </View>
            </View>
          ) : null}
        </Card>
      ) : null}

      {/* OPS-09: help and the legal pages open in the browser, and work signed out. */}
      <Row
        title={t('help.title')}
        onPress={() => void Linking.openURL(`${config.webUrl}/help`)}
        testID="settings-help"
      />
      <Row
        title={t('legal.privacy')}
        onPress={() => void Linking.openURL(`${config.webUrl}/legal/privacy`)}
        testID="settings-privacy"
      />
      <Button kind="danger" label={t('mobile.settings.sign_out')} onPress={signOut} testID="sign-out" />
      <Small>{t('mobile.settings.sign_out_note')}</Small>
      <Row title={t('mobile.settings.developer')} onPress={() => router.push('/developer/camera')} />
      <Small>{t('mobile.settings.version', { version: config.version })}</Small>
    </Screen>
  );
}
