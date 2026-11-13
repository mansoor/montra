/**
 * Forgot password on the phone (AUTH-05): an emailed single-use code, the second factor when the account has one,
 * then a new password measured against the policy. Every other device is signed out (Kratos's recovery hook).
 */
import { useState } from 'react';
import { KeyboardAvoidingView, Platform } from 'react-native';
import { useRouter } from 'expo-router';
import { t } from '../src/i18n';
import { useSession } from '../src/session/SessionProvider';
import { Banner, Body, Button, Field, Screen, Small, Title } from '../src/ui/components';
import { PasswordMeter, usePasswordCheck, usePasswordPolicy } from '../src/ui/PasswordMeter';

type Step =
  | { kind: 'email' }
  | { kind: 'code'; flowId: string }
  | { kind: 'second'; token: string; flowId: string; settingsFlowId: string | null }
  | { kind: 'password'; token: string; settingsFlowId: string | null };

export default function ForgotPassword() {
  const s = useSession();
  const router = useRouter();
  const policy = usePasswordPolicy(s.api);
  const [step, setStep] = useState<Step>({ kind: 'email' });
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [useRecoveryCode, setUseRecoveryCode] = useState(false);
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const check = usePasswordCheck(password, policy, { email });
  const kratos = s.kratos;

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  };
  if (!kratos) {
    return (
      <Screen testID="forgot-password">
        <Title>{t('mobile.auth.forgot_title')}</Title>
        <Body muted>{t('mobile.auth.dev_only')}</Body>
        <Button kind="secondary" label={t('auth.back_to_sign_in')} onPress={() => router.back()} />
      </Screen>
    );
  }

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <Screen testID="forgot-password">
        <Title>{t('mobile.auth.forgot_title')}</Title>
        {error ? <Banner tone="danger" text={error} /> : null}
        {step.kind === 'email' ? (
          <>
            <Body muted>{t('mobile.auth.forgot_body')}</Body>
            <Field
              label={t('mobile.signin.email')}
              value={email}
              onChangeText={setEmail}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="email-address"
              autoComplete="email"
              testID="forgot-email"
            />
            <Button
              label={t('mobile.auth.send_code')}
              busy={busy}
              disabled={!email.trim()}
              onPress={() =>
                void run(async () => {
                  const r = await kratos.startRecovery(email);
                  if (r.kind === 'error') return setError(r.message);
                  setStep({ kind: 'code', flowId: r.flowId });
                })
              }
              testID="forgot-send"
            />
          </>
        ) : step.kind === 'code' ? (
          <>
            {/* The same words whether or not the address has an account (AUTH-05). */}
            <Body>{t('mobile.auth.recovery_sent', { email: email.trim() })}</Body>
            <Field
              label={t('mobile.auth.code')}
              value={code}
              onChangeText={setCode}
              keyboardType="number-pad"
              textContentType="oneTimeCode"
              autoComplete="one-time-code"
              testID="forgot-code"
            />
            <Button
              label={t('mobile.auth.continue')}
              busy={busy}
              disabled={!code.trim()}
              onPress={() =>
                void run(async () => {
                  const r = await kratos.finishRecovery(step.flowId, code);
                  if (r.kind === 'error') return setError(r.message);
                  setCode('');
                  setStep(
                    r.secondStepFlowId
                      ? { kind: 'second', token: r.token, flowId: r.secondStepFlowId, settingsFlowId: null }
                      : { kind: 'password', token: r.token, settingsFlowId: r.settingsFlowId },
                  );
                })
              }
              testID="forgot-code-submit"
            />
          </>
        ) : step.kind === 'second' ? (
          <>
            <Body>{t(useRecoveryCode ? 'mobile.auth.recovery_code_hint' : 'mobile.signin.totp_hint')}</Body>
            <Field
              label={t(useRecoveryCode ? 'mobile.auth.recovery_code' : 'mobile.signin.totp')}
              value={code}
              onChangeText={setCode}
              autoCapitalize="none"
              keyboardType={useRecoveryCode ? 'default' : 'number-pad'}
              testID="forgot-second"
            />
            <Button
              label={t('mobile.signin.verify')}
              busy={busy}
              disabled={!code.trim()}
              onPress={() =>
                void run(async () => {
                  const r = useRecoveryCode
                    ? await kratos.recoveryCode(step.token, step.flowId, code)
                    : await kratos.totp(step.token, step.flowId, code);
                  if (r.kind === 'error') return setError(r.message);
                  setCode('');
                  setStep({ kind: 'password', token: step.token, settingsFlowId: null });
                })
              }
            />
            <Button
              kind="secondary"
              label={t(useRecoveryCode ? 'mobile.auth.use_authenticator' : 'mobile.auth.use_recovery_code')}
              onPress={() => setUseRecoveryCode(!useRecoveryCode)}
            />
          </>
        ) : (
          <>
            <Body>{t('mobile.auth.new_password_body')}</Body>
            <Field
              label={t('mobile.auth.new_password')}
              value={password}
              onChangeText={setPassword}
              secureTextEntry
              textContentType="newPassword"
              autoComplete="new-password"
              testID="forgot-password-new"
            />
            <PasswordMeter check={check} policy={policy} />
            <Button
              label={t('mobile.auth.save_password')}
              busy={busy}
              disabled={!check?.ok}
              onPress={() =>
                void run(async () => {
                  const r = await kratos.setPassword(step.token, password, step.settingsFlowId);
                  if (r.kind !== 'ok')
                    return setError(r.kind === 'error' ? r.message : t('mobile.auth.failed'));
                  await s.adopt(step.token);
                })
              }
              testID="forgot-save"
            />
            <Small>{t('mobile.auth.other_devices_signed_out')}</Small>
          </>
        )}
        <Button kind="secondary" label={t('auth.back_to_sign_in')} onPress={() => router.back()} />
      </Screen>
    </KeyboardAvoidingView>
  );
}
