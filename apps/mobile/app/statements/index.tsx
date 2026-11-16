/**
 * Statements on the phone (IMP-09): the statements imported so far, newest first, each with its file, account,
 * the day it was imported, its status and the rows it added, as the web's import history shows them. "Import a
 * statement" opens the import flow. Read live from the server, so it needs a connection; undo is on the web.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { View } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import type { ImportBatchDto } from '@montra/schemas';
import { fmtDate, t } from '../../src/i18n';
import { useAbilities, useSession } from '../../src/session/SessionProvider';
import { useLocal, useSync } from '../../src/sync/SyncProvider';
import { statementRows, type StatementTone } from '../../src/features/statements';
import { Banner, Body, Button, Card, Row, Screen, Small, Title } from '../../src/ui/components';
import { NotAllowed } from '../../src/ui/NotAllowed';
import { useTheme } from '../../src/ui/theme';

export default function Statements() {
  const th = useTheme();
  const router = useRouter();
  const { state: session, api } = useSession();
  const { state: sync } = useSync();
  // Imports are for those who set the books up (AUTH-18), as the More row is.
  const allowed = useAbilities().importFiles;
  const ws = session.status === 'signed_in' ? session.workspace.id : '';
  const accounts = useLocal((s) => s.getReference('accounts'));
  const [batches, setBatches] = useState<ImportBatchDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    if (!ws || !allowed) return;
    try {
      setBatches(await api.listImports(ws));
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [api, ws, allowed]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const names = useMemo(() => new Map((accounts ?? []).map((a) => [a.id, a.name])), [accounts]);
  const rows = useMemo(() => statementRows(batches ?? [], names), [batches, names]);

  // A statement being read or imported changes on the server; look again every few seconds until none is.
  const busy = rows.some((r) => r.busy);
  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(() => void load(), 5000);
    return () => clearInterval(timer);
  }, [busy, load]);

  const toneColor: Record<StatementTone, string> = {
    good: th.success,
    warn: th.warning,
    bad: th.danger,
    muted: th.muted,
  };

  if (!allowed) {
    return (
      <Screen testID="statements">
        <NotAllowed />
      </Screen>
    );
  }
  return (
    <Screen
      testID="statements"
      refreshing={refreshing}
      onRefresh={() => {
        setRefreshing(true);
        void load().finally(() => setRefreshing(false));
      }}
    >
      <Button
        icon="import"
        label={t('mobile.statements.import')}
        onPress={() => router.push('/import')}
        testID="statement-import"
      />
      {error && sync && !sync.online ? <Body muted>{t('mobile.statements.offline')}</Body> : null}
      {error && (!sync || sync.online) ? <Banner tone="danger" text={error} /> : null}
      {batches && rows.length === 0 ? (
        <Card testID="statements-empty">
          <Body>{t('mobile.statements.empty_title')}</Body>
          <Small>{t('mobile.statements.empty')}</Small>
        </Card>
      ) : null}
      {rows.length ? <Title>{t('mobile.statements.history')}</Title> : null}
      {rows.length ? (
        <Card>
          {rows.map((r, i) => (
            <Row
              key={r.id}
              testID="statement-row"
              title={r.fileName}
              subtitle={[r.accountName, fmtDate(r.importedOn)].filter(Boolean).join(' · ')}
              right={
                <View style={{ alignItems: 'flex-end', gap: 2 }}>
                  <Small color={toneColor[r.tone]}>{t(r.statusKey)}</Small>
                  {r.count ? <Small>{t(r.count.key, { count: r.count.count })}</Small> : null}
                </View>
              }
              last={i === rows.length - 1}
            />
          ))}
        </Card>
      ) : null}
    </Screen>
  );
}
