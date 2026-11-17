/**
 * Scan a tax form (ADR-0052 §7.2, TAX-09): the phone's document scanner first, the app's camera when it can't run, or
 * picked PDFs and photos (DocumentCapture). The pages become one PDF, as statements do, and go to the same endpoint as
 * the web's uploads, read on the server: the images never go to the AI, only their masked text. A form isn't kept on the
 * device: the app's own pages and the PDF made from them are removed once uploaded.
 */
import { useState } from 'react';
import * as ImageManipulator from 'expo-image-manipulator';
import * as Print from 'expo-print';
import { useLocalSearchParams, useRouter } from 'expo-router';
import type { TaxFormUploadDto } from '@montra/schemas';
import { t } from '../../src/i18n';
import type { CapturedPage } from '../../src/features/scanner';
import { localDay } from '../../src/features/statements';
import { defaultTaxYear, scanUploads, showsTaxForms, uploadOutcome } from '../../src/features/tax-forms';
import { useTaxFormsToCheck } from '../../src/features/use-tax-forms';
import { removePage } from '../../src/receipts/files';
import { useAbilities, useSession } from '../../src/session/SessionProvider';
import { useSync } from '../../src/sync/SyncProvider';
import { DocumentCapture } from '../../src/ui/DocumentCapture';
import { NotAllowed } from '../../src/ui/NotAllowed';
import { Banner, Body, Button, Card, Screen, Small } from '../../src/ui/components';

/** The pages as one PDF: sized for OCR, as a statement's scan is. */
async function combine(pages: readonly CapturedPage[]): Promise<string | null> {
  const images: string[] = [];
  for (const p of pages) {
    const small = await ImageManipulator.manipulateAsync(p.uri, [{ resize: { width: 1800 } }], {
      compress: 0.8,
      format: ImageManipulator.SaveFormat.JPEG,
      base64: true,
    });
    if (small.base64) images.push(small.base64);
  }
  if (images.length === 0) return null;
  const html = `<html><body style="margin:0">${images
    .map((b64) => `<img src="data:image/jpeg;base64,${b64}" style="width:100%;page-break-after:always"/>`)
    .join('')}</body></html>`;
  return (await Print.printToFileAsync({ html })).uri;
}

export default function ScanTaxForm() {
  const router = useRouter();
  const { state: session, api } = useSession();
  const { state: sync } = useSync();
  const can = useAbilities();
  const badge = useTaxFormsToCheck();
  const ws = session.status === 'signed_in' ? session.workspace : null;
  const params = useLocalSearchParams<{ year?: string }>();
  const year = Number(params.year) || defaultTaxYear(localDay(new Date().toISOString()));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<TaxFormUploadDto['files'] | null>(null);

  const captured = async (pages: CapturedPage[]) => {
    if (!ws) return;
    const plan = scanUploads(pages);
    const made = plan.images.filter((p) => p.shot);
    if (sync && !sync.online) {
      await Promise.all(made.map((p) => removePage(p.uri)));
      return setError(t('mobile.tax_forms.offline_scan'));
    }
    setBusy(true);
    setError(null);
    const results: TaxFormUploadDto['files'] = [];
    let pdf: string | null = null;
    try {
      pdf = plan.images.length ? await combine(plan.images) : null;
      if (pdf) {
        const up = await api.uploadTaxFormFile(
          ws.id,
          {
            uri: pdf,
            name: `tax-form-scan-${localDay(new Date().toISOString())}.pdf`,
            type: 'application/pdf',
          },
          { year, source: plan.imagesSource },
        );
        results.push(...up.files);
      }
      for (const p of plan.pdfs) {
        const up = await api.uploadTaxFormFile(
          ws.id,
          { uri: p.uri, name: p.name, type: p.type },
          { year, source: 'upload' },
        );
        results.push(...up.files);
      }
    } catch (err) {
      // What went up before the failure is shown; the rest can be scanned again.
      setError((err as Error).message);
    } finally {
      // Nothing of a form stays on the phone: the app's own pages and the PDF made from them go once it's sent.
      await Promise.all(
        [...made.map((p) => p.uri), ...(pdf ? [pdf] : [])].map((uri) =>
          removePage(uri).catch(() => undefined),
        ),
      );
      setBusy(false);
    }
    if (results.length === 0) return;
    void badge.refresh();
    const outcome = uploadOutcome(results);
    if (outcome.openFormId && results[0]!.status === 'reading')
      router.replace(`/tax-forms/${outcome.openFormId}`);
    else setDone(results);
  };

  if (!ws || !showsTaxForms(ws) || !can.record)
    return (
      <Screen>
        <NotAllowed />
      </Screen>
    );
  if (done) {
    const outcome = uploadOutcome(done);
    return (
      <Screen testID="tax-form-uploaded">
        <Card>
          {outcome.lines.map((l, i) => (
            <Body key={`${done[i]!.formId}-${i}`}>{t(l.key, l.values)}</Body>
          ))}
        </Card>
        {done.map((f, i) => (
          <Button
            key={`${f.formId}-${i}`}
            kind="secondary"
            label={t('tax_forms.open_named', { name: f.fileName })}
            onPress={() => router.push(`/tax-forms/${f.formId}`)}
          />
        ))}
        {error ? <Banner tone="danger" text={error} /> : null}
        <Button label={t('mobile.tax_forms.done')} onPress={() => router.back()} testID="tax-form-done" />
      </Screen>
    );
  }
  return (
    <Screen testID="tax-form-scan">
      <Small>{t('tax_forms.upload_privacy')}</Small>
      {busy ? <Small>{t('tax_forms.uploading')}</Small> : null}
      <DocumentCapture
        scanLabel={t('mobile.tax_forms.scan')}
        scanHint={t('mobile.tax_forms.scan_hint')}
        cameraHint={t('mobile.tax_forms.camera_hint')}
        onPages={captured}
        busy={busy}
      />
      {error ? <Banner tone="danger" text={error} /> : null}
    </Screen>
  );
}
