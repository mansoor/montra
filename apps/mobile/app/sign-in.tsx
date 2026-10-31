/** Sign-in (AUTH-01/02): email + password through Kratos (TOTP when required), or dev sign-in. */
import { useState } from 'react';
import { KeyboardAvoidingView, Platform } from 'react-native';
import { config } from '../src/config';
import { t } from '../src/i18n';
import { useSession } from '../src/session/SessionProvider';
import { Banner, Body, Button, Field, Row, Screen, Small, Title } from '../src/ui/components';

export default function SignIn() {
  const s = useSession();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  };
  const st = s.state;

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <Screen testID="sign-in">
        <Title>{t('mobile.signin.title')}</Title>
        {st.status === 'needs_totp' ? (
          <>
            <Body muted>{t('mobile.signin.totp_hint')}</Body>
            {st.error ? <Banner tone="danger" text={st.error} /> : null}
            <Field
              label={t('mobile.signin.totp')}
              value={code}
              onChangeText={setCode}
              keyboardType="number-pad"
              textContentType="oneTimeCode"
              autoComplete="one-time-code"
              testID="totp"
            />
            <Button
              label={t('mobile.signin.verify')}
              busy={busy}
              onPress={() => void run(() => s.submitTotp(code))}
            />
          </>
        ) : st.status === 'choose_workspace' ? (
          <>
            <Body>{t('mobile.signin.workspace')}</Body>
            {st.workspaces.length === 0 ? <Body muted>{t('mobile.signin.no_workspace')}</Body> : null}
            {st.workspaces.map((w) => (
              <Row
                key={w.id}
                title={w.name}
                subtitle={w.baseCurrency}
                onPress={() => void s.chooseWorkspace(w.id)}
              />
            ))}
          </>
        ) : (
          <>
            {st.status === 'signed_out' && st.error ? <Banner tone="danger" text={st.error} /> : null}
            <Field
              label={t('mobile.signin.email')}
              value={email}
              onChangeText={setEmail}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="email-address"
              textContentType="username"
              autoComplete="email"
              testID="email"
            />
            {config.authMode === 'kratos' ? (
              <Field
                label={t('mobile.signin.password')}
                value={password}
                onChangeText={setPassword}
                secureTextEntry
                textContentType="password"
                autoComplete="password"
                testID="password"
              />
            ) : (
              <Small>{t('mobile.signin.dev_note')}</Small>
            )}
            <Button
              label={t('mobile.signin.submit')}
              busy={busy || st.status === 'loading'}
              disabled={!email.trim()}
              onPress={() => void run(() => s.signIn(email, password))}
              testID="sign-in-submit"
            />
          </>
        )}
      </Screen>
    </KeyboardAvoidingView>
  );
}
