/**
 * One pay run on the phone (PRL-22): each person's payslip, line by line, with the year to date. Read live, never kept
 * on the device; the PDF is on the web.
 */
import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import type { PayRunDto } from '@montra/schemas';
import { hoursLabel, payslipSections, signedAmount, signedHoursLabel } from '../../src/features/payroll';
import { fmtDate, fmtMoney, t } from '../../src/i18n';
import { useSession } from '../../src/session/SessionProvider';
import { Banner, Body, Card, Screen, Small, Title } from '../../src/ui/components';
import { useTheme } from '../../src/ui/theme';

export default function PayRun() {
  const th = useTheme();
  // Payroll is in US dollars (ADR-0034); the business page passes its currency on.
  const { id, currency = 'USD' } = useLocalSearchParams<{ id: string; currency?: string }>();
  const { state: session, api } = useSession();
  const ws = session.status === 'signed_in' ? session.workspace.id : '';
  const [run, setRun] = useState<PayRunDto | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.payRun(ws, id).then(setRun, (err: Error) => setError(err.message));
  }, [api, ws, id]);

  const SECTION: Record<string, string> = {
    earning: t('payroll.run.earnings'),
    pre_tax_deduction: t('payroll.run.pre_tax'),
    employee_tax: t('payroll.run.taxes'),
    post_tax_deduction: t('payroll.run.post_tax'),
    reimbursement: t('payroll.run.reimbursements'),
    employer_tax: t('payroll.run.employer_taxes'),
  };

  return (
    <Screen testID="pay-run">
      {error ? <Banner tone="danger" text={error} /> : null}
      {run ? (
        <>
          <Card>
            <Small>
              {fmtDate(run.periodStart)} – {fmtDate(run.periodEnd)}
            </Small>
            <Title>
              {t('payroll.run.payday')} {fmtDate(run.payDate)}
            </Title>
            <Small>{run.status === 'approved' ? t('payroll.run.approved') : t('payroll.run.draft')}</Small>
          </Card>
          {(run.paychecks ?? []).map((pc) => (
            <Card key={pc.id} testID="pay-run-paycheck">
              <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                <Body style={{ fontWeight: '700' }}>{pc.personName}</Body>
                <Body style={{ fontWeight: '700' }}>{fmtMoney(pc.net, currency)}</Body>
              </View>
              {payslipSections(pc).map((g) => (
                <View key={g.section} style={{ gap: th.space(1) }}>
                  <Small color={th.muted}>{SECTION[g.section]}</Small>
                  {g.lines.map((l) => (
                    <View
                      key={l.id}
                      style={{ flexDirection: 'row', justifyContent: 'space-between', gap: th.space(2) }}
                    >
                      <Small>
                        {l.label}
                        {l.hoursMilli
                          ? ` · ${t('mobile.payroll.hours', { hours: hoursLabel(l.hoursMilli) })}`
                          : ''}
                      </Small>
                      <Small>{fmtMoney(signedAmount(g.section, l.amount), currency)}</Small>
                    </View>
                  ))}
                </View>
              ))}
              {pc.leave.map((l) => (
                <Small key={l.kind} color={th.muted}>
                  {t('mobile.payroll.leave_line', {
                    kind: l.kind === 'vacation' ? t('payroll.time.vacation') : t('payroll.time.sick'),
                    used: signedHoursLabel(l.usedMilli),
                    earned: signedHoursLabel(l.accruedMilli),
                    hours: signedHoursLabel(l.afterMilli),
                  })}
                </Small>
              ))}
              <Small color={th.muted}>
                {t('mobile.payroll.ytd', {
                  gross: fmtMoney(pc.ytd.gross, currency),
                  net: fmtMoney(pc.ytd.net, currency),
                })}
              </Small>
            </Card>
          ))}
          <Small>{t('mobile.payroll.pdf_on_web')}</Small>
        </>
      ) : null}
    </Screen>
  );
}
