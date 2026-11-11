/**
 * The business on the phone (08 §3, BIZ-05, BIZ-06, BIZ-09, BIZ-10): profit this year, who owes what, and the tax to set
 * aside. Reads are kept for offline viewing like other planning screens. Invoices and bills are written on the web.
 */
import { useState } from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';
import { useCached } from '../../src/features/use-cached';
import { openBills, openInvoices, sumMinor } from '../../src/features/business';
import { fmtDate, fmtMoney, t } from '../../src/i18n';
import { useSession } from '../../src/session/SessionProvider';
import { Banner, Body, Button, Card, Row, Screen, Segmented, Small, Title } from '../../src/ui/components';
import { useTheme } from '../../src/ui/theme';

export default function Business() {
  const th = useTheme();
  const router = useRouter();
  const { state: session, api } = useSession();
  const ws = session.status === 'signed_in' ? session.workspace.id : '';
  const businesses = useCached(ws, 'businesses', () => api.businesses(ws), Boolean(ws));
  const [picked, setPicked] = useState<string | null>(null);
  const list = businesses.data ?? [];
  const entityId = picked ?? list[0]?.entityId ?? '';
  const data = useCached(
    ws,
    `business:${entityId}`,
    async () => {
      const [pnl, invoices, bills, tax] = await Promise.all([
        api.pnl(ws, entityId),
        api.invoices(ws, entityId),
        api.bills(ws, entityId),
        api.taxEstimate(ws, entityId),
      ]);
      return { pnl, invoices, bills, tax };
    },
    Boolean(ws && entityId),
  );
  const d = data.data;
  const invoices = d ? openInvoices(d.invoices) : [];
  const bills = d ? openBills(d.bills) : [];
  const ccy = d?.pnl.currency;

  return (
    <Screen testID="business">
      {businesses.stale || data.stale ? <Banner tone="warning" text={t('mobile.plan.offline')} /> : null}
      {data.error ? <Banner tone="danger" text={data.error} /> : null}
      {businesses.data && list.length === 0 ? (
        <Card>
          <Body>{t('business.none_yet')}</Body>
          <Small>{t('mobile.business.add_on_web')}</Small>
        </Card>
      ) : null}
      {list.length > 1 ? (
        <Segmented
          label={t('business.switch')}
          value={entityId}
          options={list.map((b) => ({ value: b.entityId, label: b.name }))}
          onChange={setPicked}
        />
      ) : null}
      {d ? (
        <>
          <Card testID="business-profit">
            <Small>{t('mobile.business.profit_this_year')}</Small>
            <Title>{fmtMoney(d.pnl.netProfit, ccy)}</Title>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: th.space(2) }}>
              <Small>
                {t('business.revenue')}: {fmtMoney(d.pnl.revenue, ccy)}
              </Small>
              <Small>
                {t('business.expenses')}: {fmtMoney(d.pnl.expenses, ccy)}
              </Small>
            </View>
          </Card>
          <Card testID="business-tax">
            <Small>{t('business.to_set_aside')}</Small>
            <Body style={{ fontWeight: '700' }}>{fmtMoney(d.tax.toSetAside, ccy)}</Body>
            {d.tax.rateBps === null ? <Small>{t('mobile.business.rate_on_web')}</Small> : null}
            {d.tax.periods
              .filter((p) => p.status === 'next')
              .map((p) => (
                <Small key={p.quarter}>{t('mobile.business.next_tax_date', { date: fmtDate(p.due) })}</Small>
              ))}
          </Card>
          <Button
            kind="secondary"
            label={t('mobile.business.log_trip')}
            onPress={() => router.push({ pathname: '/business/mileage', params: { entityId } })}
            testID="business-mileage"
          />
          <Button
            kind="secondary"
            label={t('mobile.payroll.open')}
            onPress={() =>
              router.push({ pathname: '/business/payroll', params: { entityId, currency: ccy ?? 'USD' } })
            }
            testID="business-payroll"
          />

          <Title>
            {t('business.owed_to_you')}: {fmtMoney(sumMinor(invoices.map((i) => i.open)), ccy)}
          </Title>
          {invoices.length === 0 ? <Body muted>{t('mobile.business.no_open_invoices')}</Body> : null}
          {invoices.map((i) => (
            <Row
              key={i.id}
              title={`${i.partyName} · ${i.number}`}
              subtitle={`${t(`invoices.status.${i.status}`)} · ${t('bills.due')} ${fmtDate(i.dueDate)}`}
              right={
                <Small color={i.status === 'overdue' ? th.danger : undefined}>
                  {fmtMoney(i.open, i.currency)}
                </Small>
              }
              testID="business-invoice"
            />
          ))}

          <Title>
            {t('business.you_owe')}: {fmtMoney(sumMinor(bills.map((b) => b.amount)), ccy)}
          </Title>
          {bills.length === 0 ? <Body muted>{t('mobile.business.no_open_bills')}</Body> : null}
          {bills.map((b) => (
            <Row
              key={b.id}
              title={b.partyName}
              subtitle={`${t(`bills.status.${b.status}`)} · ${t('bills.due')} ${fmtDate(b.dueDate)}`}
              right={
                <Small color={b.status === 'overdue' ? th.danger : undefined}>
                  {fmtMoney(b.amount, b.currency)}
                </Small>
              }
              testID="business-bill"
            />
          ))}
          <Small>{t('mobile.business.write_on_web')}</Small>
        </>
      ) : null}
    </Screen>
  );
}
