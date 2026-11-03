/**
 * Cash flow on the phone (FLOW-02, FLOW-03, FLOW-07). The money flow is a list here (a Sankey doesn't fit a
 * phone, and the list is also the accessible alternative, NFR-10); forecast and net worth use small trend bars
 * with the numbers beside them.
 */
import { useState } from 'react';
import { View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { addMonths, calendarDate, endOfMonth, startOfMonth } from '@montra/domain';
import { fmtDate, fmtMoney, t } from '../src/i18n';
import { todayLocal } from '../src/features/home';
import { flowSections } from '../src/features/planning';
import { useCached } from '../src/features/use-cached';
import { useSession } from '../src/session/SessionProvider';
import { Banner, Body, Button, Card, Row, Screen, Segmented, Small, Sparkline } from '../src/ui/components';
import { useTheme } from '../src/ui/theme';

type Tab = 'flow' | 'forecast' | 'net-worth';

export default function CashFlow() {
  const { state: session } = useSession();
  const params = useLocalSearchParams<{ tab?: string }>();
  const ws = session.status === 'signed_in' ? session.workspace.id : '';
  const [tab, setTab] = useState<Tab>(
    params.tab === 'forecast' || params.tab === 'net-worth' ? params.tab : 'flow',
  );
  return (
    <Screen testID="cash-flow">
      <Segmented
        label={t('flow.sections')}
        value={tab}
        onChange={setTab}
        options={[
          { value: 'flow', label: t('flow.tab_flow') },
          { value: 'forecast', label: t('flow.tab_forecast') },
          { value: 'net-worth', label: t('flow.tab_net-worth') },
        ]}
      />
      {tab === 'flow' ? <Flow ws={ws} /> : tab === 'forecast' ? <Forecast ws={ws} /> : <NetWorth ws={ws} />}
    </Screen>
  );
}

function Flow({ ws }: { ws: string }) {
  const th = useTheme();
  const { api } = useSession();
  const [month, setMonth] = useState(() => startOfMonth(todayLocal()));
  const data = useCached(ws, `sankey.${month}`, () => api.sankey(ws, month, endOfMonth(month)), Boolean(ws));
  const titles = {
    income: 'mobile.flow.came_in',
    spending: 'mobile.flow.went_out',
    set_aside: 'mobile.flow.set_aside',
  };
  return (
    <>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <Button
          kind="secondary"
          label="‹"
          hint={t('budget.previous')}
          onPress={() => setMonth(addMonths(calendarDate(month), -1))}
        />
        <Body style={{ fontWeight: '600' }}>
          {fmtDate(month)} – {fmtDate(endOfMonth(month))}
        </Body>
        <Button
          kind="secondary"
          label="›"
          hint={t('budget.next')}
          onPress={() => setMonth(addMonths(calendarDate(month), 1))}
        />
      </View>
      {data.stale ? <Banner tone="warning" text={t('mobile.plan.offline')} /> : null}
      {data.error ? <Banner tone="danger" text={data.error} /> : null}
      {data.data && flowSections(data.data).length === 0 ? <Body muted>{t('flow.empty')}</Body> : null}
      {data.data
        ? flowSections(data.data).map((s) => (
            <Card key={s.key}>
              <Body style={{ fontWeight: '700' }}>{t(titles[s.key])}</Body>
              {s.rows.map((r) => (
                <View
                  key={r.id}
                  style={{
                    flexDirection: 'row',
                    justifyContent: 'space-between',
                    gap: th.space(2),
                    paddingLeft: r.indent ? th.space(4) : 0,
                  }}
                >
                  {r.indent ? <Small>{r.label}</Small> : <Body style={{ flexShrink: 1 }}>{r.label}</Body>}
                  {r.indent ? (
                    <Small>{fmtMoney(r.value, data.data!.currency)}</Small>
                  ) : (
                    <Body>{fmtMoney(r.value, data.data!.currency)}</Body>
                  )}
                </View>
              ))}
            </Card>
          ))
        : null}
    </>
  );
}

function Forecast({ ws }: { ws: string }) {
  const th = useTheme();
  const { api } = useSession();
  const [days, setDays] = useState<'30' | '60' | '90'>('30');
  const data = useCached(ws, `forecast.${days}`, () => api.forecast(ws, Number(days)), Boolean(ws));
  return (
    <>
      <Segmented
        label={t('mobile.flow.horizon')}
        value={days}
        onChange={setDays}
        options={(['30', '60', '90'] as const).map((d) => ({
          value: d,
          label: t('flow.days', { count: Number(d) }),
        }))}
      />
      {data.stale ? <Banner tone="warning" text={t('mobile.plan.offline')} /> : null}
      {data.error ? <Banner tone="danger" text={data.error} /> : null}
      {data.data?.accounts.length === 0 ? <Body muted>{t('flow.no_accounts')}</Body> : null}
      {data.data?.accounts.map((a) => (
        <Card key={a.accountId} testID="forecast-account">
          <Body style={{ fontWeight: '700' }}>{a.name}</Body>
          <Small>
            {t('flow.today')} {fmtMoney(a.start, a.currency)} →{' '}
            {t('flow.in_days', { count: data.data!.days })}{' '}
            {fmtMoney(a.balances[a.balances.length - 1] ?? a.start, a.currency)}
          </Small>
          <Sparkline
            values={a.balances}
            label={t('flow.forecast_for', { name: a.name })}
            color={a.lowBalance ? th.danger : undefined}
          />
          {a.lowBalance ? (
            <Banner
              tone="danger"
              text={`${t('flow.low_balance', { name: a.name })} ${fmtDate(a.lowBalance.date)} (${fmtMoney(a.lowBalance.balance, a.currency)})`}
            />
          ) : null}
          {a.items.slice(0, 5).map((i, n) => (
            <View key={n} style={{ flexDirection: 'row', justifyContent: 'space-between', gap: th.space(2) }}>
              <Small>
                {fmtDate(i.date)} · {i.name}
              </Small>
              <Small>{fmtMoney(i.amount, a.currency)}</Small>
            </View>
          ))}
        </Card>
      ))}
    </>
  );
}

function NetWorth({ ws }: { ws: string }) {
  const th = useTheme();
  const { api } = useSession();
  const data = useCached(ws, 'net-worth', () => api.netWorth(ws), Boolean(ws));
  const n = data.data;
  return (
    <>
      {data.stale ? <Banner tone="warning" text={t('mobile.plan.offline')} /> : null}
      {data.error ? <Banner tone="danger" text={data.error} /> : null}
      {n ? (
        <>
          <Card testID="net-worth">
            <Small>{t('flow.net_worth')}</Small>
            <Body style={{ fontSize: th.font.amount, fontWeight: '700' }}>
              {fmtMoney(n.netWorth, n.currency)}
            </Body>
            <Small>
              {t('flow.assets')} {fmtMoney(n.assets, n.currency)} · {t('flow.liabilities')}{' '}
              {fmtMoney(n.liabilities, n.currency)}
            </Small>
            <Sparkline
              values={n.trend.map((p) => p.netWorth)}
              label={t('flow.net_worth_trend')}
              height={72}
            />
            <Small>
              {fmtDate(n.trend[0]?.date ?? n.date)} – {fmtDate(n.date)}
            </Small>
          </Card>
          {n.accounts.map((a) => (
            <Row
              key={a.accountId}
              title={a.name}
              subtitle={t(`flow.kind_${a.kind}`)}
              right={<Body>{fmtMoney(a.balance, a.accountCurrency)}</Body>}
            />
          ))}
        </>
      ) : null}
    </>
  );
}
