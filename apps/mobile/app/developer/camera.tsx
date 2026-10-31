/**
 * Camera spike harness (Phase 4 week 1, ADR-0009; protocol in docs/design/spikes/phase4-camera.md). Measures
 * shutter → preview latency, sharpness (variance of Laplacian) and glare per capture, records operator judgement,
 * and exports the log as JSON. Uses expo-camera; see the spike doc for the vision-camera comparison.
 */
import { useEffect, useRef, useState } from 'react';
import { Image, Platform, Share, View } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as Device from 'expo-device';
import * as ImageManipulator from 'expo-image-manipulator';
import jpeg from 'jpeg-js';
import { t } from '../../src/i18n';
import { useSync } from '../../src/sync/SyncProvider';
import { assessFrame, summarize, type SpikeSample } from '../../src/features/camera-metrics';
import { base64ToBytes } from '../../src/features/base64';
import { Body, Button, Card, Screen, Small } from '../../src/ui/components';
import { useTheme } from '../../src/ui/theme';

const LOG_KEY = 'spike.camera.v1';

export default function CameraSpike() {
  const th = useTheme();
  const { store } = useSync();
  const camera = useRef<CameraView>(null);
  const [permission, requestPermission] = useCameraPermissions();
  const [kind, setKind] = useState<SpikeSample['kind']>('receipt');
  const [samples, setSamples] = useState<SpikeSample[]>([]);
  const [preview, setPreview] = useState<{ uri: string; started: number } | null>(null);
  const [last, setLast] = useState<SpikeSample | null>(null);
  const [busy, setBusy] = useState(false);
  const device =
    `${Device.manufacturer ?? ''} ${Device.modelName ?? ''} (${Platform.OS} ${Platform.Version})`.trim();

  useEffect(() => {
    void store.getMeta(LOG_KEY).then((v) => v && setSamples(JSON.parse(v) as SpikeSample[]));
  }, [store]);

  const save = async (next: SpikeSample[]) => {
    setSamples(next);
    await store.setMeta(LOG_KEY, JSON.stringify(next));
  };

  const capture = async () => {
    if (!camera.current) return;
    setBusy(true);
    const started = Date.now();
    try {
      const pic = await camera.current.takePictureAsync({ quality: 0.8, shutterSound: false });
      if (pic) setPreview({ uri: pic.uri, started });
    } finally {
      setBusy(false);
    }
  };

  /** Latency stops when the preview image has rendered; quality is computed on a 256-px copy afterwards. */
  const onPreviewLoaded = async () => {
    if (!preview) return;
    const latencyMs = Date.now() - preview.started;
    const small = await ImageManipulator.manipulateAsync(preview.uri, [{ resize: { width: 256 } }], {
      format: ImageManipulator.SaveFormat.JPEG,
      compress: 0.9,
      base64: true,
    });
    const img = jpeg.decode(base64ToBytes(small.base64 ?? ''), { useTArray: true, formatAsRGBA: true });
    const q = assessFrame(img.data, img.width, img.height);
    const sample: SpikeSample = {
      at: new Date().toISOString(),
      device,
      kind,
      latencyMs,
      blur: Number(q.blur.toFixed(1)),
      glare: Number(q.glare.toFixed(4)),
      usable: null,
    };
    setLast(sample);
    await save([...samples, sample]);
  };

  const judge = async (usable: boolean) => {
    if (!last) return;
    const next = samples.map((s) => (s.at === last.at ? { ...s, usable } : s));
    setLast({ ...last, usable });
    await save(next);
  };

  const sum = summarize(samples);

  if (!permission?.granted)
    return (
      <Screen>
        <Body>{t('mobile.spike.permission')}</Body>
        <Button label={t('mobile.common.retry')} onPress={() => void requestPermission()} />
      </Screen>
    );

  return (
    <Screen testID="camera-spike">
      <View style={{ flexDirection: 'row', gap: th.space(2) }}>
        {(['receipt', 'statement'] as const).map((k) => (
          <View key={k} style={{ flex: 1 }}>
            <Button
              kind={kind === k ? 'primary' : 'secondary'}
              label={t(`mobile.spike.kind.${k}`)}
              onPress={() => setKind(k)}
            />
          </View>
        ))}
      </View>
      <View style={{ height: 360, borderRadius: th.radius, overflow: 'hidden' }}>
        <CameraView ref={camera} style={{ flex: 1 }} facing="back" />
      </View>
      <Button
        label={t('mobile.spike.capture')}
        busy={busy}
        onPress={() => void capture()}
        testID="spike-capture"
      />
      {preview ? (
        <Image
          source={{ uri: preview.uri }}
          style={{ height: 160, resizeMode: 'contain' }}
          onLoad={() => void onPreviewLoaded()}
        />
      ) : null}
      {last ? (
        <Card>
          <Body>{t('mobile.spike.latency', { ms: last.latencyMs })}</Body>
          <Body>
            {t('mobile.spike.blur', {
              value: last.blur,
              verdict: last.blur >= 100 ? t('mobile.spike.sharp') : t('mobile.spike.blurry'),
            })}
          </Body>
          <Body>{t('mobile.spike.glare', { value: (last.glare * 100).toFixed(1) })}</Body>
          <View style={{ flexDirection: 'row', gap: th.space(2) }}>
            <View style={{ flex: 1 }}>
              <Button
                kind={last.usable === true ? 'primary' : 'secondary'}
                label={t('mobile.spike.usable')}
                onPress={() => void judge(true)}
              />
            </View>
            <View style={{ flex: 1 }}>
              <Button
                kind={last.usable === false ? 'danger' : 'secondary'}
                label={t('mobile.spike.unusable')}
                onPress={() => void judge(false)}
              />
            </View>
          </View>
        </Card>
      ) : null}
      <Small>
        {t('mobile.spike.summary', {
          samples: sum.samples,
          p50: sum.p50,
          p95: sum.p95,
          sharp: (sum.sharpShare * 100).toFixed(0),
        })}
      </Small>
      <Button
        kind="secondary"
        label={t('mobile.spike.export')}
        onPress={() =>
          void Share.share({ message: JSON.stringify({ device, summary: sum, samples }, null, 2) })
        }
      />
      <Button kind="danger" label={t('mobile.spike.clear')} onPress={() => void save([])} />
    </Screen>
  );
}
