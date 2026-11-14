/**
 * Search by item (RCP-09): type an item ("milk") and see what was spent on it, then every receipt it's on with the
 * store, the date, the item's amount and the receipt's total. The period starts at three months and can be widened;
 * tapping a receipt opens it in full. Reads the server: it needs a connection.
 */
import { useCallback, useState } from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';
import type { ReceiptItemSearchDto } from '@montra/schemas';
import { fmtDate, fmtMoney, t } from '../../src/i18n';
import { useSession } from '../../src/session/SessionProvider';
import { todayLocal } from '../../src/features/home';
import {
  ITEM_PERIODS,
  itemQuery,
  periodFrom,
  widerPeriod,
  type ItemPeriod,
} from '../../src/features/receipt-items';
import {
  Banner,
  Body,
  Button,
  Card,
  Field,
  Row,
  Screen,
  Segmented,
  Small,
  Title,
} from '../../src/ui/components';
import { useTheme } from '../../src/ui/theme';

export default function ReceiptItems() {
  const th = useTheme();
  const router = useRouter();
  const { state: session, api } = useSession();
  const ws = session.status === 'signed_in' ? session.workspace.id : '';
  const [text, setText] = useState('');
  const [period, setPeriod] = useState<ItemPeriod>('3m');
  const [result, setResult] = useState<ReceiptItemSearchDto | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const search = useCallback(
    async (p: ItemPeriod, entry = text) => {
      const q = itemQuery(entry);
      if (!q || !ws) return;
      setPeriod(p);
      setBusy(true);
      setError(null);
      try {
        setResult(await api.searchReceiptItems(ws, q, periodFrom(todayLocal(), p)));
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setBusy(false);
      }
    },
    [api, ws, text],
  );

  const wider = widerPeriod(period);
  const periodLabel = (p: ItemPeriod) => t(`mobile.receipts.items_period_${p}`);

  return (
    <Screen testID="receipt-items">
      <Small>{t('mobile.receipts.items_hint')}</Small>
      <Field
        label={t('mobile.receipts.items_field')}
        hideLabel
        icon="search"
        value={text}
        onChangeText={setText}
        returnKeyType="search"
        autoCapitalize="none"
        onSubmitEditing={() => void search(period)}
        testID="item-query"
      />
      <Segmented
        label={t('mobile.receipts.items_period')}
        options={ITEM_PERIODS.map((p) => ({ value: p, label: periodLabel(p) }))}
        value={period}
        onChange={(p) => (itemQuery(text) ? void search(p) : setPeriod(p))}
      />
      <Button
        label={t('mobile.receipts.items_search')}
        busy={busy}
        disabled={!itemQuery(text)}
        onPress={() => void search(period)}
        testID="item-search"
      />
      {error ? <Banner tone="danger" text={error} /> : null}
      {result ? (
        <>
          <Card testID="item-summary">
            {result.totals.length === 0 ? (
              <Body muted>{t('mobile.receipts.items_none', { item: result.query })}</Body>
            ) : (
              result.totals.map((s) => (
                <View key={s.currency} style={{ gap: th.space(1) }}>
                  <Title>{fmtMoney(s.amount, s.currency)}</Title>
                  <Body>
                    {t('mobile.receipts.items_summary', {
                      item: result.query,
                      items: s.items,
                      receipts: s.receipts,
                    })}
                  </Body>
                </View>
              ))
            )}
            <Small>
              {period === 'all'
                ? t('mobile.receipts.items_all_time')
                : t('mobile.receipts.items_since', { date: fmtDate(result.from) })}
            </Small>
          </Card>
          {result.receipts.length ? (
            <Card>
              {result.receipts.map((r, i) => (
                <Row
                  key={r.receiptId}
                  testID="item-receipt"
                  last={i === result.receipts.length - 1}
                  title={r.merchant ?? t('mobile.receipts.unknown_merchant')}
                  subtitle={[
                    fmtDate(r.receiptDate),
                    r.items.map((x) => x.name).join(', '),
                    r.total
                      ? t('mobile.receipts.items_receipt_total', { total: fmtMoney(r.total, r.currency) })
                      : null,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                  right={<Body style={{ fontWeight: '600' }}>{fmtMoney(r.itemsAmount, r.currency)}</Body>}
                  onPress={() => router.push(`/receipts/${r.receiptId}`)}
                />
              ))}
            </Card>
          ) : null}
          {result.more ? <Small>{t('mobile.receipts.items_more')}</Small> : null}
          {wider ? (
            <Button
              kind="secondary"
              label={t('mobile.receipts.items_wider', { period: periodLabel(wider) })}
              busy={busy}
              onPress={() => void search(wider)}
              testID="item-wider"
            />
          ) : null}
        </>
      ) : null}
    </Screen>
  );
}
