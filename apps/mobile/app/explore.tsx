/**
 * Explore spending on the phone (FLOW-01): the same as the web. Pick categories and a period; see them month by month
 * in a chart and a table, what each says, and what-ifs worked out on the phone (nothing is saved).
 */
import { useMemo, useState } from 'react';
import { Alert, Pressable, ScrollView, Text, View } from 'react-native';
import { categoryStats, parseMoney, whatIf, whatIfTarget, type WhatIfChange } from '@montra/domain';
import { CHART_MONTHS, EXPLORE_MAX_CATEGORIES } from '@montra/schemas';
import { useCached } from '../src/features/use-cached';
import { currentLocale, fmtMoney, t } from '../src/i18n';
import { useSession } from '../src/session/SessionProvider';
import { MiniLineChart } from '../src/ui/charts';
import { Body, Button, Card, Field, Row, Screen, Segmented, Small, useToast } from '../src/ui/components';
import { haptic } from '../src/ui/haptics';
import { Icon } from '../src/ui/icons';
import { SidePanel } from '../src/ui/SidePanel';
import { useTheme } from '../src/ui/theme';

type Months = (typeof CHART_MONTHS)[number];
const RANGE_LABELS: Record<Months, string> = {
  3: 'home.charts.range_3',
  6: 'home.charts.range_6',
  12: 'home.charts.range_12',
  24: 'home.charts.range_24',
};
const CUTS = [10, 20, 30, 50];
type Plan = { kind: 'none' } | { kind: 'cut'; percent: number } | { kind: 'cap'; amount: string };

export default function Explore() {
  const th = useTheme();
  const { state: session, api } = useSession();
  const ws = session.status === 'signed_in' ? session.workspace.id : '';
  const [months, setMonths] = useState<Months>(6);
  /** Null until chosen: the server picks the three biggest everyday categories. */
  const [picked, setPicked] = useState<string[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [plans, setPlans] = useState<Record<string, Plan>>({});
  const key = `explore-${months}-${(picked ?? []).join(',')}`;
  const explore = useCached(ws, key, () => api.spendingExplore(ws, months, picked ?? []), Boolean(ws));
  const d = explore.data;
  const toast = useToast();
  const [saving, setSaving] = useState<string | null>(null);
  const goals = useCached(ws, 'goals', () => api.goals(ws), Boolean(ws)).data ?? [];
  const monthName = useMemo(() => {
    try {
      return new Intl.DateTimeFormat(currentLocale, { month: 'short', year: '2-digit', timeZone: 'UTC' });
    } catch {
      return null;
    }
  }, []);
  const label = (start: string) =>
    monthName ? monthName.format(new Date(`${start}T00:00:00Z`)) : start.slice(0, 7);

  if (!d) return <Screen testID="explore">{<Small>{t('mobile.common.loading')}</Small>}</Screen>;
  const ccy = d.currency;
  const ids = d.categories.map((c) => c.categoryId);
  const big = (s: string) => BigInt(s);
  const stats = d.categories.map((c) => categoryStats(c.monthly.map(big), c.counts, d.spending.map(big)));
  const changes = d.categories.flatMap((c): WhatIfChange[] => {
    const p = plans[c.categoryId];
    if (!p || p.kind === 'none') return [];
    if (p.kind === 'cut') return [{ categoryId: c.categoryId, cutPercent: p.percent }];
    try {
      return [{ categoryId: c.categoryId, capMinor: parseMoney(p.amount.replace(',', '.'), ccy).amount }];
    } catch {
      return [];
    }
  });
  const result = whatIf({
    income: d.income.map(big),
    spending: d.spending.map(big),
    categories: d.categories.map((c) => ({ categoryId: c.categoryId, monthly: c.monthly.map(big) })),
    changes,
    goals: goals
      .filter((g) => g.target !== null)
      .map((g) => ({ id: g.id, name: g.name, remaining: BigInt(g.target!) - BigInt(g.progress.saved) })),
  });
  const unpicked = d.choices.filter((c) => !ids.includes(c.categoryId));
  // "Make this my budget": this period's budget for the category becomes the what-if's monthly amount, after a
  // confirmation that names the month and what it replaces.
  const budgetMonth = label(d.budget?.period.start ?? d.periods[d.periods.length - 1]!.start);
  const makeBudget = (c: (typeof d.categories)[number], target: bigint) =>
    Alert.alert(
      t('explore.make_budget'),
      `${t('explore.make_budget_confirm', { name: c.name, month: budgetMonth, amount: fmtMoney(target, ccy) })} ${
        c.assigned === null
          ? t('explore.make_budget_none')
          : t('explore.make_budget_was', { amount: fmtMoney(c.assigned, ccy) })
      }`,
      [
        { text: t('mobile.common.cancel'), style: 'cancel' },
        {
          text: t('explore.make_budget_yes'),
          onPress: () => {
            setSaving(c.categoryId);
            api
              .setCategoryBudget(ws, {
                entityId: d.entityId,
                memberId: d.memberId,
                categoryId: c.categoryId,
                assigned: String(target),
              })
              .then(
                (r) => {
                  haptic.success();
                  const args = {
                    name: c.name,
                    month: label(r.period.start),
                    amount: fmtMoney(r.assigned, ccy),
                  };
                  toast.show(
                    r.previous === null
                      ? t('explore.make_budget_done_new', args)
                      : t('explore.make_budget_done', { ...args, previous: fmtMoney(r.previous, ccy) }),
                  );
                  void explore.reload();
                },
                () => Alert.alert(t('explore.make_budget'), t('explore.make_budget_failed')),
              )
              .finally(() => setSaving(null));
          },
        },
      ],
    );
  const chip = (active: boolean) => ({
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 16,
    backgroundColor: active ? th.primary : th.surfaceAlt,
  });
  const colW = 92;

  return (
    <Screen testID="explore">
      <Small>{t('explore.subtitle')}</Small>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: th.space(2) }}>
        {d.categories.map((c) => (
          <Pressable
            key={c.categoryId}
            disabled={ids.length < 2}
            onPress={() => setPicked(ids.filter((x) => x !== c.categoryId))}
            accessibilityRole="button"
            accessibilityLabel={t('explore.remove', { name: c.name })}
            style={[chip(true), { flexDirection: 'row', alignItems: 'center', gap: 4 }]}
          >
            <Text style={{ color: th.onPrimary }}>{c.name}</Text>
            {ids.length > 1 ? <Icon name="close" size={14} color={th.onPrimary} /> : null}
          </Pressable>
        ))}
        {ids.length < EXPLORE_MAX_CATEGORIES && unpicked.length ? (
          <Pressable
            onPress={() => setAdding(true)}
            accessibilityRole="button"
            accessibilityLabel={t('explore.add')}
            testID="explore-add"
            style={[chip(false), { flexDirection: 'row', alignItems: 'center', gap: 4 }]}
          >
            <Icon name="add" size={14} />
            <Text style={{ color: th.text }}>{t('explore.add')}</Text>
          </Pressable>
        ) : null}
      </View>
      <Segmented
        label={t('home.charts.range')}
        value={String(months)}
        onChange={(v) => setMonths(Number(v) as Months)}
        options={CHART_MONTHS.map((n) => ({ value: String(n), label: t(RANGE_LABELS[n]) }))}
      />

      {d.categories.length === 0 ? (
        <Small>{t('explore.nothing')}</Small>
      ) : (
        <>
          <Card>
            <MiniLineChart
              title={t('explore.chart')}
              summary={t('home.charts.current_month_note')}
              currency={ccy}
              months={d.periods.map((p) => p.start)}
              series={d.categories.map((c) => ({ label: c.name, values: c.monthly }))}
              height={170}
            />
          </Card>

          <Card>
            <Body style={{ fontWeight: '700' }}>{t('explore.by_month')}</Body>
            <ScrollView horizontal showsHorizontalScrollIndicator={false}>
              <View testID="explore-table">
                {[
                  {
                    key: 'head',
                    cells: [t('explore.month'), ...d.categories.map((c) => c.name)],
                    strong: true,
                  },
                  ...[...d.periods.keys()].reverse().map((i) => ({
                    key: d.periods[i]!.start,
                    cells: [
                      label(d.periods[i]!.start),
                      ...d.categories.map((c) => fmtMoney(c.monthly[i]!, ccy)),
                    ],
                    strong: false,
                  })),
                  {
                    key: 'avg',
                    cells: [t('explore.average'), ...stats.map((s) => fmtMoney(s.average, ccy))],
                    strong: true,
                  },
                ].map((row) => (
                  <View
                    key={row.key}
                    style={{
                      flexDirection: 'row',
                      borderBottomWidth: 1,
                      borderColor: th.border,
                      paddingVertical: 6,
                    }}
                  >
                    {row.cells.map((cell, i) => (
                      <Text
                        key={i}
                        numberOfLines={2}
                        style={{
                          width: i === 0 ? 96 : colW,
                          textAlign: i === 0 ? 'left' : 'right',
                          color: row.key === 'head' ? th.muted : th.text,
                          fontSize: th.font.small,
                          fontWeight: row.strong ? '700' : '400',
                          fontVariant: ['tabular-nums'],
                        }}
                      >
                        {cell}
                      </Text>
                    ))}
                  </View>
                ))}
              </View>
            </ScrollView>
          </Card>

          {d.categories.map((c, i) => {
            const s = stats[i]!;
            return (
              <Card key={c.categoryId} testID="explore-card">
                <Body style={{ fontWeight: '700' }}>
                  {c.name}
                  {c.group ? <Text style={{ color: th.muted, fontWeight: '400' }}> · {c.group}</Text> : null}
                </Body>
                <Body>
                  {s.changePercent === null
                    ? t('explore.steady_unknown', { average: fmtMoney(s.average, ccy) })
                    : t(
                        s.changePercent > 0
                          ? 'explore.up'
                          : s.changePercent < 0
                            ? 'explore.down'
                            : 'explore.flat',
                        { percent: Math.abs(s.changePercent), recent: fmtMoney(s.recent, ccy) },
                      )}
                </Body>
                <Small>{t('explore.average_line', { amount: fmtMoney(s.average, ccy) })}</Small>
                <Small>{t('explore.share', { percent: s.share })}</Small>
                <Small>
                  {t('explore.purchases', { count: s.purchasesPerMonth })}
                  {s.typical !== null ? ` ${t('explore.typical', { amount: fmtMoney(s.typical, ccy) })}` : ''}
                </Small>
                {s.highest ? (
                  <Small>
                    {t('explore.highest', {
                      month: label(d.periods[s.highest.index]!.start),
                      amount: fmtMoney(s.highest.amount, ccy),
                    })}
                  </Small>
                ) : null}
                <Small>{t('explore.pace', { amount: fmtMoney(s.recent * 12n, ccy) })}</Small>
                {c.topPlaces.map((p, n) => (
                  <Row
                    key={p.name}
                    title={p.name}
                    right={
                      <Small>
                        {fmtMoney(p.amount, ccy)} ×{p.count}
                      </Small>
                    }
                    last={n === c.topPlaces.length - 1}
                  />
                ))}
              </Card>
            );
          })}

          <Card testID="explore-whatif">
            <Body style={{ fontWeight: '700' }}>{t('explore.whatif')}</Body>
            <Small>{t('explore.whatif_hint')}</Small>
            {d.categories.map((c) => {
              const p = plans[c.categoryId] ?? { kind: 'none' };
              const saved = result.perCategory.find((x) => x.categoryId === c.categoryId)?.monthly;
              const change = changes.find((x) => x.categoryId === c.categoryId);
              const target = change ? whatIfTarget(c.monthly.map(big), change) : null;
              const set = (next: Plan) => {
                haptic.select();
                setPlans((all) => ({ ...all, [c.categoryId]: next }));
              };
              return (
                <View key={c.categoryId} style={{ gap: th.space(1), paddingVertical: th.space(1) }}>
                  <Text style={{ color: th.text, fontWeight: '600' }}>
                    {c.name}
                    {saved !== undefined && saved > 0n ? (
                      <Text style={{ color: th.success, fontWeight: '400' }}>
                        {'  '}
                        {t('explore.saves', { amount: fmtMoney(saved, ccy) })}
                      </Text>
                    ) : null}
                  </Text>
                  <Small>
                    {c.assigned === null
                      ? t('explore.no_budget')
                      : t('explore.budget_now', { amount: fmtMoney(c.assigned, ccy) })}
                  </Small>
                  <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                    <View style={{ flexDirection: 'row', gap: th.space(2) }}>
                      {[
                        { kind: 'none' } as Plan,
                        ...CUTS.map((n) => ({ kind: 'cut', percent: n }) as Plan),
                        { kind: 'cap', amount: '' } as Plan,
                      ].map((o) => {
                        const on =
                          o.kind === p.kind &&
                          (o.kind !== 'cut' || (p.kind === 'cut' && p.percent === o.percent));
                        return (
                          <Pressable
                            key={o.kind === 'cut' ? `cut-${o.percent}` : o.kind}
                            onPress={() => set(o.kind === 'cap' && p.kind === 'cap' ? p : o)}
                            accessibilityRole="radio"
                            accessibilityState={{ checked: on }}
                            style={chip(on)}
                          >
                            <Text style={{ color: on ? th.onPrimary : th.text }}>
                              {o.kind === 'none'
                                ? t('explore.no_change')
                                : o.kind === 'cut'
                                  ? `−${o.percent}%`
                                  : t('explore.cap')}
                            </Text>
                          </Pressable>
                        );
                      })}
                    </View>
                  </ScrollView>
                  {p.kind === 'cap' ? (
                    <Field
                      label={t('explore.cap_amount', { name: c.name })}
                      keyboardType="decimal-pad"
                      value={p.amount}
                      onChangeText={(amount) =>
                        setPlans((all) => ({ ...all, [c.categoryId]: { kind: 'cap', amount } }))
                      }
                    />
                  ) : null}
                  {target !== null ? (
                    <Button
                      kind="secondary"
                      label={t('explore.make_budget')}
                      busy={saving === c.categoryId}
                      disabled={saving !== null || explore.stale}
                      onPress={() => makeBudget(c, target)}
                    />
                  ) : null}
                </View>
              );
            })}
            {result.monthly > 0n ? (
              <View
                style={{
                  backgroundColor: th.surfaceAlt,
                  borderRadius: th.radius,
                  padding: th.space(3),
                  gap: 4,
                }}
                accessibilityLiveRegion="polite"
              >
                <Body style={{ fontWeight: '600' }}>
                  {t('explore.result', {
                    monthly: fmtMoney(result.monthly, ccy),
                    yearly: fmtMoney(result.yearly, ccy),
                  })}
                </Body>
                {result.keptBefore !== null && result.keptAfter !== null ? (
                  <Small>
                    {t('explore.result_kept', { before: result.keptBefore, after: result.keptAfter })}
                  </Small>
                ) : null}
                {result.goals.map((g) => (
                  <Small key={g.id}>
                    {g.monthsAfter === null
                      ? t('explore.goal_never', { name: g.name })
                      : g.monthsBefore === null
                        ? t('explore.goal_now', { name: g.name, after: g.monthsAfter })
                        : t('explore.goal', { name: g.name, before: g.monthsBefore, after: g.monthsAfter })}
                  </Small>
                ))}
              </View>
            ) : (
              <Small>{t('explore.whatif_empty')}</Small>
            )}
          </Card>
        </>
      )}

      <SidePanel
        visible={adding}
        title={t('explore.add')}
        closeLabel={t('mobile.common.cancel')}
        onClose={() => setAdding(false)}
      >
        {unpicked.map((c, i) => (
          <Row
            key={c.categoryId}
            title={c.name}
            subtitle={c.group ?? undefined}
            right={<Small>{fmtMoney(c.total, ccy)}</Small>}
            onPress={() => {
              haptic.select();
              setPicked([...ids, c.categoryId]);
              setAdding(false);
            }}
            last={i === unpicked.length - 1}
          />
        ))}
      </SidePanel>
    </Screen>
  );
}
