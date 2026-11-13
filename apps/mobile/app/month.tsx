/**
 * Month in review (FLOW-01, AIA-01): the same review as the web. The figures come from the server; the AI (or plain
 * sentences) only words them. Each budget suggestion can be made the budget, after a confirmation.
 */
import { useMemo, useState } from 'react';
import { Alert, Pressable, Text, View } from 'react-native';
import type { MonthSummaryDto } from '@montra/schemas';
import { useCached } from '../src/features/use-cached';
import { currentLocale, fmtMoney, t } from '../src/i18n';
import { useAbilities, useSession } from '../src/session/SessionProvider';
import { Body, Button, Card, Row, Screen, Small, useToast } from '../src/ui/components';
import { haptic } from '../src/ui/haptics';
import { Icon } from '../src/ui/icons';
import { SidePanel } from '../src/ui/SidePanel';
import { useTheme } from '../src/ui/theme';

type Line = NonNullable<MonthSummaryDto['suggestions']>['lines'][number];

export default function MonthReview() {
  const th = useTheme();
  const { state: session, api } = useSession();
  const canBudget = useAbilities().setUp; // AUTH-18
  const ws = session.status === 'signed_in' ? session.workspace.id : '';
  /** Null: last month, the server's default. */
  const [month, setMonth] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [saving, setSaving] = useState<string | null>(null);
  const toast = useToast();
  const review = useCached(
    ws,
    `month-review-${month ?? 'last'}`,
    () => api.monthSummary(ws, month ?? undefined),
    Boolean(ws),
  );
  const d = review.data;
  const monthName = useMemo(() => {
    try {
      return new Intl.DateTimeFormat(currentLocale, { month: 'long', year: 'numeric', timeZone: 'UTC' });
    } catch {
      return null;
    }
  }, []);
  const label = (start: string) =>
    monthName ? monthName.format(new Date(`${start}T00:00:00Z`)) : start.slice(0, 7);
  // This month and the eleven before.
  const months = useMemo(() => {
    const now = new Date();
    return Array.from({ length: 12 }, (_, i) =>
      new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1)).toISOString().slice(0, 10),
    );
  }, []);

  if (!d) return <Screen testID="month-review">{<Small>{t('mobile.common.loading')}</Small>}</Screen>;
  const ccy = d.currency;
  const nextLabel = d.suggestions ? label(d.suggestions.period.start) : '';

  const makeBudget = (l: Line) =>
    Alert.alert(
      t('explore.make_budget'),
      `${t('explore.make_budget_confirm', { name: l.name, month: nextLabel, amount: fmtMoney(l.suggested, ccy) })} ${
        l.current === null
          ? t('explore.make_budget_none')
          : t('explore.make_budget_was', { amount: fmtMoney(l.current, ccy) })
      }`,
      [
        { text: t('mobile.common.cancel'), style: 'cancel' },
        {
          text: t('explore.make_budget_yes'),
          onPress: () => {
            setSaving(l.categoryId);
            api
              .setCategoryBudget(ws, {
                entityId: d.entityId,
                memberId: d.memberId,
                categoryId: l.categoryId,
                assigned: l.suggested,
              })
              .then(
                (r) => {
                  haptic.success();
                  const args = { name: l.name, month: nextLabel, amount: fmtMoney(r.assigned, ccy) };
                  toast.show(
                    r.previous === null
                      ? t('explore.make_budget_done_new', args)
                      : t('explore.make_budget_done', { ...args, previous: fmtMoney(r.previous, ccy) }),
                  );
                  void review.reload();
                },
                () => Alert.alert(t('explore.make_budget'), t('explore.make_budget_failed')),
              )
              .finally(() => setSaving(null));
          },
        },
      ],
    );

  const tile = (title: string, amount: string, hint?: string, bad = false) => (
    <Card style={{ flexBasis: '30%', flexGrow: 1, gap: 2 }}>
      <Small>{title}</Small>
      <Body style={{ fontWeight: '700', color: bad ? th.danger : th.text }}>{fmtMoney(amount, ccy)}</Body>
      {hint ? <Small>{hint}</Small> : null}
    </Card>
  );

  return (
    <Screen testID="month-review">
      <Pressable
        onPress={() => setPicking(true)}
        accessibilityRole="button"
        accessibilityLabel={t('month.pick')}
        testID="month-pick"
        style={{ flexDirection: 'row', alignItems: 'center', gap: th.space(1) }}
      >
        <Text style={{ color: th.text, fontSize: th.font.title, fontWeight: '700' }}>
          {t('month.title', { month: label(d.month.start) })}
        </Text>
        <Icon name="chevronDown" size={18} />
      </Pressable>
      <Small>{d.complete ? t('month.subtitle') : t('month.subtitle_so_far')}</Small>

      <Card testID="month-story">
        <Body style={{ fontWeight: '700' }}>{d.story.headline}</Body>
        {d.story.points.map((p, i) => (
          <Body key={i}>• {p}</Body>
        ))}
        <Small>{d.story.by === 'ai' ? t('month.by_ai') : t('month.by_plain')}</Small>
        {d.needsReview > 0 ? (
          <Small color={th.warning}>{t('month.needs_review', { count: d.needsReview })}</Small>
        ) : null}
      </Card>

      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: th.space(2) }}>
        {tile(
          t('month.money_in'),
          d.income,
          d.usual ? t('month.usual_hint', { amount: fmtMoney(d.usual.income, ccy) }) : undefined,
        )}
        {tile(
          t('month.money_out'),
          d.spent,
          d.usual ? t('month.usual_hint', { amount: fmtMoney(d.usual.spent, ccy) }) : undefined,
        )}
        {tile(
          t('month.left_over'),
          d.left,
          d.keptPercent !== null ? t('month.kept', { percent: d.keptPercent }) : undefined,
          d.left.startsWith('-'),
        )}
      </View>

      <Card>
        <Body style={{ fontWeight: '700' }}>{t('month.changes')}</Body>
        {d.changes.up.length + d.changes.down.length === 0 ? (
          <Small>{d.usual ? t('month.no_changes') : t('month.no_usual')}</Small>
        ) : (
          [...d.changes.up, ...d.changes.down].map((c, i, all) => (
            <Row
              key={c.categoryId}
              title={c.name}
              subtitle={`${fmtMoney(c.spent, ccy)} · ${t('month.usually')} ${fmtMoney(c.usual, ccy)}`}
              right={
                <Text style={{ color: c.change.startsWith('-') ? th.success : th.danger, fontWeight: '600' }}>
                  {c.change.startsWith('-') ? '' : '+'}
                  {fmtMoney(c.change, ccy)}
                </Text>
              }
              last={i === all.length - 1}
            />
          ))
        )}
      </Card>

      {d.largest.length > 0 ? (
        <Card>
          <Body style={{ fontWeight: '700' }}>{t('month.largest')}</Body>
          {d.largest.map((l, i) => (
            <Row
              key={l.transactionId}
              title={l.payee || l.categoryName}
              subtitle={l.categoryName}
              right={<Small>{fmtMoney(l.amount, ccy)}</Small>}
              last={i === d.largest.length - 1}
            />
          ))}
        </Card>
      ) : null}

      {d.budget ? (
        <Card>
          <Body style={{ fontWeight: '700' }}>{t('month.budget')}</Body>
          <Small>
            {t('month.budget_line')} {fmtMoney(d.budget.spent, ccy)} / {fmtMoney(d.budget.assigned, ccy)}
          </Small>
          {d.budget.over.length === 0 ? (
            <Small color={th.success}>{t('month.budget_none_over')}</Small>
          ) : (
            d.budget.over.map((o) => (
              <Small key={o.categoryId} color={th.danger}>
                {t('month.over_by', { name: o.name })} {fmtMoney(o.overBy, ccy)}
              </Small>
            ))
          )}
        </Card>
      ) : null}

      {d.suggestions ? (
        <Card testID="month-suggestions">
          <Body style={{ fontWeight: '700' }}>{t('month.suggestions', { month: nextLabel })}</Body>
          <Small>{d.story.budgetNote ?? t('month.suggestions_hint')}</Small>
          {d.suggestions.lines.map((l) => (
            <View key={l.categoryId} style={{ gap: th.space(1), paddingVertical: th.space(1) }}>
              <Text style={{ color: th.text, fontWeight: '600' }}>
                {l.name} → {fmtMoney(l.suggested, ccy)}
              </Text>
              <Small>
                {l.current === null
                  ? t('month.no_budget_now')
                  : t('month.budget_now', { amount: fmtMoney(l.current, ccy) })}
              </Small>
              {canBudget ? (
                <Button
                  kind="secondary"
                  label={t('explore.make_budget')}
                  busy={saving === l.categoryId}
                  disabled={saving !== null || review.stale}
                  onPress={() => makeBudget(l)}
                />
              ) : null}
            </View>
          ))}
        </Card>
      ) : null}

      <SidePanel
        visible={picking}
        title={t('month.pick')}
        closeLabel={t('mobile.common.cancel')}
        onClose={() => setPicking(false)}
      >
        {months.map((m, i) => (
          <Row
            key={m}
            title={label(m)}
            right={m === d.month.start ? <Icon name="check" size={18} /> : undefined}
            onPress={() => {
              haptic.select();
              setPicking(false);
              setMonth(m);
            }}
            last={i === months.length - 1}
          />
        ))}
      </SidePanel>
    </Screen>
  );
}
