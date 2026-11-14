/**
 * Payslip capture (PAY-03): the phone's document scanner first (ADR-0048), the app's camera when the scanner can't
 * run, or a picked PDF or photo. Unlike receipts there's no offline queue: a payslip isn't left on the device (PAY-09),
 * and the app's own scans and shots are removed once uploaded.
 *
 * From an employer's "Add a payslip", the payslip is that employer's. From the Add wheel, the scan is read first and
 * finds its employer and person (the person by the pseudonym the reading names), for the person to confirm; the
 * payslip is then made from that same reading.
 */
import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import type { EmployerDto, ScanPayslipDetectedDto } from '@montra/schemas';
import { fmtDate, fmtMoney, t } from '../../src/i18n';
import { waitForScan, type CapturedPage } from '../../src/features/scanner';
import { removePage } from '../../src/receipts/files';
import { useAbilities, useSession } from '../../src/session/SessionProvider';
import { useLocal } from '../../src/sync/SyncProvider';
import { DocumentCapture } from '../../src/ui/DocumentCapture';
import { NotAllowed } from '../../src/ui/NotAllowed';
import { Banner, Body, Button, Card, Row, Screen, Small, Title } from '../../src/ui/components';
import { Icon } from '../../src/ui/icons';
import { useTheme } from '../../src/ui/theme';

interface Read {
  fileIds: string[];
  /** Set when the scan was read: the payslip is made from its reading. */
  scanId?: string;
  found: ScanPayslipDetectedDto | null;
}

export default function PayslipCapture() {
  const th = useTheme();
  const router = useRouter();
  const { employerId } = useLocalSearchParams<{ employerId?: string }>();
  const { state: session, api } = useSession();
  const can = useAbilities();
  const ws = session.status === 'signed_in' ? session.workspace.id : '';
  const members = useLocal((s) => s.getReference('members')) ?? [];
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [employers, setEmployers] = useState<EmployerDto[] | null>(null);
  const [read, setRead] = useState<Read | null>(null);
  const [chosen, setChosen] = useState<string | null>(null);

  useEffect(() => {
    if (employerId || !ws) return;
    api.listEmployers(ws).then(
      (list) => setEmployers(list.filter((e) => !e.archived)),
      (err: Error) => setError(err.message),
    );
  }, [api, ws, employerId]);

  const uploadAll = async (pages: CapturedPage[]) => {
    const fileIds: string[] = [];
    for (const p of pages) {
      const f = await api.uploadPayslipFile(ws, { uri: p.uri, name: p.name, type: p.type });
      fileIds.push(f.fileId);
    }
    await Promise.all(pages.filter((p) => p.shot).map((p) => removePage(p.uri)));
    return fileIds;
  };

  const make = async (forEmployer: string, fileIds: string[], scanId?: string) => {
    const payslip = await api.createPayslip(ws, {
      employerId: forEmployer,
      fileIds,
      ...(scanId ? { scanId } : {}),
    });
    router.replace(`/payslips/${payslip.id}`);
  };

  const captured = async (pages: CapturedPage[]) => {
    setBusy(true);
    setError(null);
    try {
      const fileIds = await uploadAll(pages);
      if (employerId) return await make(employerId, fileIds);
      const scan = await api.createScan(ws, 'payslip', fileIds);
      const done = await waitForScan(() => api.getScan(ws, scan.id));
      const found = done?.status === 'ready' ? done.payslip : null;
      setRead({ fileIds, scanId: found ? scan.id : undefined, found });
      setChosen(found?.employerId ?? found?.candidates[0]?.employerId ?? null);
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    if (!read || !chosen) return;
    setBusy(true);
    setError(null);
    try {
      await make(chosen, read.fileIds, read.scanId);
    } catch (err) {
      setError((err as Error).message);
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
  if (read) {
    const f = read.found;
    const person = members.find((m) => m.id === f?.memberId)?.name;
    // The person's employers first, when the reading named the person.
    const list = [...(employers ?? [])].sort(
      (a, b) => Number(b.memberId === f?.memberId) - Number(a.memberId === f?.memberId),
    );
    return (
      <Screen testID="payslip-confirm">
        <Title>{t('mobile.payslips.whose')}</Title>
        {f ? (
          <Card>
            {f.employerName ? <Body style={{ fontWeight: '600' }}>{f.employerName}</Body> : null}
            <Small>
              {[
                person ? t('mobile.payslips.for_person', { name: person }) : null,
                f.payDate ? t('mobile.payslips.paid_on', { date: fmtDate(f.payDate) }) : null,
                f.net && f.currency
                  ? t('mobile.payslips.net_pay', { amount: fmtMoney(f.net, f.currency) })
                  : null,
              ]
                .filter(Boolean)
                .join(' · ')}
            </Small>
          </Card>
        ) : (
          <Banner tone="warning" text={t('mobile.payslips.not_read')} />
        )}
        {f?.employerId ? (
          <Banner tone="info" text={t('mobile.payslips.found_employer')} />
        ) : f?.employerName ? (
          <Banner tone="warning" text={t('mobile.payslips.no_match', { name: f.employerName })} />
        ) : null}
        {employers?.length === 0 ? <Body muted>{t('mobile.payslips.no_employers')}</Body> : null}
        <View>
          {list.map((e, i) => (
            <Row
              key={e.id}
              testID="payslip-employer-choice"
              title={e.name}
              subtitle={members.find((m) => m.id === e.memberId)?.name}
              last={i === list.length - 1}
              onPress={() => setChosen(e.id)}
              right={
                e.id === chosen ? (
                  <Icon name="check" size={18} color={th.primary} />
                ) : (
                  <View style={{ width: 18 }} />
                )
              }
            />
          ))}
        </View>
        <Button
          label={t('mobile.payslips.save_scanned')}
          busy={busy}
          disabled={!chosen}
          onPress={() => void save()}
          testID="payslip-save-scanned"
        />
        {error ? <Banner tone="danger" text={error} /> : null}
      </Screen>
    );
  }
  return (
    <Screen testID="payslip-capture">
      {busy ? <Small>{t('mobile.payslips.reading')}</Small> : null}
      <DocumentCapture
        scanLabel={t('mobile.payslips.scan')}
        scanHint={t('mobile.payslips.scan_hint')}
        cameraHint={t('mobile.payslips.capture_hint')}
        onPages={captured}
        busy={busy}
      />
      {error ? <Banner tone="danger" text={error} /> : null}
    </Screen>
  );
}
