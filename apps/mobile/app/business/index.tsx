/**
 * The business on the phone (08 §3, BIZ-05, BIZ-06, BIZ-09, BIZ-10; ADR-0032): at a glance over a chosen period and
 * month, like Home, with the tax to set aside and who owes what. An invoice opens as its PDF in the share sheet. Reads
 * are kept for offline viewing like other planning screens. Invoices and bills are written on the web.
 */
import { useMemo, useState } from 'react';
import { Platform, Share, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Directory, File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { BUSINESS_CHART_MONTHS, type InvoiceDto } from '@montra/schemas';
import { useCached } from '../../src/features/use-cached';
import { invoicePdfName, newestFirst, openBills, openInvoices, sumMinor } from '../../src/features/business';
import { currentLocale, fmtDate, fmtMoney, t } from '../../src/i18n';
import { useSession } from '../../src/session/SessionProvider';
import { MiniLineChart } from '../../src/ui/charts';
import { Banner, Body, Button, Card, Row, Screen, Segmented, Small, Title } from '../../src/ui/components';
import { haptic } from '../../src/ui/haptics';
import { PeriodPicker } from '../../src/ui/PeriodPicker';
import { useTheme } from '../../src/ui/theme';

type Months = (typeof BUSINESS_CHART_MONTHS)[number];

export default function Business() {
  const th = useTheme();
  const router = useRouter();
  const { state: session, api } = useSession();
  const ws = session.status === 'signed_in' ? session.workspace.id : '';
  const businesses = useCached(ws, 'businesses', () => api.businesses(ws), Boolean(ws));
  const [picked, setPicked] = useState<string | null>(null);
  const [months, setMonths] = useState<Months>(6);
  const [month, setMonth] = useState<string | null>(null);
  const [sharing, setSharing] = useState<string | null>(null);
  const [shareError, setShareError] = useState<string | null>(null);
  const list = businesses.data ?? [];
  const entityId = picked ?? list[0]?.entityId ?? '';
  const data = useCached(
    ws,
    `business:${entityId}`,
    async () => {
      const [invoices, bills, tax] = await Promise.all([
        api.invoices(ws, entityId),
        api.bills(ws, entityId),
        api.taxEstimate(ws, entityId),
      ]);
      return { invoices, bills, tax };
    },
    Boolean(ws && entityId),
  );
  const dash = useCached(
    ws,
    `business-dashboard:${entityId}:${months}:${month ?? ''}`,
    () => api.businessDashboard(ws, entityId, months, month),
    Boolean(ws && entityId),
  ).data;
  const d = data.data;
  const invoices = d ? openInvoices(d.invoices) : [];
  const bills = d ? openBills(d.bills) : [];
  const ccy = dash?.currency ?? list.find((b) => b.entityId === entityId)?.currency;
  const m = dash?.monthly[dash.monthly.length - 1];

  const monthName = useMemo(() => {
    try {
      return new Intl.DateTimeFormat(currentLocale, { month: 'long', year: 'numeric', timeZone: 'UTC' });
    } catch {
      return null;
    }
  }, []);
  const label = (p: { start: string; end: string }) =>
    monthName
      ? monthName.format(new Date(`${p.start}T00:00:00Z`))
      : `${fmtDate(p.start)} – ${fmtDate(p.end)}`;

  /** The invoice's PDF into the cache, then the share sheet: save it, print it, mail it or open it. */
  const sharePdf = async (i: InvoiceDto) => {
    setSharing(i.id);
    setShareError(null);
    try {
      const folder = new Directory(Paths.cache, 'invoices');
      if (!folder.exists) folder.create();
      const target = new File(folder, invoicePdfName(i.number));
      if (target.exists) target.delete();
      const file = await File.downloadFileAsync(api.invoicePdfUrl(ws, i.id), target, {
        headers: await api.authHeaders(),
      });
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(file.uri, {
          mimeType: 'application/pdf',
          UTI: 'com.adobe.pdf',
          dialogTitle: t('mobile.business.share_invoice', { number: i.number }),
        });
      } else {
        await Share.share(Platform.OS === 'ios' ? { url: file.uri } : { message: file.uri });
      }
    } catch (err) {
      setShareError((err as Error).message || t('mobile.business.pdf_failed'));
    } finally {
      setSharing(null);
    }
  };

  const tile = (labelText: string, value: string, hint?: string, tone?: string, testID?: string) => (
    <Card style={{ width: '48%', flexGrow: 1 }} testID={testID}>
      <Small>{labelText}</Small>
      <Body style={{ fontWeight: '700', color: tone ?? th.text }}>{value}</Body>
      {hint ? <Small>{hint}</Small> : null}
    </Card>
  );

  return (
    <Screen testID="business">
      {businesses.stale || data.stale ? <Banner tone="warning" text={t('mobile.plan.offline')} /> : null}
      {data.error ? <Banner tone="danger" text={data.error} /> : null}
      {shareError ? <Banner tone="danger" text={shareError} /> : null}
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
          onChange={(v) => {
            setPicked(v);
            setMonth(null);
          }}
        />
      ) : null}

      {dash && m && ccy ? (
        <>
          <View style={{ gap: th.space(1) }}>
            <Title>{t('business.dashboard.title')}</Title>
            <PeriodPicker
              shown={dash.month}
              periods={dash.periods}
              warn={!dash.current}
              label={label}
              testID="business-month"
              onPick={(start) => {
                haptic.select();
                setMonth(start);
              }}
            />
          </View>
          {!dash.current ? (
            <Banner
              tone="warning"
              text={`${t('business.dashboard.past_month', { month: label(dash.month) })} · ${t('home.back_to_today')}`}
              onPress={() => setMonth(null)}
            />
          ) : null}
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: th.space(2) }} testID="business-tiles">
            {tile(t('business.revenue'), fmtMoney(m.revenue, ccy))}
            {tile(t('business.expenses'), fmtMoney(m.expenses, ccy))}
            {tile(
              t('business.profit'),
              fmtMoney(m.profit, ccy),
              d?.tax.rateBps !== null && d
                ? t('business.dashboard.set_aside', { amount: fmtMoney(d.tax.toSetAside, ccy) })
                : undefined,
              BigInt(m.profit) < 0n ? th.danger : undefined,
              'business-profit',
            )}
            {tile(
              t('business.dashboard.cash'),
              fmtMoney(m.cashOnHand, ccy),
              dash.current ? t('business.dashboard.cash_today') : t('business.dashboard.cash_month_end'),
            )}
            {tile(t('business.dashboard.money_in'), fmtMoney(m.moneyIn, ccy))}
            {tile(t('business.dashboard.money_out'), fmtMoney(m.moneyOut, ccy))}
            {tile(
              t('business.owed_to_you'),
              fmtMoney(dash.openInvoices.amount, ccy),
              dash.openInvoices.overdueCount
                ? t('business.overdue_count', { count: dash.openInvoices.overdueCount })
                : t('business.dashboard.open_count', { count: dash.openInvoices.count }),
              dash.openInvoices.overdueCount ? th.warning : undefined,
            )}
            {tile(
              t('business.you_owe'),
              fmtMoney(dash.openBills.amount, ccy),
              dash.openBills.overdueCount
                ? t('business.dashboard.bills_overdue', { count: dash.openBills.overdueCount })
                : t('business.dashboard.open_count', { count: dash.openBills.count }),
              dash.openBills.overdueCount ? th.warning : undefined,
            )}
          </View>

          <Card testID="business-charts">
            <Segmented
              label={t('business.dashboard.range')}
              value={String(months)}
              onChange={(v) => setMonths(Number(v) as Months)}
              options={BUSINESS_CHART_MONTHS.map((n) => ({
                value: String(n),
                label: t(`home.charts.range_${n}`),
              }))}
            />
            <Small>
              {t('business.dashboard.summary', {
                months: dash.months,
                revenue: fmtMoney(dash.totals.revenue, ccy),
                expenses: fmtMoney(dash.totals.expenses, ccy),
                profit: fmtMoney(dash.totals.profit, ccy),
              })}
            </Small>
            <MiniLineChart
              title={t('business.dashboard.in_out')}
              summary={t('business.dashboard.note')}
              currency={ccy}
              months={dash.monthly.map((x) => x.start)}
              series={[
                { label: t('business.dashboard.money_in'), values: dash.monthly.map((x) => x.moneyIn) },
                { label: t('business.dashboard.money_out'), values: dash.monthly.map((x) => x.moneyOut) },
              ]}
            />
            <MiniLineChart
              title={t('business.dashboard.profit_chart')}
              summary={t('business.dashboard.note')}
              currency={ccy}
              months={dash.monthly.map((x) => x.start)}
              series={[
                { label: t('business.revenue'), values: dash.monthly.map((x) => x.revenue) },
                { label: t('business.expenses'), values: dash.monthly.map((x) => x.expenses) },
                { label: t('business.profit'), values: dash.monthly.map((x) => x.profit) },
              ]}
            />
            <MiniLineChart
              title={t('business.dashboard.cash')}
              summary={t('business.dashboard.note')}
              currency={ccy}
              fromZero={false}
              months={dash.monthly.map((x) => x.start)}
              series={[
                { label: t('business.dashboard.cash'), values: dash.monthly.map((x) => x.cashOnHand) },
              ]}
            />
          </Card>

          <Card testID="business-months">
            <Body style={{ fontWeight: '700' }}>{t('business.dashboard.table')}</Body>
            {newestFirst(dash.monthly).map((x, i, all) => (
              <Row
                key={x.start}
                title={label(x)}
                subtitle={`${t('business.dashboard.money_in')} ${fmtMoney(x.moneyIn, ccy)} · ${t('business.dashboard.money_out')} ${fmtMoney(x.moneyOut, ccy)}\n${t('business.revenue')} ${fmtMoney(x.revenue, ccy)} · ${t('business.expenses')} ${fmtMoney(x.expenses, ccy)}`}
                right={
                  <View style={{ alignItems: 'flex-end' }}>
                    <Small color={BigInt(x.profit) < 0n ? th.danger : th.text}>
                      {fmtMoney(x.profit, ccy)}
                    </Small>
                    <Small>{fmtMoney(x.cashOnHand, ccy)}</Small>
                  </View>
                }
                last={i === all.length - 1}
              />
            ))}
            <Small>{t('mobile.business.table_hint')}</Small>
          </Card>
        </>
      ) : (
        <Small>{t('mobile.common.loading')}</Small>
      )}

      {d && ccy ? (
        <>
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
          <View style={{ flexDirection: 'row', gap: th.space(2) }}>
            <View style={{ flex: 1 }}>
              <Button
                kind="secondary"
                label={t('mobile.business.log_trip')}
                onPress={() => router.push({ pathname: '/business/mileage', params: { entityId } })}
                testID="business-mileage"
              />
            </View>
            <View style={{ flex: 1 }}>
              <Button
                kind="secondary"
                label={t('mobile.business.settings')}
                onPress={() => router.push({ pathname: '/business/settings', params: { entityId } })}
                testID="business-settings"
              />
            </View>
          </View>

          <Title>
            {t('business.owed_to_you')}: {fmtMoney(sumMinor(invoices.map((i) => i.open)), ccy)}
          </Title>
          {invoices.length === 0 ? <Body muted>{t('mobile.business.no_open_invoices')}</Body> : null}
          {invoices.map((i) => (
            <Row
              key={i.id}
              title={`${i.partyName} · ${i.number}`}
              subtitle={`${t(`invoices.status.${i.status}`)} · ${t('bills.due')} ${fmtDate(i.dueDate)} · ${
                sharing === i.id ? t('mobile.business.pdf_getting') : t('mobile.business.pdf_tap')
              }`}
              right={
                <Small color={i.status === 'overdue' ? th.danger : undefined}>
                  {fmtMoney(i.open, i.currency)}
                </Small>
              }
              onPress={sharing ? undefined : () => void sharePdf(i)}
              accessibilityLabel={t('mobile.business.share_invoice', { number: i.number })}
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
