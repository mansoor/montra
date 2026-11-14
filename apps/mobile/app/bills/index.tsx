/**
 * Bills on the phone (ADR-0048 §4): the bills from the budget's providers, due ones first, each with its amount and
 * due date, overdue ones marked, and paid ones once their payment came in. "Scan a bill" adds one.
 */
import { useCallback, useState } from 'react';
import { useFocusEffect, useRouter } from 'expo-router';
import type { HouseholdBillDto } from '@montra/schemas';
import { fmtDate, fmtMoney, t } from '../../src/i18n';
import { useAbilities, useSession } from '../../src/session/SessionProvider';
import { Banner, Body, Button, Card, Row, Screen, Small, Title } from '../../src/ui/components';
import { useTheme } from '../../src/ui/theme';

export default function Bills() {
  const th = useTheme();
  const router = useRouter();
  const { state: session, api } = useSession();
  const can = useAbilities();
  const ws = session.status === 'signed_in' ? session.workspace.id : '';
  const [bills, setBills] = useState<HouseholdBillDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useFocusEffect(
    useCallback(() => {
      if (!ws) return;
      api.householdBills(ws).then(
        (list) => {
          setBills(list);
          setError(null);
        },
        (err: Error) => setError(err.message),
      );
    }, [api, ws]),
  );

  const due = (bills ?? []).filter((b) => b.status === 'open' || b.status === 'overdue').reverse();
  const done = (bills ?? []).filter((b) => b.status === 'paid');
  const row = (b: HouseholdBillDto, i: number, all: HouseholdBillDto[]) => (
    <Row
      key={b.id}
      testID="bill-row"
      title={b.billerName}
      subtitle={[
        t('mobile.bills.due_on', { date: fmtDate(b.dueDate) }),
        b.status === 'overdue'
          ? t('mobile.bills.overdue')
          : b.status === 'paid'
            ? t('mobile.bills.paid')
            : null,
      ]
        .filter(Boolean)
        .join(' · ')}
      right={
        <Small color={b.status === 'overdue' ? th.danger : undefined}>{fmtMoney(b.amount, b.currency)}</Small>
      }
      last={i === all.length - 1}
    />
  );
  return (
    <Screen testID="bills">
      {can.record ? (
        <Button
          label={t('mobile.bills.scan')}
          onPress={() => router.push('/bills/capture')}
          testID="scan-bill"
        />
      ) : null}
      {error ? <Banner tone="danger" text={error} /> : null}
      <Title>{t('mobile.bills.due_title')}</Title>
      {bills && due.length === 0 ? <Body muted>{t('mobile.bills.none_due')}</Body> : null}
      {due.length ? <Card>{due.map(row)}</Card> : null}
      {done.length ? <Title>{t('mobile.bills.paid_title')}</Title> : null}
      {done.length ? <Card>{done.slice(0, 20).map(row)}</Card> : null}
    </Screen>
  );
}
