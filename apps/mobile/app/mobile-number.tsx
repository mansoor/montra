/**
 * The mobile number (ADR-0049 §6), as on the web's Settings → Security: the API texts a code to the number, and the
 * number is the account's once the code comes back. Reached only where this service sends texts. Adding, changing and
 * removing it need a recent sign-in (AUTH-09); when the API asks, the password is asked for here.
 */
import { useCallback, useEffect, useState } from 'react';
import { Alert } from 'react-native';
import type { PhoneStatusDto } from '@montra/schemas';
import { needsFreshSignIn } from '../src/features/data-settings';
import { parsePhone } from '../src/features/texts';
import { t } from '../src/i18n';
import { useSession } from '../src/session/SessionProvider';
import { Banner, Body, Button, Card, Field, Screen, SectionLabel, Small } from '../src/ui/components';

type Step =
  { kind: 'edit' } | { kind: 'code'; sentTo: string } | { kind: 'reauth'; then: () => Promise<void> };

export default function MobileNumber() {
  const s = useSession();
  const { api, kratos } = s;
  const email = s.state.status === 'signed_in' ? s.state.me.email : '';
  const [status, setStatus] = useState<PhoneStatusDto | null>(null);
  const [step, setStep] = useState<Step>({ kind: 'edit' });
  const [input, setInput] = useState('');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const next = await api.phone();
      setStatus(next);
      if (next.pending) setStep({ kind: 'code', sentTo: next.pending.phone });
    } catch (err) {
      setError((err as Error).message);
    }
  }, [api]);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  /** Runs a change; a stale sign-in asks for the password, then runs it again. */
  const run = async (fn: () => Promise<void>): Promise<void> => {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      await fn();
    } catch (err) {
      if (needsFreshSignIn(err) && kratos) setStep({ kind: 'reauth', then: () => run(fn) });
      else setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const send = (phone: string) =>
    run(async () => {
      const sent = await api.startPhone(phone);
      setStep({ kind: 'code', sentTo: sent.phone });
    });

  return (
    <Screen testID="mobile-number">
      {error ? <Banner tone="danger" text={error} /> : null}
      {note ? <Banner text={note} /> : null}

      {step.kind === 'edit' ? (
        <Card>
          <SectionLabel>{t('phone.title')}</SectionLabel>
          {status ? (
            <Body>
              {status.phone
                ? t(status.verified ? 'phone.current_verified' : 'phone.current_unverified', {
                    phone: status.phone,
                  })
                : t('phone.none')}
            </Body>
          ) : null}
          <Field
            label={t('phone.title')}
            value={input}
            onChangeText={setInput}
            keyboardType="phone-pad"
            textContentType="telephoneNumber"
            autoComplete="tel"
            testID="mobile-number-input"
          />
          <Small>{t('phone.hint')}</Small>
          <Button
            label={t('phone.send')}
            busy={busy}
            disabled={!input.trim()}
            onPress={() => {
              const parsed = parsePhone(input);
              if (!parsed.ok) return setError(t(parsed.error));
              void send(parsed.phone);
            }}
            testID="mobile-number-send"
          />
          {status?.phone ? (
            <Button
              kind="secondary"
              label={t('phone.remove')}
              busy={busy}
              onPress={() =>
                Alert.alert(t('phone.remove'), t('phone.remove_confirm'), [
                  { text: t('mobile.common.cancel'), style: 'cancel' },
                  {
                    text: t('phone.remove'),
                    style: 'destructive',
                    onPress: () =>
                      void run(async () => {
                        setStatus(await api.removePhone());
                        setNote(t('phone.removed'));
                      }),
                  },
                ])
              }
              testID="mobile-number-remove"
            />
          ) : null}
        </Card>
      ) : step.kind === 'code' ? (
        <Card>
          <SectionLabel>{t('phone.title')}</SectionLabel>
          <Body>{t('phone.sent', { phone: step.sentTo })}</Body>
          <Field
            label={t('phone.code')}
            value={code}
            onChangeText={setCode}
            keyboardType="number-pad"
            textContentType="oneTimeCode"
            autoComplete="sms-otp"
            maxLength={6}
            testID="mobile-number-code"
          />
          <Button
            label={t('phone.confirm')}
            busy={busy}
            disabled={code.trim().length !== 6}
            onPress={() =>
              void run(async () => {
                setStatus(await api.confirmPhone(code.trim()));
                setCode('');
                setInput('');
                setStep({ kind: 'edit' });
                setNote(t('phone.confirmed'));
              })
            }
            testID="mobile-number-confirm"
          />
          <Button
            kind="secondary"
            label={t('phone.change')}
            onPress={() => setStep({ kind: 'edit' })}
            testID="mobile-number-change"
          />
        </Card>
      ) : (
        <Card>
          <SectionLabel>{t('mobile.auth.confirm_password')}</SectionLabel>
          <Body>{t('mobile.auth.reauth_body')}</Body>
          <Field
            label={t('mobile.signin.password')}
            value={password}
            onChangeText={setPassword}
            secureTextEntry
            textContentType="password"
            autoComplete="password"
            testID="mobile-number-password"
          />
          <Button
            label={t('mobile.auth.continue')}
            busy={busy}
            disabled={!password}
            onPress={() =>
              void (async () => {
                const token = await s.token();
                if (!kratos || !token) return;
                setBusy(true);
                const r = await kratos.reauthenticate(token, email, password);
                setBusy(false);
                if (r.kind !== 'ok')
                  return setError(r.kind === 'error' ? r.message : t('mobile.auth.failed'));
                setPassword('');
                const then = step.then;
                setStep({ kind: 'edit' });
                await then();
              })()
            }
          />
          <Button
            kind="secondary"
            label={t('mobile.common.cancel')}
            onPress={() => setStep({ kind: 'edit' })}
          />
        </Card>
      )}
    </Screen>
  );
}
