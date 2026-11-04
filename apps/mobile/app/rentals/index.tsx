/**
 * Rentals on the phone (08 §3, RNT-04, RNT-05): this month's rent, who's behind, and logging a payment. Reads are kept for
 * offline viewing like other planning screens. Properties and leases are managed on the web.
 */
import { useState } from 'react';
import { useRouter } from 'expo-router';
import { rollInOrder } from '../../src/features/rentals';
import { useCached } from '../../src/features/use-cached';
import { fmtDate, fmtMoney, t } from '../../src/i18n';
import { useSession } from '../../src/session/SessionProvider';
import { Banner, Body, Card, Row, Screen, Segmented, Small, Title } from '../../src/ui/components';
import { useTheme } from '../../src/ui/theme';

export default function Rentals() {
  const th = useTheme();
  const router = useRouter();
  const { state: session, api } = useSession();
  const ws = session.status === 'signed_in' ? session.workspace.id : '';
  const portfolios = useCached(ws, 'rentals', () => api.rentalPortfolios(ws), Boolean(ws));
  const [picked, setPicked] = useState<string | null>(null);
  const list = portfolios.data ?? [];
  const entityId = picked ?? list[0]?.id ?? '';
  const data = useCached(
    ws,
    `rentals:${entityId}`,
    async () => {
      const [roll, arrears] = await Promise.all([api.rentRoll(ws, entityId), api.arrears(ws, entityId)]);
      return { roll, arrears };
    },
    Boolean(ws && entityId),
  );
  const d = data.data;
  const ccy = d?.roll.currency;

  return (
    <Screen testID="rentals">
      {portfolios.stale || data.stale ? <Banner tone="warning" text={t('mobile.plan.offline')} /> : null}
      {data.error ? <Banner tone="danger" text={data.error} /> : null}
      {portfolios.data && list.length === 0 ? (
        <Card>
          <Body>{t('rentals.none_yet')}</Body>
          <Small>{t('mobile.rentals.add_on_web')}</Small>
        </Card>
      ) : null}
      {list.length > 1 ? (
        <Segmented
          label={t('rentals.switch')}
          value={entityId}
          options={list.map((e) => ({ value: e.id, label: e.name }))}
          onChange={setPicked}
        />
      ) : null}
      {d ? (
        <>
          <Card testID="rentals-month">
            <Small>{t('mobile.rentals.this_month')}</Small>
            <Title>
              {fmtMoney(d.roll.paid, ccy)} / {fmtMoney(d.roll.expected, ccy)}
            </Title>
            <Small>
              {t('rentals.still_open')}: {fmtMoney(d.roll.open, ccy)}
            </Small>
          </Card>

          <Title>{t('rentals.tab_rent_roll')}</Title>
          {d.roll.rows.length === 0 ? <Body muted>{t('rentals.roll_empty')}</Body> : null}
          {rollInOrder(d.roll.rows).map((r) => (
            <Row
              key={r.leaseId}
              title={`${r.propertyName} · ${r.unitLabel}`}
              subtitle={r.tenants.join(', ')}
              right={
                <Small color={BigInt(r.open) > 0n ? th.danger : th.success}>
                  {BigInt(r.open) > 0n ? fmtMoney(r.open, ccy) : t('rentals.rent_paid')}
                </Small>
              }
              onPress={() =>
                router.push({
                  pathname: '/rentals/log',
                  params: {
                    leaseId: r.leaseId,
                    entityId,
                    name: `${r.propertyName} · ${r.unitLabel}`,
                    open: r.open,
                    currency: d.roll.currency,
                  },
                })
              }
              testID="rentals-row"
            />
          ))}

          <Title>
            {t('rentals.arrears_total')}: {fmtMoney(d.arrears.total, ccy)}
          </Title>
          {d.arrears.rows.length === 0 ? <Body muted>{t('rentals.no_arrears')}</Body> : null}
          {d.arrears.rows.map((r) => (
            <Row
              key={r.leaseId}
              title={`${r.propertyName} · ${r.unitLabel}`}
              subtitle={`${t('rentals.days_late', { count: r.daysLate })} · ${fmtDate(r.oldestDue)}`}
              right={<Small color={th.danger}>{fmtMoney(r.total, ccy)}</Small>}
              testID="rentals-arrears"
            />
          ))}
        </>
      ) : null}
    </Screen>
  );
}
