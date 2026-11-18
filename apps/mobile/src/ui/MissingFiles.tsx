/**
 * Review's "Files to provide again" on the phone (ADR-0054 §5a, VLT-10): files Montra no longer keeps a copy of that the
 * household's Family Document Vault didn't give back, each with what uses it and an Upload action that stores the paper
 * again under the same file. Read online like tax forms to check; its count keeps the Review badge current.
 */
import { useCallback, useState } from 'react';
import { View } from 'react-native';
import { useFocusEffect } from 'expo-router';
import * as DocumentPicker from 'expo-document-picker';
import type { MissingFileDto } from '@montra/schemas';
import { t } from '../i18n';
import {
  MISSING_FILE_TYPES,
  missingFileUses,
  providedAgainMessage,
  showsMissingFiles,
} from '../features/missing-files';
import { useMissingFiles } from '../features/use-missing-files';
import { useSession } from '../session/SessionProvider';
import { Body, Button, Small, useToast } from './components';
import { useTheme } from './theme';

export function MissingFilesReview() {
  const th = useTheme();
  const toast = useToast();
  const { state: session, api } = useSession();
  const badge = useMissingFiles();
  const ws = session.status === 'signed_in' ? session.workspace : null;
  const shown = ws !== null && showsMissingFiles(ws.role);
  const wsId = ws?.id ?? '';
  const [files, setFiles] = useState<MissingFileDto[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const { set } = badge;

  useFocusEffect(
    useCallback(() => {
      if (!shown) return;
      let alive = true;
      api.listMissingFiles(wsId).then(
        (list) => {
          if (!alive) return;
          setFiles(list);
          set(list.length);
        },
        // Offline: nothing to show; the badge keeps its last count.
        () => undefined,
      );
      return () => {
        alive = false;
      };
    }, [api, wsId, shown, set]),
  );

  const upload = async (f: MissingFileDto) => {
    const r = await DocumentPicker.getDocumentAsync({
      type: Object.keys(MISSING_FILE_TYPES),
      multiple: false,
      copyToCacheDirectory: true,
    });
    if (r.canceled || !r.assets[0]) return;
    const a = r.assets[0];
    const type = a.mimeType ? MISSING_FILE_TYPES[a.mimeType] : undefined;
    if (!type) return toast.show(t('missing_files.pick_hint'));
    setBusy(f.fileId);
    try {
      const done = await api.provideMissingFile(wsId, f.fileId, { uri: a.uri, name: a.name, type });
      const m = providedAgainMessage(done, f.fileName);
      toast.show(t(m.key, m.values));
      const rest = files.filter((x) => x.fileId !== f.fileId);
      setFiles(rest);
      set(rest.length);
    } catch (err) {
      toast.show((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  if (!shown || files.length === 0) return null;
  return (
    <View style={{ gap: th.space(1) }} testID="files-to-provide">
      <Body style={{ fontWeight: '700' }}>{t('missing_files.title')}</Body>
      <Small>{t('missing_files.intro')}</Small>
      {files.map((f) => (
        <View
          key={f.fileId}
          testID="missing-file"
          style={{ gap: th.space(1), paddingVertical: th.space(1), borderBottomColor: th.border }}
        >
          <Body>{f.fileName}</Body>
          <Small>
            {missingFileUses(f)
              .map((u) => (u.label ? `${t(u.key)}: ${u.label}` : t(u.key)))
              .join(' · ')}
          </Small>
          <Small color={th.muted}>{f.reason}</Small>
          <Button
            kind="secondary"
            label={t('missing_files.upload')}
            hint={t('missing_files.upload_named', { name: f.fileName })}
            busy={busy === f.fileId}
            disabled={busy !== null}
            onPress={() => void upload(f)}
            testID="missing-file-upload"
          />
        </View>
      ))}
    </View>
  );
}
