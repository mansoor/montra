/**
 * Receipt capture (TXN-08, TXN-09, 08 §3). The phone's document scanner opens first (ADR-0047): it finds the
 * receipt's edges, crops and straightens it, and takes several pages for a long one. Where it isn't available, or
 * when asked, the app's own camera takes over (expo-camera, ADR-0009), with a blur and glare check after each shot.
 * A photo or PDF can be picked instead. The capture is kept on the device and queued, so it works offline; the queue
 * uploads when the network is back.
 */
import { useEffect, useRef, useState } from 'react';
import { Image, ScrollView, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as Crypto from 'expo-crypto';
import * as DocumentPicker from 'expo-document-picker';
import * as ImageManipulator from 'expo-image-manipulator';
import jpeg from 'jpeg-js';
import type { ReceiptPageType } from '@montra/sync';
import { t } from '../src/i18n';
import { useAbilities } from '../src/session/SessionProvider';
import { useSync } from '../src/sync/SyncProvider';
import { NotAllowed } from '../src/ui/NotAllowed';
import { assessFrame } from '../src/features/camera-metrics';
import { base64ToBytes } from '../src/features/base64';
import { frameVerdict, type FrameVerdict } from '../src/features/receipt-capture';
import { scanReceipt } from '../src/features/scanner';
import { keepPages } from '../src/receipts/files';
import { Banner, Body, Button, Screen, Small } from '../src/ui/components';
import { useTheme } from '../src/ui/theme';

interface Shot {
  uri: string;
  type: ReceiptPageType;
  name?: string;
  verdict: FrameVerdict | null;
}

const PICKABLE: Record<string, ReceiptPageType> = {
  'image/jpeg': 'image/jpeg',
  'image/png': 'image/png',
  'image/webp': 'image/webp',
  'application/pdf': 'application/pdf',
};

export default function ReceiptCapture() {
  const th = useTheme();
  const router = useRouter();
  const { transactionId } = useLocalSearchParams<{ transactionId?: string }>();
  const { receipts, state, touch } = useSync();
  const camera = useRef<CameraView>(null);
  const can = useAbilities();
  const [permission, requestPermission] = useCameraPermissions();
  const [pages, setPages] = useState<Shot[]>([]);
  const [doubtful, setDoubtful] = useState<Shot | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The scanner first; the app's camera when the scanner isn't there or someone prefers it.
  const [mode, setMode] = useState<'scanner' | 'camera'>('scanner');
  const [scannerGone, setScannerGone] = useState(false);
  const launched = useRef(false);

  /** Sharpness and glare on a 256-px copy (camera spike metrics). */
  const assess = async (uri: string): Promise<FrameVerdict> => {
    const small = await ImageManipulator.manipulateAsync(uri, [{ resize: { width: 256 } }], {
      format: ImageManipulator.SaveFormat.JPEG,
      compress: 0.9,
      base64: true,
    });
    const img = jpeg.decode(base64ToBytes(small.base64 ?? ''), { useTArray: true, formatAsRGBA: true });
    return frameVerdict(assessFrame(img.data, img.width, img.height));
  };

  const shoot = async () => {
    if (!camera.current) return;
    setBusy(true);
    setError(null);
    try {
      const pic = await camera.current.takePictureAsync({ quality: 0.8, shutterSound: false });
      if (!pic) return;
      const shot: Shot = { uri: pic.uri, type: 'image/jpeg', verdict: await assess(pic.uri) };
      if (shot.verdict === 'ok') setPages((p) => [...p, shot]);
      else setDoubtful(shot);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  /** Keeps the files, queues the receipt and starts uploading if online. */
  const finish = async (shots: Shot[]) => {
    if (shots.length === 0) return;
    setBusy(true);
    try {
      const id = Crypto.randomUUID();
      const kept = await keepPages(id, shots);
      await receipts.enqueue({ id, pages: kept, transactionId: transactionId ?? null });
      touch();
      void receipts.process().finally(touch);
      router.replace({ pathname: '/receipts', params: { queued: state?.online ? 'uploading' : 'offline' } });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const scan = async () => {
    setBusy(true);
    setError(null);
    const r = await scanReceipt();
    setBusy(false);
    // The scanner has its own sharpness check and lets the person retake, so its pages are kept as they are.
    if (r.kind === 'scanned')
      return finish(r.uris.map((uri) => ({ uri, type: 'image/jpeg' as const, verdict: 'ok' })));
    if (r.kind === 'unavailable') {
      setScannerGone(true);
      setMode('camera');
    }
  };

  // Straight into the scanner: that's what this screen is for.
  useEffect(() => {
    if (!can.record || launched.current) return;
    launched.current = true;
    void scan();
  }, [can.record]);

  const pick = async () => {
    const r = await DocumentPicker.getDocumentAsync({
      type: Object.keys(PICKABLE),
      multiple: true,
      copyToCacheDirectory: true,
    });
    if (r.canceled) return;
    const shots = r.assets
      .map((a) => ({ a, type: a.mimeType ? PICKABLE[a.mimeType] : undefined }))
      .filter((x): x is { a: (typeof r.assets)[number]; type: ReceiptPageType } => Boolean(x.type))
      .map(({ a, type }) => ({ uri: a.uri, type, name: a.name, verdict: null }));
    if (shots.length === 0) return setError(t('mobile.receipts.pick_hint'));
    await finish(shots);
  };

  if (!can.record)
    return (
      <Screen testID="receipt-capture">
        <NotAllowed />
      </Screen>
    );
  if (mode === 'scanner')
    return (
      <Screen testID="receipt-capture">
        <Small>{t('mobile.receipts.scan_hint')}</Small>
        <Button
          label={t('mobile.receipts.scan')}
          busy={busy}
          onPress={() => void scan()}
          testID="receipt-scan"
        />
        <Button
          kind="secondary"
          label={t('mobile.receipts.use_camera')}
          onPress={() => setMode('camera')}
          testID="receipt-use-camera"
        />
        <Button kind="secondary" label={t('mobile.receipts.pick')} onPress={() => void pick()} />
        {error ? <Banner tone="danger" text={error} /> : null}
      </Screen>
    );
  if (!permission?.granted)
    return (
      <Screen testID="receipt-capture">
        <Body>{t('mobile.receipts.camera_permission')}</Body>
        <Button label={t('mobile.common.retry')} onPress={() => void requestPermission()} />
        <Button kind="secondary" label={t('mobile.receipts.pick')} onPress={() => void pick()} />
      </Screen>
    );

  return (
    <Screen testID="receipt-capture">
      {scannerGone ? <Banner tone="info" text={t('mobile.receipts.scanner_unavailable')} /> : null}
      <Small>{t('mobile.receipts.capture_hint')}</Small>
      <View style={{ height: 420, borderRadius: th.radius, overflow: 'hidden' }}>
        <CameraView ref={camera} style={{ flex: 1 }} facing="back" />
      </View>
      {doubtful ? (
        <View style={{ gap: th.space(2) }}>
          <Banner tone="warning" text={t(`mobile.receipts.verdict.${doubtful.verdict}`)} />
          <View style={{ flexDirection: 'row', gap: th.space(2) }}>
            <View style={{ flex: 1 }}>
              <Button label={t('mobile.receipts.retake')} onPress={() => setDoubtful(null)} testID="retake" />
            </View>
            <View style={{ flex: 1 }}>
              <Button
                kind="secondary"
                label={t('mobile.receipts.keep')}
                onPress={() => {
                  setPages((p) => [...p, doubtful]);
                  setDoubtful(null);
                }}
              />
            </View>
          </View>
        </View>
      ) : (
        <Button
          label={pages.length ? t('mobile.receipts.add_page') : t('mobile.receipts.shoot')}
          busy={busy}
          onPress={() => void shoot()}
          testID="receipt-shoot"
        />
      )}
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
          kind="primary"
          label={t('mobile.receipts.done', { count: pages.length })}
          busy={busy}
          onPress={() => void finish(pages)}
          testID="receipt-done"
        />
      ) : null}
      <Button kind="secondary" label={t('mobile.receipts.pick')} onPress={() => void pick()} />
      {error ? <Banner tone="danger" text={error} /> : null}
    </Screen>
  );
}
