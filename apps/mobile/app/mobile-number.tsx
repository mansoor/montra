/**
 * The mobile number (ADR-0049 §6), as on the web's Settings → Security: Kratos's `traits.phone`, changed in a settings
 * flow. Reached only where this service sends texts. Kratos texts a code to a new number; it's entered here when
 * Kratos says which verification flow it belongs to. Changing it needs a recent sign-in (AUTH-09), asked for here.
 */
import { useCallback, useEffect, useState } from 'react';
import { Alert } from 'react-native';
import { parsePhone } from '../src/features/texts';
import { t } from '../src/i18n';
import { useSession } from '../src/session/SessionProvider';
import { Banner, Body, Button, Card, Field, Screen, SectionLabel, Small } from '../src/ui/components';

type Step =
  | { kind: 'loading' }
  | { kind: 'edit' }
  | { kind: 'code'; flowId: string; phone: string }
  | { kind: 'reauth'; then: () => Promise<void> };

export default function MobileNumber() {
  const s = useSession();
  const kratos = s.kratos;
  const email = s.state.status === 'signed_in' ? s.state.me.email : '';
  const [current, setCurrent] = useState<{ phone: string | null; verified: boolean } | null>(null);
  const [step, setStep] = useState<Step>({ kind: 'loading' });
  const [input, setInput] = useState('');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const token = await s.token();
    if (!kratos || !token) return;
    const r = await kratos.phoneStatus(token);
    if (r.kind === 'reauth') return setStep({ kind: 'reauth', then: refresh });
    if (r.kind === 'error') {
      setError(r.message);
      return setStep({ kind: 'edit' });
    }
    setCurrent({ phone: r.phone, verified: r.verified });
    setInput(r.phone ?? '');
    setStep({ kind: 'edit' });
  }, [kratos, s]);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const run = async (fn: (token: string) => Promise<void>) => {
    const token = await s.token();
    if (!kratos || !token) return;
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      await fn(token);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const save = (phone: string | null): Promise<void> =>
    run(async (token) => {
      const r = await kratos!.setPhone(token, phone);
      if (r.kind === 'reauth') return setStep({ kind: 'reauth', then: () => save(phone) });
      if (r.kind === 'error') return setError(r.message);
      await refresh();
      if (!phone) return setNote(t('mobile.phone.removed'));
      if (r.verificationFlowId) setStep({ kind: 'code', flowId: r.verificationFlowId, phone });
      setNote(t('mobile.phone.added', { phone }));
    });

  if (!kratos) {
    return (
      <Screen testID="mobile-number">
        <Body muted>{t('mobile.auth.dev_only')}</Body>
      </Screen>
    );
  }

  return (
    <Screen testID="mobile-number">
      {error ? <Banner tone="danger" text={error} /> : null}
      {note ? <Banner text={note} /> : null}

      {step.kind === 'edit' ? (
        <Card>
          <SectionLabel>{t('mobile.phone.label')}</SectionLabel>
          <Body>
            {current?.phone
              ? t(current.verified ? 'mobile.phone.verified' : 'mobile.phone.unverified', {
                  phone: current.phone,
                })
              : t('mobile.phone.none')}
          </Body>
          <Field
            label={t('mobile.phone.label')}
            value={input}
            onChangeText={setInput}
            keyboardType="phone-pad"
            textContentType="telephoneNumber"
            autoComplete="tel"
            testID="mobile-number-input"
          />
          <Small>{t('mobile.phone.hint')}</Small>
          <Button
            label={t(current?.phone ? 'mobile.phone.change' : 'mobile.phone.save')}
            busy={busy}
            disabled={!input.trim()}
            onPress={() => {
              const parsed = parsePhone(input);
              if (!parsed.ok) return setError(t(parsed.error));
              void save(parsed.phone);
            }}
            testID="mobile-number-save"
          />
          {current?.phone ? (
            <Button
              kind="secondary"
              label={t('mobile.phone.remove')}
              busy={busy}
              onPress={() =>
                Alert.alert(t('mobile.phone.remove'), t('mobile.phone.remove_confirm'), [
                  { text: t('mobile.common.cancel'), style: 'cancel' },
                  { text: t('mobile.phone.remove'), style: 'destructive', onPress: () => void save(null) },
                ])
              }
              testID="mobile-number-remove"
            />
          ) : null}
        </Card>
      ) : step.kind === 'code' ? (
        <Card>
          <SectionLabel>{t('mobile.phone.label')}</SectionLabel>
          <Field
            label={t('mobile.phone.code')}
            value={code}
            onChangeText={setCode}
            keyboardType="number-pad"
            textContentType="oneTimeCode"
            autoComplete="sms-otp"
            testID="mobile-number-code"
          />
          <Button
            label={t('mobile.phone.confirm')}
            busy={busy}
            disabled={!code.trim()}
            onPress={() =>
              void run(async () => {
                const r = await kratos.verifyCode(step.flowId, code);
                if (r.kind === 'error') return setError(r.message);
                if (r.kind === 'reauth') return setError(t('mobile.auth.failed'));
                setCode('');
                await refresh();
                setNote(t('mobile.phone.confirmed'));
              })
            }
            testID="mobile-number-confirm"
          />
          <Button
            kind="secondary"
            label={t('mobile.common.cancel')}
            onPress={() => setStep({ kind: 'edit' })}
          />
        </Card>
      ) : step.kind === 'reauth' ? (
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
              void run(async (token) => {
                const r = await kratos.reauthenticate(token, email, password);
                if (r.kind !== 'ok')
                  return setError(r.kind === 'error' ? r.message : t('mobile.auth.failed'));
                setPassword('');
                const then = step.then;
                setStep({ kind: 'edit' });
                await then();
              })
            }
          />
          <Button
            kind="secondary"
            label={t('mobile.common.cancel')}
            onPress={() => setStep({ kind: 'edit' })}
          />
        </Card>
      ) : null}
    </Screen>
  );
}
