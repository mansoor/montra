/**
 * Payslip capture (PAY-03): the phone's document scanner first (ADR-0048), the app's camera when the scanner can't
 * run, or a picked PDF or photo. Unlike receipts there's no offline queue: a payslip isn't left on the device (PAY-09),
 * and the app's own scans and shots are removed once uploaded.
 */
import { useState } from 'react';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { t } from '../../src/i18n';
import type { CapturedPage } from '../../src/features/scanner';
import { removePage } from '../../src/receipts/files';
import { useAbilities, useSession } from '../../src/session/SessionProvider';
import { DocumentCapture } from '../../src/ui/DocumentCapture';
import { NotAllowed } from '../../src/ui/NotAllowed';
import { Screen } from '../../src/ui/components';

export default function PayslipCapture() {
  const router = useRouter();
  const { employerId } = useLocalSearchParams<{ employerId: string }>();
  const { state: session, api } = useSession();
  const can = useAbilities();
  const ws = session.status === 'signed_in' ? session.workspace.id : '';
  const [busy, setBusy] = useState(false);

  const upload = async (pages: CapturedPage[]) => {
    setBusy(true);
    try {
      const fileIds: string[] = [];
      for (const p of pages) {
        const f = await api.uploadPayslipFile(ws, { uri: p.uri, name: p.name, type: p.type });
        fileIds.push(f.fileId);
      }
      const payslip = await api.createPayslip(ws, { employerId, fileIds });
      await Promise.all(pages.filter((p) => p.shot).map((p) => removePage(p.uri)));
      router.replace(`/payslips/${payslip.id}`);
    } finally {
      setBusy(false);
    }
  };

  if (!can.setUp)
    return (
      <Screen>
        <NotAllowed />
      </Screen>
    );
  return (
    <Screen testID="payslip-capture">
      <DocumentCapture
        scanLabel={t('mobile.payslips.scan')}
        scanHint={t('mobile.payslips.scan_hint')}
        cameraHint={t('mobile.payslips.capture_hint')}
        onPages={upload}
        busy={busy}
      />
    </Screen>
  );
}
