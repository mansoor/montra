/**
 * Payslip capture (PAY-03): photograph a payslip (several shots for several pages) or pick a PDF or photo. Unlike
 * receipts there's no offline queue: a payslip isn't left on the device (PAY-09), and photos are removed from the
 * app's cache once uploaded.
 */
import { useRef, useState } from 'react';
import { Image, ScrollView, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as DocumentPicker from 'expo-document-picker';
import { t } from '../../src/i18n';
import { removePage } from '../../src/receipts/files';
import { useSession } from '../../src/session/SessionProvider';
import { Banner, Body, Button, Screen, Small } from '../../src/ui/components';
import { useTheme } from '../../src/ui/theme';

interface Page {
  uri: string;
  name: string;
  type: string;
  /** Our own camera file, removed after upload; picked files belong to the picker's cache. */
  shot: boolean;
}

const PICKABLE = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];

export default function PayslipCapture() {
  const th = useTheme();
  const router = useRouter();
  const { employerId } = useLocalSearchParams<{ employerId: string }>();
  const { state: session, api } = useSession();
  const ws = session.status === 'signed_in' ? session.workspace.id : '';
  const camera = useRef<CameraView>(null);
  const [permission, requestPermission] = useCameraPermissions();
  const [pages, setPages] = useState<Page[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const shoot = async () => {
    if (!camera.current) return;
    setBusy(true);
    setError(null);
    try {
      const pic = await camera.current.takePictureAsync({ quality: 0.85, shutterSound: false });
      if (!pic) return;
      setPages((p) => [
        ...p,
        { uri: pic.uri, name: `payslip-${p.length + 1}.jpg`, type: 'image/jpeg', shot: true },
      ]);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const finish = async (list: Page[]) => {
    if (list.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const fileIds: string[] = [];
      for (const p of list) {
        const f = await api.uploadPayslipFile(ws, { uri: p.uri, name: p.name, type: p.type });
        fileIds.push(f.fileId);
      }
      const payslip = await api.createPayslip(ws, { employerId, fileIds });
      await Promise.all(list.filter((p) => p.shot).map((p) => removePage(p.uri)));
      router.replace(`/payslips/${payslip.id}`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const pick = async () => {
    const r = await DocumentPicker.getDocumentAsync({
      type: PICKABLE,
      multiple: true,
      copyToCacheDirectory: true,
    });
    if (r.canceled) return;
    const picked = r.assets
      .filter((a) => a.mimeType && PICKABLE.includes(a.mimeType))
      .map((a) => ({ uri: a.uri, name: a.name, type: a.mimeType!, shot: false }));
    if (picked.length === 0) return setError(t('mobile.receipts.pick_hint'));
    await finish(picked);
  };

  if (!permission?.granted)
    return (
      <Screen testID="payslip-capture">
        <Body>{t('mobile.payslips.camera_permission')}</Body>
        <Button label={t('mobile.common.retry')} onPress={() => void requestPermission()} />
        <Button kind="secondary" label={t('mobile.receipts.pick')} busy={busy} onPress={() => void pick()} />
        {error ? <Banner tone="danger" text={error} /> : null}
      </Screen>
    );

  return (
    <Screen testID="payslip-capture">
      <Small>{t('mobile.payslips.capture_hint')}</Small>
      <View style={{ height: 420, borderRadius: th.radius, overflow: 'hidden' }}>
        <CameraView ref={camera} style={{ flex: 1 }} facing="back" />
      </View>
      <Button
        label={pages.length ? t('mobile.receipts.add_page') : t('mobile.receipts.shoot')}
        busy={busy}
        onPress={() => void shoot()}
        testID="payslip-shoot"
      />
      {pages.length > 0 ? (
        <ScrollView horizontal contentContainerStyle={{ gap: th.space(2) }}>
          {pages.map((p, i) => (
            <Image
              key={p.uri}
              source={{ uri: p.uri }}
              accessibilityLabel={t('mobile.receipts.page_n', { n: i + 1 })}
              style={{ width: 72, height: 96, borderRadius: 4 }}
            />
          ))}
        </ScrollView>
      ) : null}
      {pages.length > 0 ? (
        <Button
          label={t('mobile.receipts.done', { count: pages.length })}
          busy={busy}
          onPress={() => void finish(pages)}
          testID="payslip-done"
        />
      ) : null}
      <Button kind="secondary" label={t('mobile.receipts.pick')} busy={busy} onPress={() => void pick()} />
      {error ? <Banner tone="danger" text={error} /> : null}
    </Screen>
  );
}
