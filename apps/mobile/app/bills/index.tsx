/**
 * Bills on the phone (ADR-0048 §4): the bills from the budget's providers, due ones first, each with its amount and
 * due date, overdue ones marked, and paid ones once their payment came in. "Scan a bill" adds one. A bill of two or
 * more pages has its pages, to move up or down or remove (ADR-0059 §4), as the receipt screen does.
 */
import { Fragment, useCallback, useState } from 'react';
import { Alert, View } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import type { HouseholdBillDto } from '@montra/schemas';
import { movePage, removePage } from '../../src/features/receipt-capture';
import { fmtDate, fmtMoney, t } from '../../src/i18n';
import { useAbilities, useSession } from '../../src/session/SessionProvider';
import { Banner, Body, Button, Card, Disclosure, Row, Screen, Small, Title } from '../../src/ui/components';
import { useTheme } from '../../src/ui/theme';
import { useFileStorageStates, VaultBadges } from '../../src/ui/Vault';

export default function Bills() {
  const th = useTheme();
  const router = useRouter();
  const { state: session, api } = useSession();
  const can = useAbilities();
  const ws = session.status === 'signed_in' ? session.workspace.id : '';
  const [bills, setBills] = useState<HouseholdBillDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The bill whose pages are open, and a page change on its way.
  const [pagesOf, setPagesOf] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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
  const done = (bills ?? []).filter((b) => b.status === 'paid').slice(0, 20);
  // ADR-0054 §13: where each bill's files are with the vault, for the bills on screen (the API takes 100 ids at most).
  const fileStates = useFileStorageStates([...due, ...done].flatMap((b) => b.fileIds));

  // ADR-0059 §4: a page in the wrong order, or one too many, is fixed here; the amount and dates stay as read.
  const savePages = (b: HouseholdBillDto, next: string[] | null) => {
    if (!next) return;
    setBusy(true);
    setError(null);
    api.setHouseholdBillPages(ws, b.id, { version: b.version, fileIds: next }).then(
      (saved) => {
        setBills((list) => (list ?? []).map((x) => (x.id === saved.id ? saved : x)));
        setBusy(false);
      },
      (err: Error) => {
        setError(err.message);
        setBusy(false);
      },
    );
  };
  const askRemove = (b: HouseholdBillDto, index: number) =>
    Alert.alert(t('record_pages.remove_title', { n: index + 1 }), t('record_pages.remove_body'), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('record_pages.remove_confirm'),
        style: 'destructive',
        onPress: () => savePages(b, removePage(b.fileIds, index)),
      },
    ]);
  const pages = (b: HouseholdBillDto) =>
    can.record && b.fileIds.length > 1 ? (
      <Disclosure
        title={t('record_pages.title')}
        summary={t('mobile.bills.pages', { count: b.fileIds.length })}
        open={pagesOf === b.id}
        onToggle={() => setPagesOf(pagesOf === b.id ? null : b.id)}
        testID="bill-pages-toggle"
      >
        <View style={{ gap: th.space(2) }} testID="bill-pages">
          {b.fileIds.map((fileId, at) => (
            <View key={fileId} style={{ gap: th.space(1) }}>
              <Body>{t('record_pages.page_n', { n: at + 1 })}</Body>
              <View style={{ flexDirection: 'row', gap: th.space(2) }}>
                <Button
                  kind="secondary"
                  label={t('record_pages.move_up', { n: at + 1 })}
                  disabled={busy || at === 0}
                  onPress={() => savePages(b, movePage(b.fileIds, at, -1))}
                  testID="bill-page-up"
                />
                <Button
                  kind="secondary"
                  label={t('record_pages.move_down', { n: at + 1 })}
                  disabled={busy || at === b.fileIds.length - 1}
                  onPress={() => savePages(b, movePage(b.fileIds, at, 1))}
                  testID="bill-page-down"
                />
                <Button
                  kind="danger"
                  label={t('record_pages.remove', { n: at + 1 })}
                  disabled={busy}
                  onPress={() => askRemove(b, at)}
                  testID="bill-page-remove"
                />
              </View>
            </View>
          ))}
          <Small>{`${t('record_pages.hint_bill')} ${t('record_pages.vault_note')}`}</Small>
        </View>
      </Disclosure>
    ) : null;
  const row = (b: HouseholdBillDto, i: number, all: HouseholdBillDto[]) => (
    <Fragment key={b.id}>
      <Row
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
          <Small color={b.status === 'overdue' ? th.danger : undefined}>
            {fmtMoney(b.amount, b.currency)}
          </Small>
        }
        last={i === all.length - 1}
      />
      <VaultBadges fileIds={b.fileIds} states={fileStates} />
      {pages(b)}
    </Fragment>
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
      {done.length ? <Card>{done.map(row)}</Card> : null}
    </Screen>
  );
}
