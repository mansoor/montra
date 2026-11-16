/**
 * Statements and bills to file, above the phone's swipe review (ADR-0051 §5). Read online, like scans: offline the
 * section says so. Picking the account or provider finishes one and teaches the match memory. A statement is
 * imported only if clean; anything with a decision in it waits for the web.
 */
import { useCallback, useEffect, useState } from 'react';
import { View } from 'react-native';
import type { BillerDto, IntakeDto } from '@montra/schemas';
import { t } from '../i18n';
import {
  afterResolve,
  canFileHere,
  detail,
  fileable,
  pickOptions,
  whyItWaits,
} from '../features/intake-review';
import { useAbilities, useSession } from '../session/SessionProvider';
import { useLocal } from '../sync/SyncProvider';
import { Body, Button, Card, Row, Small, useToast } from './components';
import { Icon } from './icons';
import { useTheme } from './theme';

export function IntakeReview() {
  const th = useTheme();
  const toast = useToast();
  const can = useAbilities();
  const { state: session, api } = useSession();
  const ws = session.status === 'signed_in' ? session.workspace.id : '';
  const accounts = useLocal((s) => s.getReference('accounts')) ?? [];
  const [items, setItems] = useState<IntakeDto[] | null>(null);
  const [billers, setBillers] = useState<BillerDto[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const { importFiles, record } = can;
  const load = useCallback(async () => {
    if (!ws) return;
    try {
      const list = fileable(await api.openIntakes(ws), { importFiles, record });
      setItems(list);
      if (list.some((i) => i.kind === 'bill')) setBillers(await api.billers(ws));
    } catch {
      setItems(null);
    }
  }, [api, ws, importFiles, record]);

  useEffect(() => {
    void load();
  }, [load]);

  const resolve = async (i: IntakeDto, targetId: string) => {
    setBusy(true);
    try {
      const done = await api.resolveIntake(ws, i.id, {
        targetId,
        ...(i.kind === 'statement' ? { commitIfClean: true } : {}),
      });
      const msg = afterResolve(done);
      toast.show(t(msg.key, msg.values));
      setOpen(null);
      if (!msg.stays) setItems((list) => (list ?? []).filter((x) => x.id !== i.id));
    } catch (err) {
      toast.show((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const dismiss = async (i: IntakeDto) => {
    setBusy(true);
    try {
      await api.dismissIntake(ws, i.id);
      toast.show(t('mobile.intakes.dismissed'));
      setItems((list) => (list ?? []).filter((x) => x.id !== i.id));
    } catch (err) {
      toast.show((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (items === null) return can.record ? <Small>{t('mobile.intakes.offline')}</Small> : null;
  if (items.length === 0) return null;
  return (
    <View style={{ gap: th.space(2) }} testID="intakes">
      <Body style={{ fontWeight: '700' }}>{t('mobile.intakes.title')}</Body>
      {items.map((i) => {
        const why = whyItWaits(i);
        const options = pickOptions(
          i,
          i.kind === 'statement'
            ? accounts.filter((a) => a.type === 'asset' || a.type === 'liability')
            : billers,
        );
        return (
          <Card key={i.id} style={{ gap: th.space(2) }} testID="intake-card">
            <Body style={{ fontWeight: '600' }}>{i.fileName}</Body>
            <Small>
              {detail(i)
                .map((d) => t(d.key, d.values))
                .join(' · ')}
            </Small>
            <Body>{t(why.key, why.values)}</Body>
            {open === i.id ? (
              <View>
                {options.map((o, n) => (
                  <Row
                    key={o.id}
                    title={o.label}
                    last={n === options.length - 1}
                    onPress={() => (busy ? undefined : void resolve(i, o.id))}
                    right={o.suggested ? <Icon name="check" size={18} color={th.primary} /> : undefined}
                    testID={`intake-option-${o.id}`}
                  />
                ))}
              </View>
            ) : null}
            <View style={{ flexDirection: 'row', gap: th.space(2) }}>
              {canFileHere(i) ? (
                <View style={{ flex: 1 }}>
                  <Button
                    label={t('mobile.intakes.pick')}
                    disabled={busy}
                    onPress={() => setOpen(open === i.id ? null : i.id)}
                    testID="intake-pick"
                  />
                </View>
              ) : null}
              <View style={{ flex: 1 }}>
                <Button
                  kind="secondary"
                  label={t('intakes.dismiss')}
                  disabled={busy}
                  onPress={() => void dismiss(i)}
                  testID="intake-dismiss"
                />
              </View>
            </View>
            {!canFileHere(i) ? <Small>{t('mobile.intakes.waiting_web')}</Small> : null}
          </Card>
        );
      })}
    </View>
  );
}
