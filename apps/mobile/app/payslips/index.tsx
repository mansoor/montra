/**
 * Payslips on the phone (PAY-03): photograph or pick a payslip per employer, and the list of payslips. Read live
 * from the server and never stored on the device, because payslips are private (PAY-09), so this needs a network.
 */
import { useCallback, useState } from 'react';
import { useFocusEffect, useRouter } from 'expo-router';
import type { EmployerDto, PayslipDto } from '@montra/schemas';
import { fmtDate, fmtMoney, t } from '../../src/i18n';
import { useSession } from '../../src/session/SessionProvider';
import { Banner, Body, Button, Card, Row, Screen, Small, Title } from '../../src/ui/components';

export default function Payslips() {
  const router = useRouter();
  const { state: session, api } = useSession();
  const ws = session.status === 'signed_in' ? session.workspace.id : '';
  const [employers, setEmployers] = useState<EmployerDto[] | null>(null);
  const [list, setList] = useState<PayslipDto[]>([]);
  const [error, setError] = useState<string | null>(null);

  useFocusEffect(
    useCallback(() => {
      if (!ws) return;
      Promise.all([api.listEmployers(ws), api.listPayslips(ws)])
        .then(([e, p]) => {
          setEmployers(e.filter((x) => !x.archived));
          setList(p);
          setError(null);
        })
        .catch((err: Error) => setError(err.message));
    }, [api, ws]),
  );

  const name = new Map((employers ?? []).map((e) => [e.id, e.name]));
  return (
    <Screen testID="payslips">
      {error ? <Banner tone="danger" text={t('mobile.payslips.online_only')} /> : null}
      <Small>{t('mobile.payslips.private')}</Small>
      {employers?.length === 0 ? <Body muted>{t('mobile.payslips.no_employers')}</Body> : null}
      {(employers ?? []).map((e) => (
        <Card key={e.id} testID="payslip-employer">
          <Body>{e.name}</Body>
          <Button
            label={t('mobile.payslips.add')}
            onPress={() => router.push({ pathname: '/payslips/capture', params: { employerId: e.id } })}
            testID="payslip-add"
          />
        </Card>
      ))}
      {list.length ? <Title>{t('mobile.payslips.title')}</Title> : null}
      {list.map((p) => (
        <Row
          key={p.id}
          title={name.get(p.employerId) ?? t('mobile.payslips.title')}
          subtitle={[p.payDate ? fmtDate(p.payDate) : null, t(`mobile.payslips.status.${p.status}`)]
            .filter(Boolean)
            .join(' · ')}
          right={<Small>{fmtMoney(p.net, p.currency)}</Small>}
          onPress={() => router.push(`/payslips/${p.id}`)}
          testID="payslip-row"
        />
      ))}
    </Screen>
  );
}
