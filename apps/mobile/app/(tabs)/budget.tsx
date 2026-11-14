/**
 * Budget tab (08 §3, BUD-01..10, FLOW-04): a period's left to assign, groups and lines with pace; tap a line to
 * assign or move money. Everything is computed by the server: writes need a connection (they send the budget
 * version and show the recomputed period), and offline the last copy stays readable.
 */
import { useState } from 'react';
import { Pressable, View } from 'react-native';
import type { BudgetPeriodDto } from '@montra/schemas';
import { fmtDate, fmtMoney, t } from '../../src/i18n';
import { useAbilities, useSession } from '../../src/session/SessionProvider';
import {
  assignedInput,
  lineTone,
  parseAssigned,
  percentOf,
  stepPeriod,
  visibleGroups,
} from '../../src/features/planning';
import { useCached } from '../../src/features/use-cached';
import {
  Banner,
  Body,
  Button,
  Card,
  Field,
  ProgressBar,
  Screen,
  Small,
  Title,
  useToast,
} from '../../src/ui/components';
import { BillersCard, billerSummary } from '../../src/ui/Billers';
import { useTheme } from '../../src/ui/theme';

type Line = BudgetPeriodDto['groups'][number]['lines'][number];

export default function Budget() {
  const { state: session, api } = useSession();
  const toast = useToast();
  const ws = session.status === 'signed_in' ? session.workspace.id : '';
  const personal =
    session.status === 'signed_in'
      ? (session.workspace.entities.find((e) => e.type === 'personal') ?? session.workspace.entities[0])
      : undefined;
  const budgets = useCached(ws, 'budgets', () => api.budgets(ws), Boolean(ws));
  const budget = budgets.data?.find((b) => !b.archived && b.memberId === null && b.entityId === personal?.id);
  const [creating, setCreating] = useState(false);
  // Budgets are set up by those who keep the books; others see them (AUTH-18).
  const can = useAbilities();
  const canEdit = can.setUp && can.writes(personal?.id);

  if (budgets.data && !budget) {
    return (
      <Screen testID="budget-empty">
        <Title>{t('nav.budget')}</Title>
        <Card>
          <Body>{t('budget.none_yet')}</Body>
          <Small>{canEdit ? t('mobile.budget.setup_hint') : t('mobile.role.not_allowed')}</Small>
          {canEdit ? (
            <Button
              label={t('budget.create')}
              busy={creating}
              disabled={budgets.stale || !personal}
              testID="budget-create"
              onPress={() => {
                setCreating(true);
                void api
                  .createBudget(ws, { entityId: personal!.id, name: t('budget.default_name') })
                  .then(() => budgets.reload())
                  .catch((e: Error) => toast.show(e.message))
                  .finally(() => setCreating(false));
              }}
            />
          ) : null}
        </Card>
      </Screen>
    );
  }
  if (!budget) {
    return (
      <Screen testID="budget-loading">
        <Title>{t('nav.budget')}</Title>
        {budgets.stale ? <Banner tone="warning" text={t('mobile.plan.offline_empty')} /> : null}
        {budgets.error ? <Banner tone="danger" text={budgets.error} /> : null}
      </Screen>
    );
  }
  return <BudgetPeriod ws={ws} budgetId={budget.id} entityId={budget.entityId} canEdit={canEdit} />;
}

function BudgetPeriod({
  ws,
  budgetId,
  entityId,
  canEdit,
}: {
  ws: string;
  budgetId: string;
  entityId: string;
  canEdit: boolean;
}) {
  const th = useTheme();
  const toast = useToast();
  const { api } = useSession();
  const [start, setStart] = useState('current');
  const [showAll, setShowAll] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const cached = useCached(ws, `budget.${budgetId}.${start}`, () => api.budgetPeriod(ws, budgetId, start));
  // Bill providers on the budget's categories (ADR-0048 §4).
  const billers = useCached(ws, `billers.${entityId}`, () => api.billers(ws, entityId));
  const active = (billers.data ?? []).filter((b) => !b.archived);
  const p = cached.data;
  if (!p) {
    return (
      <Screen testID="budget">
        <Title>{t('nav.budget')}</Title>
        {cached.stale ? <Banner tone="warning" text={t('mobile.plan.offline_empty')} /> : null}
        {cached.error ? <Banner tone="danger" text={cached.error} /> : null}
      </Screen>
    );
  }
  const ccy = p.budget.currency;
  const lta = BigInt(p.leftToAssign);
  const write = async (fn: () => Promise<BudgetPeriodDto>, ok?: string) => {
    setBusy(true);
    try {
      cached.set(await fn());
      if (ok) toast.show(ok);
      return true;
    } catch (e) {
      const err = e as { status?: number; message: string };
      // Someone else changed the budget: show their version so the next edit is against it.
      if (err.status === 409) await cached.reload();
      toast.show(err.message);
      return false;
    } finally {
      setBusy(false);
    }
  };
  const lines = p.groups.flatMap((g) => g.lines);

  return (
    <Screen testID="budget">
      <Title>{p.budget.name}</Title>
      {cached.stale ? <Banner tone="warning" text={t('mobile.plan.offline')} /> : null}
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <Button
          kind="secondary"
          label="‹"
          hint={t('budget.previous')}
          onPress={() => setStart(stepPeriod(p.budget, p.start, -1))}
        />
        <Body style={{ fontWeight: '600' }}>
          {fmtDate(p.start)} – {fmtDate(p.end)}
        </Body>
        <Button
          kind="secondary"
          label="›"
          hint={t('budget.next')}
          onPress={() => setStart(stepPeriod(p.budget, p.start, 1))}
        />
      </View>
      {p.budget.method === 'category_limits' ? null : (
        <Card testID="left-to-assign">
          <Small>{t('budget.lta_label')}</Small>
          <Body
            style={{
              fontSize: th.font.amount,
              fontWeight: '700',
              color: lta < 0n ? th.danger : lta > 0n ? th.primary : th.text,
            }}
          >
            {fmtMoney(p.leftToAssign, ccy)}
          </Body>
          <Small>
            {lta < 0n
              ? t('budget.over_assigned_hint')
              : lta === 0n
                ? t('budget.every_dollar')
                : t('budget.ready_to_assign')}
          </Small>
          <Small>
            {t('budget.income_detail', {
              expected: fmtMoney(p.income.expected, ccy),
              actual: fmtMoney(p.income.actual, ccy),
            })}
          </Small>
        </Card>
      )}
      {canEdit ? (
        <Button
          kind="secondary"
          label={t('budget.copy_last')}
          disabled={busy || cached.stale}
          onPress={() =>
            void write(
              () => api.copyBudget(ws, p.budget.id, p.start, 'last', p.budget.version),
              t('budget.copied'),
            )
          }
        />
      ) : null}
      {visibleGroups(p.groups, showAll).map((g) => (
        <Card key={g.id}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
            <Body style={{ fontWeight: '700' }}>{g.name}</Body>
            <Small>
              {t('budget.available')} {fmtMoney(g.available, ccy)}
            </Small>
          </View>
          {g.lines.map((l) => (
            <BudgetLine
              key={`${p.start}-${l.categoryId}`}
              line={l}
              currency={ccy}
              expanded={open === l.categoryId}
              lines={lines}
              disabled={busy || cached.stale}
              onToggle={() => canEdit && setOpen(open === l.categoryId ? null : l.categoryId)}
              onAssign={(assigned) =>
                write(() =>
                  api.assignBudget(ws, p.budget.id, p.start, l.categoryId, assigned, p.budget.version),
                )
              }
              onMove={(to, amount) =>
                write(
                  () =>
                    api.moveBudget(ws, p.budget.id, p.start, {
                      from: l.categoryId,
                      to,
                      amount,
                      version: p.budget.version,
                    }),
                  t('budget.moved'),
                )
              }
            />
          ))}
          {active
            .filter((b) => g.lines.some((l) => l.categoryId === b.categoryId))
            .map((b) => (
              <Small key={b.id}>{billerSummary(b)}</Small>
            ))}
        </Card>
      ))}
      <BillersCard
        billers={active}
        categories={lines.map((l) => ({ id: l.categoryId, name: l.name }))}
        canEdit={canEdit && !cached.stale}
        onAdd={async (input) => {
          try {
            await api.createBiller(ws, input);
            await billers.reload();
            toast.show(t('mobile.billers.added', { name: input.name }));
            return true;
          } catch (e) {
            toast.show((e as Error).message);
            return false;
          }
        }}
      />
      <Button
        kind="secondary"
        label={showAll ? t('mobile.budget.hide_unused') : t('budget.show_all')}
        onPress={() => setShowAll(!showAll)}
      />
    </Screen>
  );
}

function BudgetLine({
  line,
  currency,
  expanded,
  lines,
  disabled,
  onToggle,
  onAssign,
  onMove,
}: {
  line: Line;
  currency: string;
  expanded: boolean;
  lines: Line[];
  disabled: boolean;
  onToggle: () => void;
  onAssign: (minor: string) => Promise<boolean>;
  onMove: (to: string | null, minor: string) => Promise<boolean>;
}) {
  const th = useTheme();
  const toast = useToast();
  const [assigned, setAssigned] = useState(assignedInput(line.assigned, currency));
  const [amount, setAmount] = useState('');
  const [to, setTo] = useState<string | null>(null);
  const total = BigInt(line.available) + BigInt(line.activity);
  const tone = lineTone(line);
  const color = tone === 'danger' ? th.danger : tone === 'warning' ? th.warning : th.text;
  return (
    <View style={{ gap: th.space(1), paddingVertical: th.space(2) }}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        accessibilityLabel={t('mobile.budget.line', {
          name: line.name,
          available: fmtMoney(line.available, currency),
        })}
        onPress={onToggle}
        style={{ gap: th.space(1), minHeight: 44, justifyContent: 'center' }}
      >
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: th.space(2) }}>
          <Body style={{ flexShrink: 1 }}>{line.name}</Body>
          <Body style={{ fontWeight: '600', color }}>{fmtMoney(line.available, currency)}</Body>
        </View>
        {total > 0n ? (
          <ProgressBar
            label={t('budget.pace_for', { name: line.name })}
            percent={percentOf(line.activity, total)}
            marker={line.pace ? percentOf(line.pace.expectedByToday, total) : null}
            tone={tone === 'danger' ? 'danger' : tone === 'warning' ? 'warning' : 'primary'}
          />
        ) : null}
        <Small>
          {fmtMoney(line.activity, currency)} / {fmtMoney(total, currency)}
          {line.pace?.status === 'over' ? ` · ${t('budget.over_pace')}` : ''}
        </Small>
      </Pressable>
      {expanded ? (
        <View style={{ gap: th.space(2), paddingTop: th.space(1) }}>
          <Field
            label={t('budget.assigned')}
            value={assigned}
            onChangeText={setAssigned}
            keyboardType="decimal-pad"
            testID={`assign-${line.categoryId}`}
          />
          <Button
            label={t('common.save')}
            disabled={disabled}
            testID={`assign-save-${line.categoryId}`}
            onPress={() => {
              const minor = parseAssigned(assigned, currency);
              if (minor === null) return toast.show(t('budget.amount_invalid'));
              void onAssign(minor);
            }}
          />
          <Small>{t('mobile.budget.move_to')}</Small>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: th.space(1) }}>
            {[
              { categoryId: null as string | null, name: t('budget.lta_label') },
              ...lines.filter((l) => l.categoryId !== line.categoryId && BigInt(l.assigned) > 0n),
            ].map((o) => {
              const on = to === o.categoryId;
              return (
                <Pressable
                  key={o.categoryId ?? 'lta'}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: on }}
                  onPress={() => setTo(o.categoryId)}
                  style={{
                    minHeight: 36,
                    justifyContent: 'center',
                    paddingHorizontal: th.space(3),
                    borderRadius: th.radius,
                    borderWidth: 1,
                    borderColor: on ? th.primary : th.border,
                    backgroundColor: on ? th.primary : 'transparent',
                  }}
                >
                  <Small color={on ? th.onPrimary : th.text}>{o.name}</Small>
                </Pressable>
              );
            })}
          </View>
          <Field
            label={t('budget.amount')}
            value={amount}
            onChangeText={setAmount}
            keyboardType="decimal-pad"
          />
          <Button
            kind="secondary"
            label={t('budget.move')}
            disabled={disabled}
            onPress={() => {
              const minor = parseAssigned(amount, currency);
              if (minor === null || minor === '0') return toast.show(t('budget.amount_invalid'));
              void onMove(to, minor).then((ok) => ok && setAmount(''));
            }}
          />
        </View>
      ) : null}
    </View>
  );
}
