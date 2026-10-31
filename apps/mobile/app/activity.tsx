/** Sync activity (PLT-05): conflict notices (field-group LWW results) and drafts the server rejected. */
import { useRouter } from 'expo-router';
import type { OutboxItem } from '@montra/sync';
import { t } from '../src/i18n';
import { useLocal, useSync } from '../src/sync/SyncProvider';
import { Body, Button, Card, Screen, Small, Title } from '../src/ui/components';

const opTarget = (o: OutboxItem): string | null => ('id' in o.op ? (o.op as { id: string }).id : null);

export default function Activity() {
  const router = useRouter();
  const { engine, store, state, refresh, touch } = useSync();
  const conflicts = useLocal((s) => s.conflicts()) ?? [];
  const outbox = useLocal((s) => s.outbox()) ?? [];
  const drafts = outbox.filter((o) => o.status === 'draft');
  const pending = outbox.length - drafts.length;

  return (
    <Screen testID="activity">
      {pending > 0 ? <Body>{t('mobile.activity.queue', { count: pending })}</Body> : null}
      <Button kind="secondary" label={t('mobile.activity.sync_now')} busy={Boolean(state?.syncing)} onPress={() => void refresh()} />
      {conflicts.length === 0 && drafts.length === 0 ? <Body muted>{t('mobile.activity.none')}</Body> : null}

      {drafts.length ? <Title>{t('mobile.activity.drafts')}</Title> : null}
      {drafts.map((d) => (
        <Card key={d.op.opId} testID="draft">
          <Body>{d.op.kind}</Body>
          <Small>{d.error?.message ?? ''}</Small>
          {opTarget(d) ? <Button kind="secondary" label={t('mobile.txn.detail')} onPress={() => router.push(`/transaction/${opTarget(d)}`)} /> : null}
          <Button label={t('mobile.activity.retry')} onPress={() => void engine.retryDraft(d.op.opId).then(refresh)} />
          <Button kind="danger" label={t('mobile.activity.discard')} onPress={() => void engine.discardDraft(d.op.opId).then(touch)} />
        </Card>
      ))}

      {conflicts.length ? <Title>{t('mobile.activity.conflicts')}</Title> : null}
      {conflicts.map((c) => (
        <Card key={c.opId} testID="conflict">
          {c.conflicts.map((x) => (
            <Small key={x.group}>
              {t('mobile.activity.conflict', { group: x.group, winner: t(`mobile.activity.winner.${x.winner}`) })}
            </Small>
          ))}
          <Button kind="secondary" label={t('mobile.txn.detail')} onPress={() => router.push(`/transaction/${c.transactionId}`)} />
          <Button kind="secondary" label={t('mobile.activity.dismiss')} onPress={() => void store.clearConflicts([c.opId]).then(touch)} />
        </Card>
      ))}
    </Screen>
  );
}
