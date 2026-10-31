/**
 * Swipe review (AI-04, 08 §3): a card stack of transactions needing review. Swipe right to accept the suggested
 * category, left (or tap) to choose another — a correction the server learns from. Works offline via the outbox.
 * Buttons offer the same actions for VoiceOver/TalkBack users.
 */
import { useMemo, useRef, useState } from 'react';
import { Animated, PanResponder, Text, useWindowDimensions, View } from 'react-native';
import * as Haptics from 'expo-haptics';
import type { CategoryDto } from '@montra/schemas';
import type { LocalTransaction } from '@montra/sync';
import { fmtDate, fmtMoney, t } from '../../src/i18n';
import { useLocal, useSync } from '../../src/sync/SyncProvider';
import { confidenceLabel, effectiveOutcome, reviewQueue, swipeOutcome } from '../../src/features/review';
import { CategoryPicker } from '../../src/ui/CategoryPicker';
import { Body, Button, Card, Screen, Small, Title, useToast } from '../../src/ui/components';
import { useTheme } from '../../src/ui/theme';

export default function Review() {
  const th = useTheme();
  const toast = useToast();
  const { width } = useWindowDimensions();
  const { engine, touch } = useSync();
  const rows = useLocal((s) => s.listTransactions({ reviewState: 'needs_review', limit: 500 })) ?? [];
  const categories = useLocal((s) => s.getReference('categories')) ?? [];
  const byId = useMemo(() => new Map(categories.map((c) => [c.id, c])), [categories]);
  const queue = useMemo(() => reviewQueue(rows), [rows]);
  const [picking, setPicking] = useState<LocalTransaction | null>(null);
  const current = queue[0];
  const x = useRef(new Animated.Value(0)).current;

  const accept = async (row: LocalTransaction) => {
    await engine.acceptReview(row.id);
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    toast.show(t('mobile.review.accepted'));
    touch();
  };
  const resolve = async (row: LocalTransaction, c: CategoryDto) => {
    setPicking(null);
    await engine.resolveReview(row.id, c.id);
    toast.show(t('mobile.review.resolved', { category: c.name }));
    touch();
  };

  const pan = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_e, g) => Math.abs(g.dx) > 10 && Math.abs(g.dx) > Math.abs(g.dy),
        onPanResponderMove: Animated.event([null, { dx: x }], { useNativeDriver: false }),
        onPanResponderRelease: (_e, g) => {
          const row = current;
          const outcome = row ? effectiveOutcome(swipeOutcome(g.dx, g.vx * 1000, width), row) : 'cancel';
          if (!row || outcome === 'cancel') {
            Animated.spring(x, { toValue: 0, useNativeDriver: false }).start();
            return;
          }
          Animated.timing(x, { toValue: outcome === 'accept' ? width : -width, duration: 160, useNativeDriver: false }).start(() => {
            x.setValue(0);
            if (outcome === 'accept') void accept(row);
            else setPicking(row);
          });
        },
      }),
    // Recreated per card so the release handler sees the current row.
    [current?.id, width],
  );

  if (!current)
    return (
      <Screen>
        <Title>{t('mobile.tab.review')}</Title>
        <Body muted>{t('mobile.review.empty')}</Body>
      </Screen>
    );

  const suggested = current.suggestedCategoryId ? byId.get(current.suggestedCategoryId) : undefined;
  const rotate = x.interpolate({ inputRange: [-width, 0, width], outputRange: ['-12deg', '0deg', '12deg'] });

  return (
    <Screen scroll={false} testID="review">
      <Title>{t('mobile.tab.review')}</Title>
      <Small>
        {t('mobile.review.hint')} {t('mobile.review.remaining', { count: queue.length })}
      </Small>
      <View style={{ flex: 1, justifyContent: 'center' }}>
        <Animated.View {...pan.panHandlers} style={{ transform: [{ translateX: x }, { rotate }] }} testID="review-card">
          <Card style={{ gap: th.space(3), paddingVertical: th.space(6) }}>
            <Text style={{ color: th.text, fontSize: th.font.title, fontWeight: '700' }}>
              {current.merchantName ?? current.payee ?? current.description}
            </Text>
            <Body style={{ fontSize: th.font.amount, fontWeight: '700' }}>{fmtMoney(current.amount, current.currency)}</Body>
            <Small>{fmtDate(current.date)}</Small>
            <Body>
              {suggested ? `${suggested.name}${current.confidence !== null ? ` · ${confidenceLabel(current.confidence)}` : ''}` : t('mobile.review.no_suggestion')}
            </Body>
            {current.explanation ? <Small>{current.explanation}</Small> : null}
          </Card>
        </Animated.View>
      </View>
      <View style={{ flexDirection: 'row', gap: th.space(3) }}>
        <View style={{ flex: 1 }}>
          <Button kind="secondary" label={t('mobile.review.choose')} onPress={() => setPicking(current)} testID="review-choose" />
        </View>
        <View style={{ flex: 1 }}>
          <Button label={t('mobile.review.accept')} disabled={!suggested} onPress={() => void accept(current)} testID="review-accept" />
        </View>
      </View>
      <CategoryPicker
        visible={picking !== null}
        categories={categories}
        kind={picking?.amount?.startsWith('-') ? 'expense' : 'income'}
        onClose={() => setPicking(null)}
        onPick={(c) => picking && void resolve(picking, c)}
      />
    </Screen>
  );
}
