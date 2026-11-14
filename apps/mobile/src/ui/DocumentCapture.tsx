/**
 * Capturing a paper document (ADR-0047, ADR-0048): the phone's document scanner opens first, finds the page's edges,
 * crops and straightens it, and takes several pages. Where the scanner can't run (Expo Go, a build without it, an
 * Android phone without Google Play services), or when someone prefers it, the app's own camera takes over. A photo
 * or PDF can be picked instead. Statements, payslips, bills and reimbursement photos use this; receipts have their
 * own screen because they queue offline.
 */
import { useEffect, useRef, useState } from 'react';
import { Image, ScrollView, View } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as DocumentPicker from 'expo-document-picker';
import { t } from '../i18n';
import { scanPages, type CapturedPage, type PageType } from '../features/scanner';
import { Banner, Body, Button, Small } from './components';
import { useTheme } from './theme';

const PICKABLE: Record<string, PageType> = {
  'image/jpeg': 'image/jpeg',
  'image/png': 'image/png',
  'image/webp': 'image/webp',
  'application/pdf': 'application/pdf',
};

export interface DocumentCaptureProps {
  /** What the person is capturing, for the hints: "Scan the bill" and so on. */
  scanLabel: string;
  scanHint: string;
  cameraHint: string;
  /** Receives the pages: scanned, shot or picked. Runs while the buttons show busy. */
  onPages: (pages: CapturedPage[]) => Promise<void>;
  /** Picking a photo or PDF instead of scanning; off where another picker already offers files. */
  pick?: boolean;
  /** Opens the scanner as soon as the screen shows (the default): that's what the screen is for. */
  autoStart?: boolean;
  /** Busy elsewhere (uploading): the buttons wait. */
  busy?: boolean;
  testID?: string;
}

export function DocumentCapture({
  scanLabel,
  scanHint,
  cameraHint,
  onPages,
  pick = true,
  autoStart = true,
  busy: outerBusy = false,
  testID,
}: DocumentCaptureProps) {
  const th = useTheme();
  const camera = useRef<CameraView>(null);
  const [permission, requestPermission] = useCameraPermissions();
  const [mode, setMode] = useState<'scanner' | 'camera'>('scanner');
  const [scannerGone, setScannerGone] = useState(false);
  const [shots, setShots] = useState<CapturedPage[]>([]);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const launched = useRef(false);
  const busy = working || outerBusy;

  const hand = async (pages: CapturedPage[]) => {
    if (pages.length === 0) return;
    setWorking(true);
    setError(null);
    try {
      await onPages(pages);
      setShots([]);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setWorking(false);
    }
  };

  const scan = async () => {
    setWorking(true);
    setError(null);
    const r = await scanPages();
    setWorking(false);
    if (r.kind === 'scanned')
      return hand(
        r.uris.map((uri, i) => ({ uri, type: 'image/jpeg', name: `page-${i + 1}.jpg`, shot: true })),
      );
    if (r.kind === 'unavailable') {
      setScannerGone(true);
      setMode('camera');
    }
  };

  useEffect(() => {
    if (!autoStart || launched.current) return;
    launched.current = true;
    void scan();
    // Once, when the screen opens.
  }, []);

  const shoot = async () => {
    if (!camera.current) return;
    setWorking(true);
    setError(null);
    try {
      const pic = await camera.current.takePictureAsync({ quality: 0.85, shutterSound: false });
      if (pic)
        setShots((p) => [
          ...p,
          { uri: pic.uri, type: 'image/jpeg', name: `page-${p.length + 1}.jpg`, shot: true },
        ]);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setWorking(false);
    }
  };

  const choose = async () => {
    const r = await DocumentPicker.getDocumentAsync({
      type: Object.keys(PICKABLE),
      multiple: true,
      copyToCacheDirectory: true,
    });
    if (r.canceled) return;
    const picked = r.assets
      .filter((a) => a.mimeType && PICKABLE[a.mimeType])
      .map((a) => ({ uri: a.uri, type: PICKABLE[a.mimeType!]!, name: a.name, shot: false }));
    if (picked.length === 0) return setError(t('mobile.receipts.pick_hint'));
    await hand(picked);
  };

  const pickButton = pick ? (
    <Button kind="secondary" label={t('mobile.receipts.pick')} busy={busy} onPress={() => void choose()} />
  ) : null;

  if (mode === 'scanner')
    return (
      <View style={{ gap: th.space(2) }} testID={testID}>
        <Small>{scanHint}</Small>
        <Button label={scanLabel} busy={busy} onPress={() => void scan()} testID="document-scan" />
        <Button
          kind="secondary"
          label={t('mobile.receipts.use_camera')}
          onPress={() => setMode('camera')}
          testID="document-use-camera"
        />
        {pickButton}
        {error ? <Banner tone="danger" text={error} /> : null}
      </View>
    );
  if (!permission?.granted)
    return (
      <View style={{ gap: th.space(2) }} testID={testID}>
        <Body>{t('mobile.capture.camera_permission')}</Body>
        <Button label={t('mobile.common.retry')} onPress={() => void requestPermission()} />
        {pickButton}
        {error ? <Banner tone="danger" text={error} /> : null}
      </View>
    );
  return (
    <View style={{ gap: th.space(2) }} testID={testID}>
      {scannerGone ? <Banner tone="info" text={t('mobile.receipts.scanner_unavailable')} /> : null}
      <Small>{cameraHint}</Small>
      <View style={{ height: 420, borderRadius: th.radius, overflow: 'hidden' }}>
        <CameraView ref={camera} style={{ flex: 1 }} facing="back" />
      </View>
      <Button
        label={shots.length ? t('mobile.receipts.add_page') : t('mobile.receipts.shoot')}
        busy={busy}
        onPress={() => void shoot()}
        testID="document-shoot"
      />
      {shots.length > 0 ? (
        <ScrollView horizontal contentContainerStyle={{ gap: th.space(2) }}>
          {shots.map((p, i) => (
            <Image
              key={p.uri}
              source={{ uri: p.uri }}
              accessibilityLabel={t('mobile.receipts.page_n', { n: i + 1 })}
              style={{ width: 72, height: 96, borderRadius: 4 }}
            />
          ))}
        </ScrollView>
      ) : null}
      {shots.length > 0 ? (
        <Button
          label={t('mobile.receipts.done', { count: shots.length })}
          busy={busy}
          onPress={() => void hand(shots)}
          testID="document-done"
        />
      ) : null}
      {pickButton}
      {error ? <Banner tone="danger" text={error} /> : null}
    </View>
  );
}
