/**
 * Quick add in ≤ 3 taps (TXN-01, 08 §3): type the amount on the keypad → tap Next → tap a suggested payee → tap
 * Save with the suggested category. Works offline (outbox); online it asks the pipeline for a category, offline it
 * reuses the last category for that payee. "Type a sentence" uses natural-language parsing when online (TXN-06).
 * Every step after the amount has Back and Cancel, Android's back button goes back a step, and leaving the tab
 * discards an unsaved entry, so + always starts fresh.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useFocusEffect, useRouter } from 'expo-router';
import { BackHandler, Linking, Pressable, ScrollView, Text, View } from 'react-native';
import type { CategoryDto, SuggestionDto } from '@montra/schemas';
import { asCurrencyCode, canSpendFrom, minorUnits } from '@montra/domain';
import { fmtMoney, t } from '../../src/i18n';
import { useAbilities, useSession } from '../../src/session/SessionProvider';
import { NotAllowed } from '../../src/ui/NotAllowed';
import { useLocal, useSync } from '../../src/sync/SyncProvider';
import {
  buildCreateRequest,
  digitsToDisplay,
  offersReceipt,
  payeeSuggestions,
  recentAccountIds,
  pressKey,
  previousStep,
  type CaptureStep,
  type KeypadKey,
} from '../../src/features/quick-add';
import { todayLocal } from '../../src/features/home';
import { useVoice } from '../../src/features/use-voice';
import { CategoryPicker } from '../../src/ui/CategoryPicker';
import {
  Banner,
  Body,
  Button,
  Card,
  Field,
  Row,
  Screen,
  Segmented,
  Small,
  SuccessBurst,
  Title,
} from '../../src/ui/components';
import { haptic } from '../../src/ui/haptics';
import { Icon, type IconName } from '../../src/ui/icons';
import { SidePanel } from '../../src/ui/SidePanel';
import { useTheme } from '../../src/ui/theme';

const KEYS: KeypadKey[] = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '00', '0', 'back'];
const LAST_ACCOUNT = 'mobile.lastAccount';

/** A quiet text action for the step bar, still a full-height tap target. */
function TextButton({
  label,
  arrow,
  onPress,
  testID,
}: {
  label: string;
  /** A leading ‹, shown but not read out. */
  arrow?: boolean;
  onPress: () => void;
  testID?: string;
}) {
  const th = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      testID={testID}
      hitSlop={8}
      style={({ pressed }) => ({ minHeight: th.tap, justifyContent: 'center', opacity: pressed ? 0.6 : 1 })}
    >
      <Text style={{ color: th.primary, fontSize: th.font.body, fontWeight: '600' }}>
        {arrow ? `‹ ${label}` : label}
      </Text>
    </Pressable>
  );
}

/** One of the three ways in: an icon over a short word, all three in one row. */
function ModeButton({
  icon,
  label,
  a11y,
  onPress,
  testID,
}: {
  icon: IconName;
  label: string;
  a11y: string;
  onPress: () => void;
  testID?: string;
}) {
  const th = useTheme();
  return (
    <Pressable
      onPress={() => {
        haptic.tap();
        onPress();
      }}
      accessibilityRole="button"
      accessibilityLabel={a11y}
      testID={testID}
      style={({ pressed }) => ({
        flex: 1,
        minHeight: th.tap + 8,
        borderRadius: th.radius,
        alignItems: 'center',
        justifyContent: 'center',
        gap: 2,
        backgroundColor: th.surfaceAlt,
        opacity: pressed ? 0.7 : 1,
      })}
    >
      <Icon name={icon} size={20} color={th.primary} />
      <Text style={{ color: th.text, fontSize: th.font.small, fontWeight: '600' }}>{label}</Text>
    </Pressable>
  );
}

export default function Capture() {
  const th = useTheme();
  const router = useRouter();
  const { state: session, api } = useSession();
  const { engine, store, state, touch } = useSync();
  const ws = session.status === 'signed_in' ? session.workspace.id : '';
  const can = useAbilities();
  // Only accounts purchases are paid from (no 401(k), IRA, brokerage, property or loans), in books this login writes.
  const accounts = (useLocal((s) => s.getReference('accounts')) ?? []).filter(
    (a) => !a.hidden && canSpendFrom(a) && can.writes(a.entityId),
  );
  const categories = useLocal((s) => s.getReference('categories')) ?? [];
  const history = useLocal((s) => s.listTransactions({ limit: 500 })) ?? [];

  const [step, setStep] = useState<CaptureStep>('amount');
  const [via, setVia] = useState<'keypad' | 'sentence'>('keypad');
  const [digits, setDigits] = useState('');
  const [direction, setDirection] = useState<'expense' | 'income'>('expense');
  const [accountId, setAccountId] = useState<string>('');
  const [allAccounts, setAllAccounts] = useState(false);
  const [payee, setPayee] = useState('');
  const [category, setCategory] = useState<CategoryDto | null>(null);
  const [suggestion, setSuggestion] = useState<SuggestionDto | null>(null);
  const [picking, setPicking] = useState(false);
  const [sentence, setSentence] = useState('');
  /** Came to the sentence step by voice: the keyboard stays down while listening. */
  const [talking, setTalking] = useState(false);
  const voice = useVoice(setSentence);
  /** ADR-0049 §1: voice entry is a plan feature. Offline, or until the plan is read, it's offered. */
  const [voiceOnPlan, setVoiceOnPlan] = useState(true);
  const [busy, setBusy] = useState(false);
  /** Set right after a save: the check animation shows it. */
  const [saved, setSaved] = useState<string | null>(null);
  /** The spending just saved: offered a receipt photo until dismissed or a new amount is typed. */
  const [receiptFor, setReceiptFor] = useState<{ id: string; label: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!ws) return;
    void api.billing(ws).then(
      (b) => setVoiceOnPlan(b.entitlements.features.includes('voice')),
      () => undefined,
    );
  }, [api, ws]);

  useEffect(() => {
    void store.getMeta(LAST_ACCOUNT).then((id) => {
      if (id && accounts.some((a) => a.id === id)) setAccountId(id);
      else if (!accountId && accounts[0]) setAccountId(accounts[0].id);
    });
    // Runs when the account list arrives.
  }, [accounts.length]);

  const account = accounts.find((a) => a.id === accountId);
  const recent = recentAccountIds(
    history,
    accounts.map((a) => a.id),
    accountId,
  );
  const shownAccounts = recent.flatMap((id) => accounts.filter((a) => a.id === id));
  const currency = account?.currency ?? 'USD';
  const exponent = minorUnits(asCurrencyCode(currency));
  const suggestions = useMemo(() => payeeSuggestions(history, payee), [history, payee]);
  const byId = useMemo(() => new Map(categories.map((c) => [c.id, c])), [categories]);

  const reset = useCallback(() => {
    setStep('amount');
    setVia('keypad');
    setDigits('');
    setPayee('');
    setCategory(null);
    setSuggestion(null);
    setSentence('');
    setTalking(false);
    setError(null);
    setPicking(false);
    setReceiptFor(null);
    voice.cancel();
  }, [voice.cancel]);

  const back = useCallback(() => {
    const prev = previousStep(step, via);
    if (prev) {
      if (voice.listening) voice.cancel();
      setError(null);
      setStep(prev);
    }
    return prev !== null;
  }, [step, via, voice.listening, voice.cancel]);

  // Android's back button steps back through the entry before it leaves the screen.
  useFocusEffect(
    useCallback(() => {
      const sub = BackHandler.addEventListener('hardwareBackPress', back);
      return () => sub.remove();
    }, [back]),
  );
  // Leaving the tab discards the unsaved entry: + always starts a new one.
  useFocusEffect(useCallback(() => reset, [reset]));

  /** Tap 2: payee chosen → look up a category (online: pipeline; offline: last one used locally). */
  const choosePayee = async (name: string, localCategoryId: string | null) => {
    setPayee(name);
    setVia('keypad');
    setStep('confirm');
    setCategory(localCategoryId ? (byId.get(localCategoryId) ?? null) : null);
    if (!state?.online || !account) return;
    try {
      const s = await api.suggest(ws, {
        payee: name,
        amount: {
          amount: (direction === 'expense' ? -BigInt(digits || '0') : BigInt(digits || '0')).toString(),
          currency: asCurrencyCode(currency),
        },
        accountId: account.id,
        date: todayLocal(),
      });
      setSuggestion(s);
      if (s.categoryId && byId.has(s.categoryId)) setCategory(byId.get(s.categoryId)!);
    } catch {
      // keep the local guess
    }
  };

  /** Tap 3. */
  const save = async () => {
    setError(null);
    try {
      const req = buildCreateRequest({
        accountId,
        currency,
        digits,
        direction,
        payee,
        categoryId: category?.id ?? null,
        date: todayLocal(),
      });
      const created = await engine.createTransaction(req);
      await store.setMeta(LAST_ACCOUNT, accountId);
      touch();
      const label = payee || fmtMoney(req.amount.amount, currency);
      setSaved(t('mobile.capture.saved', { payee: label }));
      const offer = offersReceipt(direction) ? { id: created.id, label } : null;
      reset();
      setReceiptFor(offer);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const parseSentence = async () => {
    setBusy(true);
    setError(null);
    try {
      const d = await api.parseQuickAdd(ws, { text: sentence, today: todayLocal() });
      if (d.amount) setDigits(d.amount.amount.replace(/^-/, ''));
      setDirection(d.direction === 'in' ? 'income' : 'expense');
      if (d.accountId && accounts.some((a) => a.id === d.accountId)) setAccountId(d.accountId);
      setPayee(d.payee ?? '');
      setCategory(d.categoryId ? (byId.get(d.categoryId) ?? null) : null);
      setVia('sentence');
      setStep('confirm');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!can.record)
    return (
      <Screen>
        <Title>{t('mobile.capture.title')}</Title>
        <NotAllowed />
      </Screen>
    );
  if (accounts.length === 0)
    return (
      <Screen>
        <Title>{t('mobile.capture.title')}</Title>
        <Body muted>{t('mobile.capture.no_account')}</Body>
      </Screen>
    );

  return (
    <Screen testID="capture">
      {step !== 'amount' ? (
        <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
          <TextButton label={t('mobile.common.back')} arrow onPress={back} testID="qa-back" />
          <TextButton label={t('mobile.common.cancel')} onPress={reset} testID="qa-cancel" />
        </View>
      ) : null}
      <Title>{t('mobile.capture.title')}</Title>
      {step === 'amount' && receiptFor && !digits ? (
        <Card
          testID="qa-receipt-offer"
          style={{ flexDirection: 'row', alignItems: 'center', gap: th.space(2) }}
        >
          <View style={{ flex: 1 }}>
            <Body style={{ fontWeight: '600' }}>{t('mobile.capture.receipt_offer')}</Body>
            <Small>{t('mobile.capture.receipt_offer_for', { payee: receiptFor.label })}</Small>
          </View>
          <Button
            label={t('mobile.capture.receipt_add')}
            icon="scan"
            onPress={() => {
              const transactionId = receiptFor.id;
              setReceiptFor(null);
              router.push({ pathname: '/receipt-capture', params: { transactionId } });
            }}
            testID="qa-receipt-add"
          />
          <Pressable
            onPress={() => setReceiptFor(null)}
            accessibilityRole="button"
            accessibilityLabel={t('mobile.capture.receipt_not_now')}
            hitSlop={8}
            style={{ minWidth: th.tap, minHeight: th.tap, alignItems: 'center', justifyContent: 'center' }}
          >
            <Icon name="close" size={18} color={th.muted} />
          </Pressable>
        </Card>
      ) : null}
      {step === 'amount' ? (
        <View style={{ flexDirection: 'row', gap: th.space(2) }}>
          <ModeButton
            icon="scan"
            label={t('mobile.capture.mode_scan')}
            a11y={t('mobile.receipts.scan')}
            onPress={() => router.push('/receipt-capture')}
            testID="capture-receipt"
          />
          <ModeButton
            icon="keyboard"
            label={t('mobile.capture.mode_type')}
            a11y={t('mobile.capture.sentence')}
            onPress={() => {
              setTalking(false);
              setStep('sentence');
            }}
          />
          {voiceOnPlan ? (
            <ModeButton
              icon="mic"
              label={t('mobile.capture.speak')}
              a11y={t('mobile.capture.mic_start')}
              onPress={() => {
                setTalking(true);
                setStep('sentence');
                void voice.start(sentence);
              }}
              testID="qa-speak"
            />
          ) : null}
        </View>
      ) : null}
      {step === 'payee' ? (
        <Small>
          {fmtMoney(direction === 'expense' ? `-${digits || '0'}` : digits || '0', currency)}
          {account ? ` · ${account.name}` : ''}
        </Small>
      ) : null}
      {error ? <Banner tone="danger" text={error} /> : null}

      {step === 'sentence' ? (
        <>
          {!state?.online ? <Banner tone="warning" text={t('mobile.capture.sentence_offline')} /> : null}
          <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: th.space(2) }}>
            <View style={{ flex: 1 }}>
              <Field
                label={t('mobile.capture.sentence')}
                placeholder={t('mobile.capture.sentence_placeholder')}
                value={sentence}
                onChangeText={setSentence}
                autoFocus={!talking}
                multiline
                returnKeyType="done"
                blurOnSubmit
                onSubmitEditing={() => void parseSentence()}
                testID="qa-sentence"
              />
            </View>
            {voiceOnPlan ? (
              <Pressable
                onPress={() => {
                  haptic.tap();
                  if (voice.listening) voice.stop();
                  else void voice.start(sentence);
                }}
                accessibilityRole="button"
                accessibilityLabel={t(
                  voice.listening ? 'mobile.capture.mic_stop' : 'mobile.capture.mic_start',
                )}
                testID="qa-mic"
                style={({ pressed }) => ({
                  width: th.tap,
                  height: th.tap,
                  borderRadius: th.tap / 2,
                  alignItems: 'center',
                  justifyContent: 'center',
                  backgroundColor: voice.listening ? th.danger : th.primary,
                  opacity: pressed ? 0.8 : 1,
                })}
              >
                <Icon name={voice.listening ? 'stop' : 'mic'} size={20} color={th.onPrimary} />
              </Pressable>
            ) : null}
          </View>
          {voice.listening ? (
            <Small color={th.primary}>{t('mobile.capture.listening')}</Small>
          ) : voice.errorKey ? (
            <>
              <Banner tone="warning" text={t(voice.errorKey, { message: voice.errorDetail ?? '' })} />
              {voice.errorKey === 'mobile.capture.voice_denied' ? (
                // Android stops asking once the microphone has been refused; the app's settings page can still allow it.
                <Button
                  label={t('mobile.capture.voice_settings')}
                  kind="secondary"
                  onPress={() => void Linking.openSettings()}
                  testID="voice-settings"
                />
              ) : null}
            </>
          ) : (
            <Small>{t('mobile.capture.voice_hint')}</Small>
          )}
          <Button
            label={t('mobile.capture.next')}
            busy={busy}
            disabled={!sentence.trim() || !state?.online}
            onPress={() => void parseSentence()}
          />
        </>
      ) : null}

      {step === 'amount' ? (
        <>
          <Segmented
            label={t('mobile.capture.title')}
            value={direction}
            onChange={setDirection}
            options={[
              { value: 'expense', label: t('mobile.capture.expense') },
              { value: 'income', label: t('mobile.capture.income') },
            ]}
          />
          <Text
            accessibilityLabel={`${t('mobile.capture.amount')} ${digitsToDisplay(digits, exponent)} ${currency}`}
            accessibilityLiveRegion="polite"
            style={{
              color: th.text,
              fontSize: th.font.amount,
              fontWeight: '700',
              textAlign: 'center',
              fontVariant: ['tabular-nums'],
            }}
            testID="qa-amount-display"
          >
            {digitsToDisplay(digits, exponent)} {currency}
          </Text>
          <View
            style={{
              flexDirection: 'row',
              flexWrap: 'wrap',
              justifyContent: 'space-between',
              rowGap: 6,
            }}
          >
            {KEYS.map((k) => (
              <Pressable
                key={k}
                onPress={() => setDigits((d) => pressKey(d, k))}
                accessibilityRole="button"
                accessibilityLabel={k === 'back' ? 'Delete' : k}
                testID={`key-${k}`}
                style={({ pressed }) => ({
                  width: '32%',
                  height: 48,
                  borderRadius: th.radius,
                  alignItems: 'center',
                  justifyContent: 'center',
                  backgroundColor: pressed ? th.border : th.surface,
                })}
              >
                <Text style={{ color: th.text, fontSize: 22 }}>{k === 'back' ? '⌫' : k}</Text>
              </Pressable>
            ))}
          </View>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            accessibilityLabel={t('mobile.capture.account')}
            contentContainerStyle={{ gap: th.space(2), alignItems: 'center' }}
          >
            <Small>{t('mobile.capture.account')}</Small>
            {shownAccounts.map((a) => (
              <Pressable
                key={a.id}
                onPress={() => setAccountId(a.id)}
                accessibilityRole="radio"
                accessibilityState={{ checked: a.id === accountId }}
                style={{
                  paddingHorizontal: 12,
                  paddingVertical: 8,
                  borderRadius: 16,
                  backgroundColor: a.id === accountId ? th.primary : th.surface,
                }}
              >
                <Text style={{ color: a.id === accountId ? th.onPrimary : th.text }} numberOfLines={1}>
                  {a.name}
                </Text>
              </Pressable>
            ))}
            {accounts.length > shownAccounts.length ? (
              <Pressable
                onPress={() => setAllAccounts(true)}
                accessibilityRole="button"
                accessibilityLabel={t('mobile.capture.all_accounts')}
                testID="qa-all-accounts"
                style={{
                  paddingHorizontal: 14,
                  paddingVertical: 8,
                  borderRadius: 16,
                  backgroundColor: th.surface,
                }}
              >
                <Text style={{ color: th.text, fontWeight: '700' }}>…</Text>
              </Pressable>
            ) : null}
          </ScrollView>
          <Button
            label={t('mobile.capture.next')}
            disabled={!digits}
            onPress={() => setStep('payee')}
            testID="qa-next"
          />
        </>
      ) : null}

      {step === 'payee' ? (
        <>
          <Field
            label={t('mobile.capture.payee')}
            placeholder={t('mobile.capture.payee_placeholder')}
            value={payee}
            onChangeText={setPayee}
            autoFocus
            returnKeyType="next"
            onSubmitEditing={() => void choosePayee(payee.trim(), null)}
            testID="qa-payee"
          />
          {suggestions.map((s) => (
            <Row
              key={s.payee}
              title={s.payee}
              subtitle={s.categoryId ? byId.get(s.categoryId)?.name : undefined}
              onPress={() => void choosePayee(s.payee, s.categoryId)}
              testID={`payee-${s.payee}`}
            />
          ))}
          <Button
            label={t('mobile.capture.next')}
            disabled={!payee.trim()}
            onPress={() => void choosePayee(payee.trim(), null)}
          />
        </>
      ) : null}

      {step === 'confirm' ? (
        <Card>
          <Body style={{ fontSize: th.font.title, fontWeight: '700' }}>
            {fmtMoney(direction === 'expense' ? `-${digits || '0'}` : digits || '0', currency)}
          </Body>
          <Body>{payee}</Body>
          <Row
            title={category?.name ?? t('mobile.capture.choose_category')}
            subtitle={suggestion?.explanation ?? (category ? undefined : t('mobile.txn.uncategorized'))}
            onPress={() => setPicking(true)}
            testID="qa-category"
          />
          <Button label={t('mobile.capture.confirm')} onPress={() => void save()} testID="qa-save" />
        </Card>
      ) : null}

      <SidePanel
        visible={allAccounts}
        title={t('mobile.capture.account')}
        closeLabel={t('mobile.common.cancel')}
        onClose={() => setAllAccounts(false)}
        testID="qa-account-list"
      >
        {accounts.map((a, i) => (
          <Row
            key={a.id}
            title={a.name}
            subtitle={t(`account.kind.${a.kind}`)}
            right={a.id === accountId ? <Icon name="check" size={18} color={th.primary} /> : undefined}
            onPress={() => {
              haptic.select();
              setAccountId(a.id);
              setAllAccounts(false);
            }}
            last={i === accounts.length - 1}
          />
        ))}
      </SidePanel>
      <SuccessBurst label={saved} onDone={() => setSaved(null)} />
      <CategoryPicker
        visible={picking}
        categories={categories}
        kind={direction}
        onClose={() => setPicking(false)}
        onPick={(c) => {
          setCategory(c);
          setPicking(false);
        }}
      />
    </Screen>
  );
}
