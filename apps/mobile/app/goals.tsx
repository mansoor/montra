/**
 * Goals on the phone (BUD-07, BUD-08, FAM-07): progress, what's needed per month and debt payoff dates. Tap a goal
 * to edit it or archive it; archived goals sit at the bottom, ready to restore.
 */
import { useState } from 'react';
import { Alert, Pressable, View } from 'react-native';
import type { AccountDto, FamilyMemberDto, GoalDto, UpdateGoalRequest } from '@montra/schemas';
import { ApiError } from '../src/api/client';
import { fmtDate, fmtMoney, t } from '../src/i18n';
import { goalDraft, goalPatch, linkableAccounts, type GoalDraft } from '../src/features/goals';
import { percentOf } from '../src/features/planning';
import { useCached } from '../src/features/use-cached';
import { useSession } from '../src/session/SessionProvider';
import {
  Banner,
  Body,
  Button,
  Card,
  CheckRow,
  Disclosure,
  Field,
  ProgressBar,
  Screen,
  Segmented,
  Small,
  useToast,
} from '../src/ui/components';
import { haptic } from '../src/ui/haptics';
import { SidePanel } from '../src/ui/SidePanel';
import { useTheme } from '../src/ui/theme';

/** What to tell the user when a save fails. */
function failure(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.offline) return t('mobile.plan.offline');
    if (err.code === 'version.conflict') return t('mobile.goal.conflict');
    return err.message;
  }
  return t('errors.generic');
}

export default function Goals() {
  const th = useTheme();
  const toast = useToast();
  const { state: session, api } = useSession();
  const ws = session.status === 'signed_in' ? session.workspace.id : '';
  const goals = useCached(ws, 'goals', () => api.goals(ws), Boolean(ws));
  const accounts = useCached(ws, 'goal-accounts', () => api.accountList(ws), Boolean(ws));
  const members = useCached(ws, 'family-members', () => api.familyMembers(ws), Boolean(ws));
  const [editingId, setEditingId] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [restoring, setRestoring] = useState<string | null>(null);
  /** Shown when the panel reopens on a fresher copy after a version conflict. */
  const [notice, setNotice] = useState<string | null>(null);
  const all = goals.data ?? [];
  const active = all.filter((g) => !g.archived);
  const archived = all.filter((g) => g.archived);
  const editing = all.find((g) => g.id === editingId) ?? null;

  const restore = async (g: GoalDto) => {
    setRestoring(g.id);
    try {
      await api.updateGoal(ws, g.id, { archived: false, version: g.version });
      haptic.success();
      toast.show(t('goal.restored', { name: g.name }));
    } catch (err) {
      Alert.alert(t('goal.restore_named', { name: g.name }), failure(err));
    } finally {
      setRestoring(null);
      await goals.reload();
    }
  };

  return (
    <Screen testID="goals">
      {goals.stale ? <Banner tone="warning" text={t('mobile.plan.offline')} /> : null}
      {goals.error ? <Banner tone="danger" text={goals.error} /> : null}
      {goals.data && active.length === 0 ? (
        <Card>
          <Body>{t('goal.empty')}</Body>
          <Small>{t('goal.empty_hint')}</Small>
        </Card>
      ) : null}
      {active.length > 0 ? <Small>{t('mobile.goal.tap_to_edit')}</Small> : null}
      {active.map((g) => (
        <Pressable
          key={g.id}
          testID="goal"
          onPress={() => {
            setNotice(null);
            setEditingId(g.id);
          }}
          accessibilityRole="button"
          accessibilityLabel={t('goal.edit_named', { name: g.name })}
          style={({ pressed }) => ({ opacity: pressed ? 0.85 : 1 })}
        >
          <Card>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: th.space(2) }}>
              <Body style={{ fontWeight: '700', flexShrink: 1 }}>{g.name}</Body>
              {g.progress.onTrack !== null ? (
                <Small color={g.progress.onTrack ? th.success : th.warning}>
                  {g.progress.onTrack ? t('goal.on_track') : t('goal.behind')}
                </Small>
              ) : null}
            </View>
            <Small>
              {t(`goal.type_${g.type}`)}
              {g.dueDate ? ` · ${t('goal.due')} ${fmtDate(g.dueDate)}` : ''}
            </Small>
            {g.target ? (
              <>
                <Body>
                  {fmtMoney(g.progress.saved, g.currency)} / {fmtMoney(g.target, g.currency)}
                </Body>
                <ProgressBar
                  label={t('goal.progress_for', { name: g.name })}
                  percent={percentOf(g.progress.saved, g.target)}
                  tone="success"
                />
              </>
            ) : null}
            {g.progress.monthlyNeeded ? (
              <Small>
                {t('goal.monthly_needed')}: {fmtMoney(g.progress.monthlyNeeded, g.currency)}
              </Small>
            ) : null}
            {g.progress.projectedCompletion ? (
              <Small>
                {t('goal.projected')}: {fmtDate(g.progress.projectedCompletion)}
              </Small>
            ) : null}
            {g.payoff ? (
              <>
                <Small>
                  {t('goal.payoff_summary', { strategy: t(`goal.strategy_${g.payoff.strategy}`) })}{' '}
                  {g.payoff.payoffDate ? fmtDate(g.payoff.payoffDate) : t('goal.never')}
                </Small>
                <Small>
                  {t('goal.monthly_payment')} {fmtMoney(g.payoff.monthlyPayment, g.currency)}
                  {g.payoff.totalInterest
                    ? ` · ${t('goal.interest')} ${fmtMoney(g.payoff.totalInterest, g.currency)}`
                    : ''}
                </Small>
              </>
            ) : null}
          </Card>
        </Pressable>
      ))}
      {archived.length > 0 ? (
        <Disclosure
          title={t('goal.archived_title', { count: archived.length })}
          summary={t('mobile.goal.archived_summary')}
          open={showArchived}
          onToggle={() => setShowArchived(!showArchived)}
          testID="archived-goals"
        >
          <View style={{ gap: th.space(2) }}>
            {archived.map((g) => (
              <View key={g.id} style={{ flexDirection: 'row', alignItems: 'center', gap: th.space(2) }}>
                <View style={{ flex: 1 }}>
                  <Body>{g.name}</Body>
                  <Small>
                    {t(`goal.type_${g.type}`)}
                    {g.target ? ` · ${fmtMoney(g.target, g.currency)}` : ''}
                  </Small>
                </View>
                <Button
                  kind="secondary"
                  label={t('common.restore')}
                  hint={t('goal.restore_named', { name: g.name })}
                  busy={restoring === g.id}
                  disabled={goals.stale}
                  onPress={() => void restore(g)}
                />
              </View>
            ))}
          </View>
        </Disclosure>
      ) : null}
      {editing ? (
        <GoalSheet
          key={`${editing.id}-${editing.version}`}
          goal={editing}
          accounts={accounts.data ?? []}
          members={members.data ?? []}
          offline={goals.stale}
          notice={notice}
          onClose={() => setEditingId(null)}
          onSaved={async (text) => {
            setEditingId(null);
            haptic.success();
            toast.show(text);
            await goals.reload();
          }}
          onConflict={async () => {
            setNotice(t('mobile.goal.conflict'));
            await goals.reload();
          }}
          save={(patch) => api.updateGoal(ws, editing.id, patch)}
        />
      ) : null}
    </Screen>
  );
}

/** The edit panel: the fields of the add form, pre-filled; kind and books stay as they are. */
function GoalSheet({
  goal,
  accounts,
  members,
  offline,
  notice,
  onClose,
  onSaved,
  onConflict,
  save,
}: {
  goal: GoalDto;
  accounts: AccountDto[];
  members: FamilyMemberDto[];
  offline: boolean;
  notice: string | null;
  onClose: () => void;
  onSaved: (message: string) => Promise<void>;
  onConflict: () => Promise<void>;
  save: (patch: UpdateGoalRequest) => Promise<GoalDto>;
}) {
  const th = useTheme();
  const [draft, setDraft] = useState<GoalDraft>(() => goalDraft(goal));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(notice);
  const set = (patch: Partial<GoalDraft>) => setDraft((d) => ({ ...d, ...patch }));
  const linkable = linkableAccounts(accounts, goal);
  const people = members.filter((m) => m.status === 'active' || m.id === goal.memberId);
  const debt = goal.type === 'debt_payoff';

  const send = async (patch: UpdateGoalRequest, success: string) => {
    setBusy(true);
    setError(null);
    try {
      await save(patch);
      await onSaved(success);
    } catch (err) {
      // On a conflict the panel reopens on the fresh copy (its key includes the version), with the notice.
      if (err instanceof ApiError && err.code === 'version.conflict') await onConflict();
      else setError(failure(err));
    } finally {
      setBusy(false);
    }
  };

  const submit = () => {
    const r = goalPatch(goal, draft);
    if (!r.ok) return setError(t(`mobile.goal.invalid_${r.error}`));
    void send(r.patch, t('goal.saved'));
  };

  const archive = () =>
    Alert.alert(
      t('goal.archive_named', { name: goal.name }),
      t('goal.archive_confirm', { name: goal.name }),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('common.archive'),
          style: 'destructive',
          onPress: () =>
            void send(
              { archived: true, version: goal.version },
              t('goal.archived_done', { name: goal.name }),
            ),
        },
      ],
    );

  return (
    <SidePanel
      visible
      title={t('goal.edit_named', { name: goal.name })}
      closeLabel={t('common.cancel')}
      onClose={onClose}
      testID="goal-sheet"
      footer={
        <Button label={t('goal.save')} onPress={submit} busy={busy} disabled={offline} testID="goal-save" />
      }
    >
      <View style={{ gap: th.space(3) }}>
        <Small>
          {t(`goal.type_${goal.type}`)} · {t('goal.kind_fixed')}
        </Small>
        {offline ? <Banner tone="warning" text={t('mobile.plan.offline')} /> : null}
        {error ? <Banner tone="danger" text={error} /> : null}
        <Field
          label={t('goal.name')}
          value={draft.name}
          onChangeText={(name) => set({ name })}
          maxLength={200}
          testID="goal-name"
        />
        <Field
          label={`${t('goal.target')} (${goal.currency})`}
          value={draft.target}
          onChangeText={(target) => set({ target })}
          keyboardType="decimal-pad"
          testID="goal-target"
        />
        <Field
          label={t('goal.due')}
          value={draft.dueDate}
          onChangeText={(dueDate) => set({ dueDate })}
          placeholder="YYYY-MM-DD"
          autoCapitalize="none"
          testID="goal-due"
        />
        {debt ? (
          <>
            <Segmented
              label={t('goal.strategy')}
              value={draft.strategy}
              onChange={(strategy) => set({ strategy })}
              options={[
                { value: 'avalanche', label: t('mobile.goal.avalanche') },
                { value: 'snowball', label: t('mobile.goal.snowball') },
              ]}
            />
            <Small>{t(`goal.strategy_${draft.strategy}`)}</Small>
            <Field
              label={`${t('goal.extra')} (${goal.currency})`}
              value={draft.extraPayment}
              onChangeText={(extraPayment) => set({ extraPayment })}
              keyboardType="decimal-pad"
            />
          </>
        ) : null}
        {people.length > 0 ? (
          <View>
            <Small>{t('goal.member')}</Small>
            {[{ id: null, name: t('members.household') }, ...people].map((m) => (
              <CheckRow
                key={m.id ?? 'household'}
                title={m.name}
                checked={draft.memberId === m.id}
                onPress={() => set({ memberId: m.id })}
              />
            ))}
          </View>
        ) : null}
        {linkable.length > 0 ? (
          <View>
            <Small>{debt ? t('goal.linked_debts') : t('goal.linked_savings')}</Small>
            {linkable.map((a) => {
              const on = draft.linkedAccountIds.includes(a.id);
              return (
                <CheckRow
                  key={a.id}
                  title={a.name}
                  checked={on}
                  onPress={() =>
                    set({
                      linkedAccountIds: on
                        ? draft.linkedAccountIds.filter((x) => x !== a.id)
                        : [...draft.linkedAccountIds, a.id],
                    })
                  }
                />
              );
            })}
            {!debt ? <Small>{t('goal.linked_hint')}</Small> : null}
          </View>
        ) : null}
        <Button
          kind="danger"
          label={t('common.archive')}
          hint={t('goal.archive_named', { name: goal.name })}
          disabled={busy || offline}
          onPress={archive}
          testID="goal-archive"
        />
      </View>
    </SidePanel>
  );
}
