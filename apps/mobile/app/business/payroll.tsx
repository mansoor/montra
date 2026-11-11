/**
 * Payroll on the phone (PRL-22): the business's pay runs and reimbursement requests, and a way to submit one with a
 * receipt photo. Pay is personal, so it's read live and never kept on the device (as payslips, PAY-09). Pay runs are
 * made and approved on the web.
 */
import { useCallback, useEffect, useState } from 'react';
import { useLocalSearchParams, useRouter } from 'expo-router';
import type { PayRunDto, ReimbursementDto } from '@montra/schemas';
import { fmtDate, fmtMoney, t } from '../../src/i18n';
import { useSession } from '../../src/session/SessionProvider';
import { Banner, Body, Button, Card, Row, Screen, Small, Title } from '../../src/ui/components';

export default function Payroll() {
  const router = useRouter();
  const { entityId, currency = 'USD' } = useLocalSearchParams<{ entityId: string; currency?: string }>();
  const { state: session, api } = useSession();
  const ws = session.status === 'signed_in' ? session.workspace.id : '';
  const [runs, setRuns] = useState<PayRunDto[] | null>(null);
  const [claims, setClaims] = useState<ReimbursementDto[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [r, c] = await Promise.all([api.payRuns(ws, entityId), api.reimbursements(ws, entityId)]);
      setRuns(r);
      setClaims(c);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [api, ws, entityId]);

  useEffect(() => {
    void load();
  }, [load]);

  const STATUS: Record<ReimbursementDto['status'], string> = {
    submitted: t('payroll.claim.submitted'),
    approved: t('payroll.claim.approved'),
    declined: t('payroll.claim.declined'),
    paid: t('payroll.claim.paid'),
  };

  return (
    <Screen testID="payroll">
      {error ? <Banner tone="danger" text={error} /> : null}
      <Button
        label={t('mobile.payroll.submit_claim')}
        icon="receipt"
        onPress={() => router.push({ pathname: '/business/reimbursement', params: { entityId } })}
        testID="payroll-new-claim"
      />
      <Title>{t('payroll.run.runs')}</Title>
      {runs && runs.length === 0 ? (
        <Card>
          <Body muted>{t('payroll.run.none')}</Body>
          <Small>{t('mobile.payroll.runs_on_web')}</Small>
        </Card>
      ) : null}
      {(runs ?? []).map((r, i) => (
        <Row
          key={r.id}
          title={`${t('payroll.run.payday')} ${fmtDate(r.payDate)}`}
          subtitle={`${r.status === 'approved' ? t('payroll.run.approved') : t('payroll.run.draft')} · ${t('payroll.run.paychecks', { n: r.totals.paychecks })}`}
          right={<Small>{fmtMoney(r.totals.net, currency)}</Small>}
          last={i === (runs ?? []).length - 1}
          onPress={() => router.push({ pathname: '/business/pay-run', params: { id: r.id, currency } })}
          testID="payroll-run"
        />
      ))}
      <Title>{t('payroll.claim.title')}</Title>
      {claims.length === 0 ? <Body muted>{t('payroll.claim.none')}</Body> : null}
      {claims.map((c, i) => (
        <Row
          key={c.id}
          title={c.description}
          subtitle={`${c.personName} · ${fmtDate(c.spentOn)} · ${STATUS[c.status]}`}
          right={<Small>{fmtMoney(c.amount, c.currency)}</Small>}
          last={i === claims.length - 1}
          testID="payroll-claim"
        />
      ))}
    </Screen>
  );
}
