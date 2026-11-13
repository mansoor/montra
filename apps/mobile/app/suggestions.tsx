/** Recommendations on the phone (REC-01..08): nothing changes until Apply; applying needs a connection. */
import { useState } from 'react';
import type { RecommendationDto } from '@montra/schemas';
import { t } from '../src/i18n';
import { useCached } from '../src/features/use-cached';
import { useAbilities, useSession } from '../src/session/SessionProvider';
import { Banner, Body, Button, Card, Screen, Small, useToast } from '../src/ui/components';

const applies = (r: RecommendationDto) =>
  r.payload.actions.some((a) => a.kind === 'assign' || a.kind === 'move' || a.kind === 'fund_goal');

export default function Suggestions() {
  const toast = useToast();
  const { state: session, api } = useSession();
  // Acting on a suggestion changes budgets, goals or rules: for those who set the books up (AUTH-18).
  const canAct = useAbilities().setUp;
  const ws = session.status === 'signed_in' ? session.workspace.id : '';
  const recs = useCached(ws, 'recommendations', () => api.recommendations(ws), Boolean(ws));
  const [busy, setBusy] = useState(false);
  const act = (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    void fn()
      .then(() => recs.reload())
      .then(() => toast.show(ok))
      .catch((e: Error) => toast.show(e.message))
      .finally(() => setBusy(false));
  };
  return (
    <Screen testID="suggestions">
      <Small>{t('rec.subtitle')}</Small>
      {recs.stale ? <Banner tone="warning" text={t('mobile.plan.offline')} /> : null}
      {recs.error ? <Banner tone="danger" text={recs.error} /> : null}
      {canAct ? (
        <Button
          kind="secondary"
          label={t('rec.refresh')}
          disabled={busy || recs.stale}
          onPress={() => act(() => api.refreshRecommendations(ws), t('mobile.suggestions.checked'))}
        />
      ) : null}
      {recs.data?.length === 0 ? (
        <Card>
          <Body>{t('rec.empty')}</Body>
          <Small>{t('rec.empty_hint')}</Small>
        </Card>
      ) : null}
      {recs.data?.map((r) => (
        <Card key={r.id} testID="suggestion">
          <Small>{t(`rec.type_${r.type}`)}</Small>
          <Body style={{ fontWeight: '700' }}>{r.title}</Body>
          {r.wording ? <Small>{r.wording}</Small> : null}
          {canAct && applies(r) ? (
            <Button
              label={t('rec.apply')}
              disabled={busy || recs.stale}
              onPress={() => act(() => api.acceptRecommendation(ws, r.id), t('rec.applied'))}
            />
          ) : null}
          {canAct ? (
            <Button
              kind="secondary"
              label={t('rec.dismiss')}
              disabled={busy || recs.stale}
              onPress={() => act(() => api.dismissRecommendation(ws, r.id), t('rec.dismissed'))}
            />
          ) : null}
        </Card>
      ))}
    </Screen>
  );
}
