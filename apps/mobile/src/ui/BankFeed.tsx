/**
 * Bank feeds on the phone (ADR-0055 §10; FEED-10): the feed's status in Your data with Sync now, and what a sync
 * brought that waits in Review. Read online and never kept on the device; the words and decisions are in
 * `features/bank-feeds`. Connecting and linking are on the web.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { View } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import type { BankFeedDto, ImportBatchDto } from '@montra/schemas';
import {
  bankFeedCard,
  feedImportEntries,
  showsBankFeed,
  showsFeedImports,
  type FeedTone,
} from '../features/bank-feeds';
import { useFeedImports } from '../features/use-feed-imports';
import { fmtDate, t } from '../i18n';
import { useSession } from '../session/SessionProvider';
import { useLocal } from '../sync/SyncProvider';
import { Body, Button, Card, Small, useToast } from './components';
import { useTheme } from './theme';

const useToneColor = () => {
  const th = useTheme();
  return (tone: FeedTone | undefined) =>
    tone === 'good' ? th.success : tone === 'bad' ? th.danger : tone === 'warn' ? th.warning : th.muted;
};

/** A line's date (`YYYY-MM-DD`) in the phone's own format. */
const withDate = (values: Record<string, string | number> | undefined) =>
  typeof values?.date === 'string' ? { ...values, date: fmtDate(values.date) } : values;

/**
 * Your data → Bank feed, for owners, admins and partners: the status, each linked account's progress, problems in
 * words, and Sync now. Nothing when there's no feed or it can't be read (offline): it never stands in the way.
 */
export function BankFeedStatusCard() {
  const { state: session, api } = useSession();
  const toast = useToast();
  const color = useToneColor();
  const accounts = useLocal((s) => s.getReference('accounts'));
  const ws = session.status === 'signed_in' ? session.workspace : null;
  const role = ws?.role ?? 'viewer';
  const wsId = ws?.id ?? '';
  const [feed, setFeed] = useState<BankFeedDto | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!wsId || !showsBankFeed(role)) return;
    let live = true;
    api.bankFeed(wsId).then(
      (f) => live && setFeed(f),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [api, wsId, role]);

  const names = useMemo(() => new Map((accounts ?? []).map((a) => [a.id, a.name])), [accounts]);
  const card = bankFeedCard(feed, role, names);
  if (!card || !feed) return null;

  async function syncNow() {
    setBusy(true);
    try {
      const next = await api.syncBankFeed(wsId, feed!.id);
      if (next) setFeed(next);
      toast.show(t('bank_feeds.syncing'));
    } catch (e) {
      toast.show((e as Error).message || t('mobile.bank_feeds.sync_failed'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card testID="your-data-bank-feed">
      <Small color={color(card.status.tone)}>{`${t('bank_feeds.title')} · ${t(card.status.key)}`}</Small>
      {card.lines.map((l, i) => (
        <Small key={`${l.key ?? 'text'}-${i}`} color={l.tone ? color(l.tone) : undefined}>
          {l.key ? t(l.key, withDate(l.values)) : (l.text ?? '')}
        </Small>
      ))}
      {card.canSync ? (
        <Button
          kind="secondary"
          label={t('bank_feeds.sync_now')}
          busy={busy}
          disabled={busy}
          onPress={() => void syncNow()}
          testID="your-data-bank-feed-sync"
        />
      ) : null}
      <Small>{t(card.web.key)}</Small>
    </Card>
  );
}

/**
 * Review → Bank feed: each import a sync brought that waits for a look, opening the phone's import preview to import
 * it. Read when Review is shown.
 */
export function FeedImportsReview() {
  const th = useTheme();
  const router = useRouter();
  const { state: session, api } = useSession();
  const badge = useFeedImports();
  const ws = session.status === 'signed_in' ? session.workspace : null;
  const shown = ws !== null && showsFeedImports(ws.role);
  const wsId = ws?.id ?? '';
  const [batches, setBatches] = useState<ImportBatchDto[]>([]);
  const { set } = badge;

  useFocusEffect(
    useCallback(() => {
      if (!shown) return;
      let live = true;
      api.feedImportsWaiting(wsId).then(
        (list) => {
          if (!live) return;
          setBatches(list);
          set(list.length);
        },
        () => undefined,
      );
      return () => {
        live = false;
      };
    }, [api, wsId, shown, set]),
  );

  const entries = feedImportEntries(batches);
  if (!shown || entries.length === 0) return null;
  return (
    <View style={{ gap: th.space(2) }} testID="review-feed-imports">
      <Body style={{ fontWeight: '700' }}>{t('review.feed.title')}</Body>
      <Small>{t('review.feed.intro')}</Small>
      {entries.map((e) => (
        <Card key={e.id}>
          <Body>{e.title}</Body>
          <Small>{t('review.feed.count', { count: e.count })}</Small>
          <Button
            kind="secondary"
            label={t('review.feed.open')}
            onPress={() => router.push({ pathname: '/import', params: { batch: e.id } })}
            testID="review-feed-import"
          />
        </Card>
      ))}
    </View>
  );
}
