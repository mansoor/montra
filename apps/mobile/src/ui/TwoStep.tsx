/**
 * Two-step verification on the phone (AUTH-04, AUTH-06): an authenticator app and single-use recovery codes.
 * Changing them needs a recent sign-in (AUTH-09); when Kratos asks, the password is asked for here.
 */
import { useCallback, useEffect, useState } from 'react';
import { Image, Text, View } from 'react-native';
import type { TwoStepStatus } from '../auth/kratos';
import { t } from '../i18n';
import { useSession } from '../session/SessionProvider';
import { Banner, Body, Button, Card, Field, SectionLabel, Small } from './components';
import { useTheme } from './theme';

type Panel =
  | { kind: 'overview' }
  | { kind: 'authenticator'; flowId: string; secret: string; qr: string | null }
  | { kind: 'codes'; flowId: string; codes: string[] }
  | { kind: 'reauth'; then: 'authenticator' | 'codes' };

export function TwoStep({ onDone, required }: { onDone?: () => void; required?: boolean }) {
  const s = useSession();
  const th = useTheme();
  const [status, setStatus] = useState<TwoStepStatus | null>(null);
  const [panel, setPanel] = useState<Panel>({ kind: 'overview' });
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const kratos = s.kratos;
  const email =
    s.state.status === 'signed_in' || s.state.status === 'choose_workspace' ? s.state.me.email : '';

  const refresh = useCallback(async () => {
    const token = await s.token();
    if (kratos && token) setStatus(await kratos.twoStepStatus(token));
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
    } finally {
      setBusy(false);
    }
  };
  const openAuthenticator = () =>
    run(async (token) => {
      const r = await kratos!.startAuthenticator(token);
      if (r.kind === 'reauth') return setPanel({ kind: 'reauth', then: 'authenticator' });
      if (r.kind === 'error') return setError(r.message);
      if (r.kind === 'already_linked') return setNote(t('mobile.auth.authenticator_on'));
      setPanel({ kind: 'authenticator', flowId: r.flowId, secret: r.secret, qr: r.qr });
    });
  const openCodes = () =>
    run(async (token) => {
      const r = await kratos!.newRecoveryCodes(token);
      if (r.kind === 'reauth') return setPanel({ kind: 'reauth', then: 'codes' });
      if (r.kind === 'error') return setError(r.message);
      setPanel({ kind: 'codes', flowId: r.flowId, codes: r.codes });
    });

  if (!kratos) return <Body muted>{t('mobile.auth.dev_only')}</Body>;

  return (
    <View style={{ gap: th.space(2) }} testID="two-step">
      {required ? <Banner tone="warning" text={t('mobile.auth.two_step_required')} /> : null}
      {error ? <Banner tone="danger" text={error} /> : null}
      {note ? <Banner tone="info" text={note} /> : null}

      {panel.kind === 'overview' ? (
        <>
          <Card>
            <SectionLabel>{t('mobile.auth.authenticator')}</SectionLabel>
            <Body>
              {t(status?.authenticator ? 'mobile.auth.authenticator_on' : 'mobile.auth.authenticator_off')}
            </Body>
            {status?.authenticator ? null : (
              <Button
                label={t('mobile.auth.set_up_authenticator')}
                busy={busy}
                onPress={() => void openAuthenticator()}
              />
            )}
          </Card>
          <Card>
            <SectionLabel>{t('mobile.auth.recovery_codes')}</SectionLabel>
            <Body>{t('mobile.auth.recovery_codes_body')}</Body>
            <Button
              kind="secondary"
              label={t(
                status?.recoveryCodes ? 'mobile.auth.new_recovery_codes' : 'mobile.auth.make_recovery_codes',
              )}
              busy={busy}
              disabled={!status?.authenticator}
              onPress={() => void openCodes()}
            />
          </Card>
          {required && status?.authenticator && onDone ? (
            // Setting one up doesn't strengthen this session: a code from it does, and opens the workspace.
            <Card testID="two-step-finish">
              <Body>{t('mobile.auth.finish_with_code')}</Body>
              <Field
                label={t('mobile.signin.totp')}
                value={code}
                onChangeText={setCode}
                keyboardType="number-pad"
                textContentType="oneTimeCode"
                autoComplete="one-time-code"
                testID="two-step-finish-code"
              />
              <Button
                label={t('mobile.auth.continue')}
                busy={busy}
                disabled={!code.trim()}
                onPress={() =>
                  void run(async (token) => {
                    const flowId = await kratos.secondStep(token);
                    const r = flowId ? await kratos.totp(token, flowId, code) : null;
                    if (r?.kind === 'error') return setError(r.message);
                    setCode('');
                    onDone();
                  })
                }
                testID="two-step-continue"
              />
            </Card>
          ) : null}
        </>
      ) : panel.kind === 'authenticator' ? (
        <Card>
          <SectionLabel>{t('mobile.auth.set_up_authenticator')}</SectionLabel>
          <Body>{t('mobile.auth.authenticator_steps')}</Body>
          {/* The key, to type or paste into an authenticator app on this phone; the QR code is for another device. */}
          <Text
            selectable
            style={{ fontFamily: 'monospace', fontSize: th.font.body, color: th.text }}
            testID="totp-secret"
          >
            {panel.secret}
          </Text>
          {panel.qr ? (
            <Image
              source={{ uri: panel.qr }}
              style={{ width: 180, height: 180, alignSelf: 'center' }}
              accessibilityLabel={t('mobile.auth.qr_label')}
            />
          ) : null}
          <Field
            label={t('mobile.signin.totp')}
            value={code}
            onChangeText={setCode}
            keyboardType="number-pad"
            textContentType="oneTimeCode"
            autoComplete="one-time-code"
            testID="totp-confirm-code"
          />
          <Button
            label={t('mobile.auth.turn_on')}
            busy={busy}
            disabled={!code.trim()}
            onPress={() =>
              void run(async (token) => {
                const r = await kratos.confirmAuthenticator(token, panel.flowId, code);
                if (r.kind === 'reauth') return setPanel({ kind: 'reauth', then: 'authenticator' });
                if (r.kind === 'error') return setError(r.message);
                setCode('');
                await refresh();
                // Recovery codes next: the way back in if this phone is lost.
                await openCodes();
              })
            }
            testID="totp-confirm"
          />
          <Button
            kind="secondary"
            label={t('mobile.common.cancel')}
            onPress={() => setPanel({ kind: 'overview' })}
          />
        </Card>
      ) : panel.kind === 'codes' ? (
        <Card>
          <SectionLabel>{t('mobile.auth.recovery_codes')}</SectionLabel>
          <Body>{t('mobile.auth.save_codes')}</Body>
          <Text
            selectable
            style={{ fontFamily: 'monospace', fontSize: th.font.body, color: th.text, lineHeight: 24 }}
            testID="recovery-codes"
          >
            {panel.codes.join('\n')}
          </Text>
          <Button
            label={t('mobile.auth.saved_codes')}
            busy={busy}
            onPress={() =>
              void run(async (token) => {
                const r = await kratos.confirmRecoveryCodes(token, panel.flowId);
                if (r.kind === 'reauth') return setPanel({ kind: 'reauth', then: 'codes' });
                if (r.kind === 'error') return setError(r.message);
                await refresh();
                setPanel({ kind: 'overview' });
                setNote(t('mobile.auth.codes_saved'));
              })
            }
            testID="codes-confirm"
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
            testID="reauth-password"
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
                const then = panel.then;
                setPanel({ kind: 'overview' });
                await (then === 'authenticator' ? openAuthenticator() : openCodes());
              })
            }
          />
          <Button
            kind="secondary"
            label={t('mobile.common.cancel')}
            onPress={() => setPanel({ kind: 'overview' })}
          />
        </Card>
      )}
      <Small>{t('mobile.auth.two_step_hint')}</Small>
    </View>
  );
}
