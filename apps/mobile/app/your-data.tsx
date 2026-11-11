/**
 * Your data on the phone (BAK-04, NFR-06, AUTH-12, OPS-13): back up now and save the file, see the security log, and delete the account.
 * Restoring takes a large upload and a preview worth reading properly, so it's on the web.
 */
import { useCallback, useEffect, useState } from 'react';
import { Alert, Platform, Share, View } from 'react-native';
import { Directory, File, Paths } from 'expo-file-system';
import type {
  DeletionStatusDto,
  ExportJobDto,
  SecurityEventDto,
  StorageDestinationDto,
  StorageUsageDto,
} from '@montra/schemas';
import {
  hasRunningExport,
  humanBytes,
  needsFreshSignIn,
  storageStatusLine,
} from '../src/features/data-settings';
import { t } from '../src/i18n';
import { useSession } from '../src/session/SessionProvider';
import { Banner, Body, Button, Card, Field, Row, Screen, Small, Title } from '../src/ui/components';

const POLL_MS = 3000;

const failure = (err: unknown) => (needsFreshSignIn(err) ? t('mobile.data.reauth') : (err as Error).message);

export default function YourData() {
  const session = useSession();
  const { state, api } = session;
  const ws = state.status === 'signed_in' ? state.workspace.id : '';
  const [jobs, setJobs] = useState<ExportJobDto[]>([]);
  const [usage, setUsage] = useState<StorageUsageDto | null>(null);
  const [events, setEvents] = useState<SecurityEventDto[]>([]);
  const [deletion, setDeletion] = useState<DeletionStatusDto | null>(null);
  const [destination, setDestination] = useState<StorageDestinationDto | null>(null);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [b, u, e, d] = await Promise.all([
        api.listBackups(ws),
        api.storageUsage(ws),
        api.securityActivity(),
        api.deletionStatus(),
      ]);
      setJobs(b);
      setUsage(u);
      setEvents(e);
      setDeletion(d);
      // Owners only; for anyone else there's nothing to show.
      setDestination(await api.storageDestination(ws).catch(() => null));
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [api, ws]);

  useEffect(() => {
    if (ws) void load();
  }, [load, ws]);

  useEffect(() => {
    if (!hasRunningExport(jobs)) return;
    const timer = setTimeout(() => void load(), POLL_MS);
    return () => clearTimeout(timer);
  }, [jobs, load]);

  const backUp = async () => {
    if (password && password.length < 10) return setError(t('data.password_short'));
    setBusy(true);
    setError(null);
    try {
      await api.createBackup(ws, password ? { password } : {});
      setPassword('');
      setNotice(t('data.backup_started'));
      await load();
    } catch (err) {
      setError(failure(err));
    } finally {
      setBusy(false);
    }
  };

  const save = async (job: ExportJobDto) => {
    setBusy(true);
    setError(null);
    try {
      const folder = new Directory(Paths.cache, 'backups');
      if (!folder.exists) folder.create();
      const target = new File(folder, job.fileName ?? `${job.id}.zip`);
      if (target.exists) target.delete();
      const file = await File.downloadFileAsync(api.backupDownloadUrl(ws, job.id), target, {
        headers: await api.authHeaders(),
      });
      await Share.share(Platform.OS === 'ios' ? { url: file.uri } : { message: file.uri });
    } catch (err) {
      setError(failure(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = () =>
    Alert.alert(t('data.delete_account'), t('data.delete_hint'), [
      { text: t('mobile.common.cancel'), style: 'cancel' },
      {
        text: t('data.delete_confirm'),
        style: 'destructive',
        onPress: () =>
          void api
            .requestDeletion({ confirm: 'DELETE' })
            .then(() => session.signOut())
            .catch((err: unknown) => setError(failure(err))),
      },
    ]);

  return (
    <Screen testID="your-data">
      {error ? <Banner tone="danger" text={error} /> : null}
      {notice ? <Banner text={notice} /> : null}
      {usage ? (
        <Card testID="your-data-storage">
          <Small>{t('data.storage')}</Small>
          <Body>
            {t('data.storage_used', {
              used: humanBytes(usage.usedBytes) || '0 B',
              quota: humanBytes(usage.quotaBytes),
            })}
          </Body>
        </Card>
      ) : null}

      {destination ? (
        <Card testID="your-data-own-storage">
          <Small>{`${t('storage.title')} · ${destination.label} · ${t(`storage.status_${destination.status}`)}`}</Small>
          <Body>{t(storageStatusLine(destination).key, storageStatusLine(destination).values)}</Body>
          {destination.lastError ? (
            <Small>{`${t('storage.last_error')} ${destination.lastError}`}</Small>
          ) : null}
        </Card>
      ) : null}

      <Title>{t('data.backup')}</Title>
      <Card>
        <Small>{t('data.backup_hint')}</Small>
        <Field label={t('data.password')} value={password} onChangeText={setPassword} secureTextEntry />
        <Small>{t('data.password_hint')}</Small>
        <Button
          label={t('data.backup_now')}
          onPress={() => void backUp()}
          disabled={busy}
          testID="your-data-backup"
        />
      </Card>
      {jobs.map((j) => (
        <Row
          key={j.id}
          title={j.fileName ?? t(`data.kind_${j.kind}`)}
          subtitle={`${t(`data.status_${j.status}`)}${j.bytes ? ` · ${humanBytes(j.bytes)}` : ''}${
            j.storageCopy ? ` · ${t(`storage.copy_${j.storageCopy.status}`)}` : ''
          }`}
          onPress={j.status === 'ready' ? () => void save(j) : undefined}
          testID="your-data-export"
        />
      ))}
      <Small>{t('mobile.data.restore_on_web')}</Small>

      <Title>{t('security.title')}</Title>
      {events.length === 0 ? <Body muted>{t('security.empty')}</Body> : null}
      {events.slice(0, 20).map((e) => (
        <Row
          key={e.id}
          title={t(`security.kind_${e.kind}`)}
          subtitle={new Date(e.at).toLocaleString()}
          testID="your-data-event"
        />
      ))}

      <Title>{t('data.delete_account')}</Title>
      <View>
        <Small>{t('data.delete_hint')}</Small>
        {deletion?.workspaces.map((w) => (
          <Small key={w.id}>{w.name}</Small>
        ))}
        <Button
          kind="secondary"
          label={t('data.delete_confirm')}
          onPress={remove}
          testID="your-data-delete"
        />
      </View>
    </Screen>
  );
}
