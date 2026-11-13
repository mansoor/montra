/**
 * Create an account on the phone (AUTH-01..03): email, name and a password measured against the service's policy,
 * then the code Kratos emails to confirm the address. The auth gateway checks the password again (ADR-0043).
 */
import { useState } from 'react';
import { KeyboardAvoidingView, Platform } from 'react-native';
import { useRouter } from 'expo-router';
import { t } from '../src/i18n';
import { useSession } from '../src/session/SessionProvider';
import { Banner, Body, Button, Field, Screen, Small, Title } from '../src/ui/components';
import { PasswordMeter, usePasswordCheck, usePasswordPolicy } from '../src/ui/PasswordMeter';

type Step = { kind: 'form' } | { kind: 'verify'; token: string; flowId: string | null };

export default function SignUp() {
  const s = useSession();
  const router = useRouter();
  const policy = usePasswordPolicy(s.api);
  const [step, setStep] = useState<Step>({ kind: 'form' });
  const [email, setEmail] = useState('');
  const [first, setFirst] = useState('');
  const [last, setLast] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const check = usePasswordCheck(password, policy, { email, name: `${first} ${last}` });

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  };
  const kratos = s.kratos;
  if (!kratos) {
    return (
      <Screen testID="sign-up">
        <Title>{t('mobile.auth.sign_up_title')}</Title>
        <Body muted>{t('mobile.auth.dev_only')}</Body>
        <Button kind="secondary" label={t('auth.back_to_sign_in')} onPress={() => router.back()} />
      </Screen>
    );
  }

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <Screen testID="sign-up">
        <Title>{t('mobile.auth.sign_up_title')}</Title>
        {error ? <Banner tone="danger" text={error} /> : null}
        {note ? <Banner tone="info" text={note} /> : null}
        {step.kind === 'form' ? (
          <>
            <Field
              label={t('mobile.signin.email')}
              value={email}
              onChangeText={setEmail}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="email-address"
              textContentType="username"
              autoComplete="email"
              testID="sign-up-email"
            />
            <Field
              label={t('mobile.auth.first_name')}
              value={first}
              onChangeText={setFirst}
              textContentType="givenName"
              autoComplete="given-name"
              testID="sign-up-first"
            />
            <Field
              label={t('mobile.auth.last_name')}
              value={last}
              onChangeText={setLast}
              textContentType="familyName"
              autoComplete="family-name"
              testID="sign-up-last"
            />
            <Field
              label={t('mobile.signin.password')}
              value={password}
              onChangeText={setPassword}
              secureTextEntry
              textContentType="newPassword"
              autoComplete="new-password"
              testID="sign-up-password"
            />
            <PasswordMeter check={check} policy={policy} />
            <Button
              label={t('mobile.auth.create_account')}
              busy={busy}
              disabled={!email.trim() || !check?.ok}
              onPress={() =>
                void run(async () => {
                  const r = await kratos.signUp({ email, first, last, password });
                  if (r.kind === 'error') return setError(r.message);
                  setPassword('');
                  setStep({ kind: 'verify', token: r.token, flowId: r.verificationFlowId });
                })
              }
              testID="sign-up-submit"
            />
            <Button kind="secondary" label={t('auth.back_to_sign_in')} onPress={() => router.back()} />
          </>
        ) : (
          <>
            <Body>{t('mobile.auth.verify_body', { email: email.trim() })}</Body>
            <Field
              label={t('mobile.auth.code')}
              value={code}
              onChangeText={setCode}
              keyboardType="number-pad"
              textContentType="oneTimeCode"
              autoComplete="one-time-code"
              testID="verify-code"
            />
            <Button
              label={t('mobile.auth.verify')}
              busy={busy}
              disabled={!code.trim() || !step.flowId}
              onPress={() =>
                void run(async () => {
                  const r = await kratos.verifyEmail(step.flowId!, code);
                  if (r.kind !== 'ok')
                    return setError(r.kind === 'error' ? r.message : t('mobile.auth.failed'));
                  await s.adopt(step.token);
                })
              }
              testID="verify-submit"
            />
            <Button
              kind="secondary"
              label={t('mobile.auth.send_new_code')}
              disabled={busy}
              onPress={() =>
                void run(async () => {
                  const r = await kratos.sendVerification(email);
                  if (r.kind === 'error') return setError(r.message);
                  setStep({ ...step, flowId: r.flowId });
                  setNote(t('mobile.auth.code_sent'));
                })
              }
            />
            {/* The account works before the email is confirmed; money can't be added until it is (AUTH-03). */}
            <Button
              kind="secondary"
              label={t('mobile.auth.verify_later')}
              onPress={() => void s.adopt(step.token)}
            />
            <Small>{t('mobile.auth.verify_hint')}</Small>
          </>
        )}
      </Screen>
    </KeyboardAvoidingView>
  );
}
