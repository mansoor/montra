/**
 * Statement import on mobile (IMP-02, PLT-04): pick a file (Files, email attachments, iCloud/Drive), receive one from
 * the share sheet / "Open in Montra", or scan paper pages with the camera (combined into a PDF that the server reads
 * with OCR). Then a simplified preview, the guided column mapping when needed, commit and the summary.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, Switch, View } from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import * as ImageManipulator from 'expo-image-manipulator';
import * as Print from 'expo-print';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { useShareIntentContext } from 'expo-share-intent';
import type { ImportBatchDto, ImportRowDto } from '@montra/schemas';
import type { UploadFile } from '../src/api/client';
import { fmtDate, fmtMoney, prefersDayFirst, t } from '../src/i18n';
import { useSession } from '../src/session/SessionProvider';
import { useLocal, useSync } from '../src/sync/SyncProvider';
import {
  IMPORT_MIME_TYPES,
  buildMapping,
  choicesFromProposal,
  fileTypeOf,
  nextStep,
  type GuidedChoices,
} from '../src/features/import-mapping';
import { Banner, Body, Button, Card, Row, Screen, Small, Title } from '../src/ui/components';
import { useTheme } from '../src/ui/theme';

type Phase = 'pick' | 'scan' | 'working' | 'mapping' | 'preview' | 'done';
const WAITING = new Set(['uploaded', 'parsing', 'committing']);

export default function ImportScreen() {
  const th = useTheme();
  const { state: session, api } = useSession();
  const { state: sync, refresh } = useSync();
  const share = useShareIntentContext();
  const ws = session.status === 'signed_in' ? session.workspace.id : '';
  const accounts = (useLocal((s) => s.getReference('accounts')) ?? []).filter((a) => !a.archived);
  const [accountId, setAccountId] = useState('');
  const [phase, setPhase] = useState<Phase>('pick');
  const [message, setMessage] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [batch, setBatch] = useState<ImportBatchDto | null>(null);
  const [rows, setRows] = useState<ImportRowDto[]>([]);
  const [choices, setChoices] = useState<GuidedChoices | null>(null);
  const [pages, setPages] = useState<string[]>([]);
  const camera = useRef<CameraView>(null);
  const [permission, requestPermission] = useCameraPermissions();

  useEffect(() => {
    if (!accountId && accounts[0]) setAccountId(accounts[0].id);
  }, [accounts, accountId]);

  /** Polls the batch until the server has finished the current step. */
  const settle = useCallback(
    async (id: string): Promise<ImportBatchDto> => {
      for (;;) {
        const b = await api.getImport(ws, id);
        setBatch(b);
        if (!WAITING.has(b.status)) return b;
        await new Promise((r) => setTimeout(r, 1200));
      }
    },
    [api, ws],
  );

  const show = useCallback(
    async (b: ImportBatchDto) => {
      if (b.status === 'failed') {
        setError(t('mobile.import.failed', { error: b.error ?? b.job?.error ?? '' }));
        setPhase('pick');
      } else if (b.status === 'needs_mapping') {
        setChoices(choicesFromProposal(b.mapping));
        setPhase('mapping');
      } else if (b.status === 'committed') {
        setPhase('done');
        void refresh();
      } else {
        setRows(await api.importRows(ws, b.id));
        setPhase('preview');
      }
    },
    [api, ws, refresh],
  );

  const start = useCallback(
    async (file: UploadFile) => {
      if (!sync?.online) return setError(t('mobile.import.offline'));
      if (!accountId) return;
      setError(null);
      setPhase('working');
      try {
        setMessage(t('mobile.import.uploading'));
        const up = await api.upload(ws, file);
        setMessage(t('mobile.import.reading'));
        const created = await api.createImport(ws, up.fileId, accountId);
        await show(await settle(created.id));
      } catch (e) {
        setError((e as Error).message);
        setPhase('pick');
      }
    },
    [api, ws, accountId, sync?.online, settle, show],
  );

  // A file shared into Montra from another app.
  const shared = share.shareIntent.files?.[0];
  useEffect(() => {
    if (shared && accountId && phase === 'pick') {
      void start({ uri: shared.path, name: shared.fileName, type: shared.mimeType });
      share.resetShareIntent();
    }
  }, [shared, accountId, phase, start, share]);

  const pick = async () => {
    const r = await DocumentPicker.getDocumentAsync({ type: [...IMPORT_MIME_TYPES], copyToCacheDirectory: true });
    if (r.canceled || !r.assets[0]) return;
    const a = r.assets[0];
    if (!fileTypeOf(a.name, a.mimeType)) return setError(t('mobile.import.pick_hint'));
    await start({ uri: a.uri, name: a.name, type: a.mimeType ?? 'application/octet-stream' });
  };

  const addPage = async () => {
    const pic = await camera.current?.takePictureAsync({ quality: 0.7 });
    if (!pic) return;
    // Grayscale-friendly size for OCR; the server redacts before any AI step (AIA-03).
    const small = await ImageManipulator.manipulateAsync(pic.uri, [{ resize: { width: 1600 } }], {
      compress: 0.7,
      format: ImageManipulator.SaveFormat.JPEG,
      base64: true,
    });
    if (small.base64) setPages((p) => [...p, small.base64!]);
  };

  const finishScan = async () => {
    const html = `<html><body style="margin:0">${pages
      .map((b64) => `<img src="data:image/jpeg;base64,${b64}" style="width:100%;page-break-after:always"/>`)
      .join('')}</body></html>`;
    const pdf = await Print.printToFileAsync({ html });
    setPages([]);
    await start({ uri: pdf.uri, name: `scan-${Date.now()}.pdf`, type: 'application/pdf' });
  };

  const applyMapping = async () => {
    if (!batch?.analysis || !choices) return;
    try {
      const mapping = buildMapping(choices, batch.analysis, batch.mapping, prefersDayFirst);
      setPhase('working');
      setMessage(t('mobile.import.reading'));
      await api.setMapping(ws, batch.id, mapping);
      await show(await settle(batch.id));
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const toggle = async (row: ImportRowDto) => {
    if (!batch) return;
    const next = row.effective === 'skip' ? 'import' : 'skip';
    const updated = await api.setRowDecision(ws, batch.id, row.id, next);
    setRows((rs) => rs.map((r) => (r.id === row.id ? updated : r)));
  };

  const commit = async () => {
    if (!batch) return;
    setPhase('working');
    setMessage(t('mobile.import.reading'));
    try {
      await api.commitImport(ws, batch.id);
      await show(await settle(batch.id));
    } catch (e) {
      setError((e as Error).message);
      setPhase('preview');
    }
  };

  const willImport = rows.filter((r) => r.effective === 'import' || r.effective === 'match').length;

  return (
    <Screen testID="import">
      {error ? <Banner tone="danger" text={error} /> : null}
      {!sync?.online ? <Banner tone="warning" text={t('mobile.import.offline')} /> : null}

      {phase === 'pick' ? (
        <>
          <Title>{t('mobile.import.title')}</Title>
          <Small>{t('mobile.import.account')}</Small>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: th.space(2) }}>
            {accounts.map((a) => (
              <Pressable
                key={a.id}
                onPress={() => setAccountId(a.id)}
                accessibilityRole="radio"
                accessibilityState={{ checked: a.id === accountId }}
                style={{ paddingHorizontal: 12, paddingVertical: 8, borderRadius: 16, backgroundColor: a.id === accountId ? th.primary : th.surface }}
              >
                <Body style={{ color: a.id === accountId ? th.onPrimary : th.text }}>{a.name}</Body>
              </Pressable>
            ))}
          </View>
          <Button label={t('mobile.import.pick')} onPress={() => void pick()} disabled={!accountId} testID="import-pick" />
          <Small>{t('mobile.import.pick_hint')}</Small>
          <Button kind="secondary" label={t('mobile.import.scan')} onPress={() => setPhase('scan')} disabled={!accountId} />
        </>
      ) : null}

      {phase === 'scan' ? (
        <>
          <Small>{t('mobile.import.scan_note')}</Small>
          {permission?.granted ? (
            <View style={{ height: 420, borderRadius: th.radius, overflow: 'hidden' }}>
              <CameraView ref={camera} style={{ flex: 1 }} facing="back" />
            </View>
          ) : (
            <Button label={t('mobile.spike.permission')} onPress={() => void requestPermission()} />
          )}
          <Button label={t('mobile.import.scan_add')} onPress={() => void addPage()} disabled={!permission?.granted} />
          <Button
            kind="secondary"
            label={t('mobile.import.scan_done', { count: pages.length })}
            onPress={() => void finishScan()}
            disabled={pages.length === 0}
          />
          <Button kind="secondary" label={t('mobile.common.cancel')} onPress={() => setPhase('pick')} />
        </>
      ) : null}

      {phase === 'working' ? <Body>{message}</Body> : null}

      {phase === 'mapping' && batch?.analysis && choices ? (
        <GuidedMapping
          batch={batch}
          choices={choices}
          onChange={setChoices}
          onApply={() => void applyMapping()}
        />
      ) : null}

      {phase === 'preview' && batch ? (
        <>
          <Title>{batch.fileName}</Title>
          <Body>
            {t('mobile.import.preview', {
              new: batch.counts.new,
              duplicates: batch.counts.duplicate + batch.counts.probableDuplicate,
              matches: batch.counts.match,
            })}
          </Body>
          {batch.balanceCheck === 'ok' ? <Banner text={t('mobile.import.balance_ok')} /> : null}
          {batch.balanceCheck === 'mismatch' ? <Banner tone="warning" text={t('mobile.import.balance_mismatch')} /> : null}
          <Button label={t('mobile.import.commit', { count: willImport })} onPress={() => void commit()} testID="import-commit" />
          {rows.slice(0, 200).map((r) => (
            <Row
              key={r.id}
              title={r.payee ?? r.description ?? ''}
              subtitle={[r.date ? fmtDate(r.date) : null, r.suggestion?.explanation, r.status !== 'new' ? r.status : null].filter(Boolean).join(' · ')}
              right={
                <View style={{ alignItems: 'flex-end', gap: 4 }}>
                  <Body>{r.amount ? fmtMoney(r.amount.amount, r.amount.currency) : ''}</Body>
                  <Switch
                    value={r.effective !== 'skip'}
                    onValueChange={() => void toggle(r)}
                    disabled={r.effective === 'fail'}
                    accessibilityLabel={r.effective === 'skip' ? t('mobile.import.include') : t('mobile.import.skip')}
                  />
                </View>
              }
            />
          ))}
        </>
      ) : null}

      {phase === 'done' && batch ? (
        <Card>
          <Title>{batch.fileName}</Title>
          <Body>
            {t('mobile.import.done', {
              added: batch.counts.added,
              matched: batch.counts.matched,
              skipped: batch.counts.skipped,
            })}
          </Body>
          <Button label={t('mobile.import.pick')} onPress={() => setPhase('pick')} />
        </Card>
      ) : null}
    </Screen>
  );
}

/** One question per step: date, description, amount (or money out + money in), then a preview of the first rows. */
function GuidedMapping({
  batch,
  choices,
  onChange,
  onApply,
}: {
  batch: ImportBatchDto;
  choices: GuidedChoices;
  onChange: (c: GuidedChoices) => void;
  onApply: () => void;
}) {
  const th = useTheme();
  const analysis = batch.analysis!;
  const header = analysis.header ?? analysis.sample[0]?.map((_, i) => `Column ${i + 1}`) ?? [];
  const firstData = analysis.sample[analysis.header ? 1 : 0] ?? [];
  const step = nextStep(choices);
  const [two, setTwo] = useState(choices.amount === null && choices.debit !== null);
  const question =
    step === 'date'
      ? t('mobile.import.map_date')
      : step === 'description'
        ? t('mobile.import.map_description')
        : step === 'amount'
          ? two
            ? choices.debit === null
              ? t('mobile.import.map_debit')
              : t('mobile.import.map_credit')
            : t('mobile.import.map_amount')
          : t('mobile.import.mapping');
  const choose = (i: number) => {
    if (step === 'date') onChange({ ...choices, date: i });
    else if (step === 'description') onChange({ ...choices, description: i });
    else if (step === 'amount' && !two) onChange({ ...choices, amount: i, debit: null, credit: null });
    else if (step === 'amount' && choices.debit === null) onChange({ ...choices, debit: i, amount: null });
    else if (step === 'amount') onChange({ ...choices, credit: i, amount: null });
  };
  return (
    <>
      <Title>{t('mobile.import.mapping')}</Title>
      <Body>{question}</Body>
      {step !== 'review' ? (
        header.map((h, i) => <Row key={i} title={h} subtitle={firstData[i] ?? ''} onPress={() => choose(i)} testID={`map-col-${i}`} />)
      ) : (
        <Card>
          {analysis.sample.slice(analysis.header ? 1 : 0, 4).map((r, i) => (
            <Small key={i}>
              {[r[choices.date!], r[choices.description!], choices.amount !== null ? r[choices.amount] : `${r[choices.debit!] ?? ''} / ${r[choices.credit!] ?? ''}`].join(' · ')}
            </Small>
          ))}
        </Card>
      )}
      {step === 'amount' || step === 'review' ? (
        <View style={{ gap: th.space(2) }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: th.space(2) }}>
            <Switch value={two} onValueChange={(v) => { setTwo(v); onChange({ ...choices, amount: null, debit: null, credit: null }); }} accessibilityLabel={t('mobile.import.map_two_columns')} />
            <Small>{t('mobile.import.map_two_columns')}</Small>
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: th.space(2) }}>
            <Switch value={choices.inverted} onValueChange={(v) => onChange({ ...choices, inverted: v })} accessibilityLabel={t('mobile.import.map_inverted')} />
            <Small>{t('mobile.import.map_inverted')}</Small>
          </View>
        </View>
      ) : null}
      {step === 'review' ? <Button label={t('mobile.import.map_apply')} onPress={onApply} testID="map-apply" /> : null}
    </>
  );
}
