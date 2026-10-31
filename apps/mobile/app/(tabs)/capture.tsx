/**
 * Quick add in ≤ 3 taps (TXN-01, 08 §3): type the amount on the keypad → tap Next → tap a suggested payee → tap
 * Save with the suggested category. Works offline (outbox); online it asks the pipeline for a category, offline it
 * reuses the last category for that payee. "Type a sentence" uses natural-language parsing when online (TXN-06).
 */
import { useEffect, useMemo, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import type { CategoryDto, SuggestionDto } from '@montra/schemas';
import { asCurrencyCode, minorUnits } from '@montra/domain';
import { fmtMoney, t } from '../../src/i18n';
import { useSession } from '../../src/session/SessionProvider';
import { useLocal, useSync } from '../../src/sync/SyncProvider';
import {
  buildCreateRequest,
  digitsToDisplay,
  payeeSuggestions,
  pressKey,
  type KeypadKey,
} from '../../src/features/quick-add';
import { todayLocal } from '../../src/features/home';
import { CategoryPicker } from '../../src/ui/CategoryPicker';
import {
  Banner,
  Body,
  Button,
  Card,
  Field,
  Row,
  Screen,
  Small,
  Title,
  useToast,
} from '../../src/ui/components';
import { useTheme } from '../../src/ui/theme';

type Step = 'amount' | 'payee' | 'confirm' | 'sentence';
const KEYS: KeypadKey[] = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '00', '0', 'back'];
const LAST_ACCOUNT = 'mobile.lastAccount';

export default function Capture() {
  const th = useTheme();
  const toast = useToast();
  const { state: session, api } = useSession();
  const { engine, store, state, touch } = useSync();
  const ws = session.status === 'signed_in' ? session.workspace.id : '';
  const accounts = (useLocal((s) => s.getReference('accounts')) ?? []).filter(
    (a) => !a.archived && !a.hidden,
  );
  const categories = useLocal((s) => s.getReference('categories')) ?? [];
  const history = useLocal((s) => s.listTransactions({ limit: 500 })) ?? [];

  const [step, setStep] = useState<Step>('amount');
  const [digits, setDigits] = useState('');
  const [direction, setDirection] = useState<'expense' | 'income'>('expense');
  const [accountId, setAccountId] = useState<string>('');
  const [payee, setPayee] = useState('');
  const [category, setCategory] = useState<CategoryDto | null>(null);
  const [suggestion, setSuggestion] = useState<SuggestionDto | null>(null);
  const [picking, setPicking] = useState(false);
  const [sentence, setSentence] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void store.getMeta(LAST_ACCOUNT).then((id) => {
      if (id && accounts.some((a) => a.id === id)) setAccountId(id);
      else if (!accountId && accounts[0]) setAccountId(accounts[0].id);
    });
    // Runs when the account list arrives.
  }, [accounts.length]);

  const account = accounts.find((a) => a.id === accountId);
  const currency = account?.currency ?? 'USD';
  const exponent = minorUnits(asCurrencyCode(currency));
  const suggestions = useMemo(() => payeeSuggestions(history, payee), [history, payee]);
  const byId = useMemo(() => new Map(categories.map((c) => [c.id, c])), [categories]);

  const reset = () => {
    setStep('amount');
    setDigits('');
    setPayee('');
    setCategory(null);
    setSuggestion(null);
    setSentence('');
    setError(null);
  };

  /** Tap 2: payee chosen → look up a category (online: pipeline; offline: last one used locally). */
  const choosePayee = async (name: string, localCategoryId: string | null) => {
    setPayee(name);
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
      await engine.createTransaction(req);
      await store.setMeta(LAST_ACCOUNT, accountId);
      touch();
      toast.show(t('mobile.capture.saved', { payee: payee || fmtMoney(req.amount.amount, currency) }));
      reset();
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
      setStep('confirm');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (accounts.length === 0)
    return (
      <Screen>
        <Title>{t('mobile.capture.title')}</Title>
        <Body muted>{t('mobile.capture.no_account')}</Body>
      </Screen>
    );

  return (
    <Screen testID="capture">
      <Title>{t('mobile.capture.title')}</Title>
      {error ? <Banner tone="danger" text={error} /> : null}

      {step === 'sentence' ? (
        <>
          {!state?.online ? <Banner tone="warning" text={t('mobile.capture.sentence_offline')} /> : null}
          <Field
            label={t('mobile.capture.sentence')}
            placeholder={t('mobile.capture.sentence_placeholder')}
            value={sentence}
            onChangeText={setSentence}
            autoFocus
            returnKeyType="done"
            onSubmitEditing={() => void parseSentence()}
            testID="qa-sentence"
          />
          <Button
            label={t('mobile.capture.next')}
            busy={busy}
            disabled={!sentence.trim() || !state?.online}
            onPress={() => void parseSentence()}
          />
          <Button kind="secondary" label={t('mobile.capture.keypad')} onPress={() => setStep('amount')} />
        </>
      ) : null}

      {step === 'amount' ? (
        <>
          <View style={{ flexDirection: 'row', gap: th.space(2) }}>
            {(['expense', 'income'] as const).map((d) => (
              <Pressable
                key={d}
                onPress={() => setDirection(d)}
                accessibilityRole="radio"
                accessibilityState={{ checked: direction === d }}
                style={{
                  flex: 1,
                  padding: th.space(2),
                  borderRadius: th.radius,
                  alignItems: 'center',
                  backgroundColor: direction === d ? th.primary : th.surface,
                }}
              >
                <Text style={{ color: direction === d ? th.onPrimary : th.text }}>
                  {t(`mobile.capture.${d}`)}
                </Text>
              </Pressable>
            ))}
          </View>
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
              rowGap: th.space(2),
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
                  width: '31%',
                  paddingVertical: th.space(4),
                  borderRadius: th.radius,
                  alignItems: 'center',
                  backgroundColor: pressed ? th.border : th.surface,
                })}
              >
                <Text style={{ color: th.text, fontSize: 24 }}>{k === 'back' ? '⌫' : k}</Text>
              </Pressable>
            ))}
          </View>
          <Small>{t('mobile.capture.account')}</Small>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: th.space(2) }}>
            {accounts.map((a) => (
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
                <Text style={{ color: a.id === accountId ? th.onPrimary : th.text }}>{a.name}</Text>
              </Pressable>
            ))}
          </View>
          <Button
            label={t('mobile.capture.next')}
            disabled={!digits}
            onPress={() => setStep('payee')}
            testID="qa-next"
          />
          <Button kind="secondary" label={t('mobile.capture.sentence')} onPress={() => setStep('sentence')} />
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
          <Button kind="secondary" label={t('mobile.common.cancel')} onPress={reset} />
        </Card>
      ) : null}

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
