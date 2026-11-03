/** Goals on the phone (BUD-07, BUD-08, FAM-07): progress, what's needed per month and debt payoff dates. */
import { View } from 'react-native';
import { fmtDate, fmtMoney, t } from '../src/i18n';
import { percentOf } from '../src/features/planning';
import { useCached } from '../src/features/use-cached';
import { useSession } from '../src/session/SessionProvider';
import { Banner, Body, Card, ProgressBar, Screen, Small } from '../src/ui/components';
import { useTheme } from '../src/ui/theme';

export default function Goals() {
  const th = useTheme();
  const { state: session, api } = useSession();
  const ws = session.status === 'signed_in' ? session.workspace.id : '';
  const goals = useCached(ws, 'goals', () => api.goals(ws), Boolean(ws));
  const active = (goals.data ?? []).filter((g) => !g.archived);
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
      {active.map((g) => (
        <Card key={g.id} testID="goal">
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
      ))}
    </Screen>
  );
}
