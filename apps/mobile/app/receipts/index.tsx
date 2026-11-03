/**
 * Receipts on the phone: captures waiting to upload (TXN-09, with retry and discard) and the receipt inbox
 * from the server (IMP-11). Tapping a receipt opens its review.
 */
import { useCallback, useEffect, useState } from 'react';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import type { QueuedReceipt } from '@montra/sync';
import type { ReceiptDto } from '@montra/schemas';
import { fmtDate, fmtMoney, t } from '../../src/i18n';
import { useSession } from '../../src/session/SessionProvider';
import { useSync } from '../../src/sync/SyncProvider';
import { Banner, Body, Button, Card, Row, Screen, Small, Title } from '../../src/ui/components';

export default function Receipts() {
  const router = useRouter();
  const { queued } = useLocalSearchParams<{ queued?: string }>();
  const { state: session, api } = useSession();
  const { receipts, state, version, refresh, touch } = useSync();
  const ws = session.status === 'signed_in' ? session.workspace.id : '';
  const [waiting, setWaiting] = useState<QueuedReceipt[]>([]);
  const [list, setList] = useState<ReceiptDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void receipts.list().then(setWaiting);
  }, [receipts, version]);

  const load = useCallback(async () => {
    if (!ws) return;
    try {
      setList((await api.listReceipts(ws)).data);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [api, ws]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load, version]),
  );

  const open = (list ?? []).filter((r) => r.status !== 'rejected');
  return (
    <Screen testID="receipts">
      {queued ? (
        <Banner
          text={
            queued === 'offline' ? t('mobile.receipts.queued_offline') : t('mobile.receipts.queued_online')
          }
        />
      ) : null}
      <Button
        label={t('mobile.receipts.scan')}
        onPress={() => router.push('/receipt-capture')}
        testID="scan"
      />
      <Button
        kind="secondary"
        label={t('mobile.activity.sync_now')}
        busy={Boolean(state?.syncing)}
        onPress={() => void refresh().then(load)}
      />
      {waiting.length ? <Title>{t('mobile.receipts.waiting')}</Title> : null}
      {waiting.map((w) => (
        <Card key={w.id} testID="queued-receipt">
          <Body>{t('mobile.receipts.pages', { count: w.pages.length })}</Body>
          <Small>
            {w.state === 'failed'
              ? t('mobile.receipts.failed', { error: w.error ?? '' })
              : state?.online
                ? t('mobile.receipts.uploading')
                : t('mobile.receipts.offline')}
          </Small>
          {w.state === 'failed' ? (
            <Button
              kind="secondary"
              label={t('mobile.common.retry')}
              onPress={() =>
                void receipts
                  .retry(w.id)
                  .then(() => receipts.process())
                  .finally(touch)
              }
            />
          ) : null}
          <Button
            kind="danger"
            label={t('mobile.receipts.discard')}
            onPress={() => void receipts.discard(w.id).finally(touch)}
          />
        </Card>
      ))}
      <Title>{t('mobile.receipts.title')}</Title>
      {error && !state?.online ? <Body muted>{t('mobile.receipts.list_offline')}</Body> : null}
      {error && state?.online ? <Banner tone="danger" text={error} /> : null}
      {list && open.length === 0 ? <Body muted>{t('mobile.receipts.empty')}</Body> : null}
      {open.map((r) => (
        <Row
          key={r.id}
          testID="receipt-row"
          title={r.merchant ?? t('mobile.receipts.unknown_merchant')}
          subtitle={[r.receiptDate ? fmtDate(r.receiptDate) : null, t(`mobile.receipts.status.${r.status}`)]
            .filter(Boolean)
            .join(' · ')}
          right={<Small>{fmtMoney(r.total, r.currency)}</Small>}
          onPress={() => router.push(`/receipts/${r.id}`)}
        />
      ))}
    </Screen>
  );
}
