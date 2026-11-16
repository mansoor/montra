/**
 * Where the phone stops when the server won't open the account or workspace (ADR-0049 §4, BAK-09), as the web's
 * `/account-closed` and `/account-deleting` pages: what happened, how to reach support, and the ways on (keep the
 * account, another workspace, try again, sign out). Nothing syncs while this shows.
 */
import { useEffect, useState } from 'react';
import { Alert, Linking, ScrollView } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { DeletionStatusDto } from '@montra/schemas';
import { config } from '../config';
import { closedCopy, otherWorkspaces, supportAddress, type Closed } from '../features/account-state';
import { currentLocale, t } from '../i18n';
import { useSession } from '../session/SessionProvider';
import { Banner, Body, Button, Card, Row, Small, Title } from './components';
import { useTheme } from './theme';

const longDate = (iso: string): string => {
  try {
    return new Intl.DateTimeFormat(currentLocale, { dateStyle: 'long' }).format(new Date(iso));
  } catch {
    return iso.slice(0, 10);
  }
};

export function AccountClosed({ closed }: { closed: Closed }) {
  const th = useTheme();
  const insets = useSafeAreaInsets();
  const session = useSession();
  const { api, state } = session;
  const [deletion, setDeletion] = useState<DeletionStatusDto | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const copy = closedCopy(closed.kind);
  const address = supportAddress(closed.message);
  const others = otherWorkspaces(
    closed,
    state.status === 'signed_in' || state.status === 'choose_workspace' ? state.workspaces : [],
    state.status === 'signed_in' ? state.workspace.id : null,
  );

  // The way back stays open while the account is being deleted: when it goes, and the button to keep it.
  useEffect(() => {
    if (closed.kind !== 'deleting') return;
    void api.deletionStatus().then(setDeletion, () => undefined);
  }, [api, closed.kind]);

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const signOut = () =>
    Alert.alert(t('mobile.settings.sign_out'), t('mobile.closed.sign_out_note'), [
      { text: t('mobile.common.cancel'), style: 'cancel' },
      { text: t('mobile.settings.sign_out'), style: 'destructive', onPress: () => void session.signOut() },
    ]);

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: th.bg }}
      contentContainerStyle={{
        padding: th.space(4),
        paddingTop: th.space(4) + insets.top,
        paddingBottom: th.space(4) + insets.bottom,
        gap: th.space(2),
      }}
      testID={`closed-${closed.kind}`}
    >
      <Title>{t(copy.title)}</Title>
      {error ? <Banner tone="danger" text={error} /> : null}
      {closed.kind === 'deleting' ? (
        <Card>
          {deletion ? (
            <Body>
              {deletion.purgeAfter
                ? t('account_deleting.when', { date: longDate(deletion.purgeAfter) })
                : t('account_deleting.not_requested')}
            </Body>
          ) : null}
          <Small>{t(copy.body)}</Small>
          <Button
            label={t('account_deleting.cancel')}
            busy={busy}
            onPress={() =>
              void act(async () => {
                await api.cancelDeletion();
                await session.reopen();
              })
            }
            testID="closed-keep-account"
          />
        </Card>
      ) : (
        <Card>
          <Body>{t(copy.body)}</Body>
          <Small>{t('closed.kept')}</Small>
        </Card>
      )}

      <Card testID="closed-support">
        <Small>{t('mobile.closed.support_hint')}</Small>
        {address ? (
          <Row
            title={t('mobile.closed.email_support', { address })}
            icon="info"
            onPress={() => void Linking.openURL(`mailto:${address}`)}
            testID="closed-email-support"
          />
        ) : null}
        <Row
          title={t('closed.help')}
          icon="website"
          last
          onPress={() => void Linking.openURL(`${config.webUrl}/help`)}
          testID="closed-help"
        />
      </Card>

      {others.length > 0 ? (
        <Card testID="closed-other-workspaces">
          <Small>{t('mobile.closed.other_workspaces')}</Small>
          {others.map((w, i) => (
            <Row
              key={w.id}
              title={w.name}
              last={i === others.length - 1}
              onPress={() => void session.chooseWorkspace(w.id)}
            />
          ))}
        </Card>
      ) : null}

      <Small>{t('mobile.closed.waiting')}</Small>
      <Button
        kind="secondary"
        label={t('mobile.closed.try_again')}
        busy={busy}
        onPress={() => void act(() => session.reopen())}
        testID="closed-try-again"
      />
      <Button
        kind="danger"
        label={t('mobile.settings.sign_out')}
        onPress={signOut}
        testID="closed-sign-out"
      />
    </ScrollView>
  );
}
