/**
 * An account's holders (ACC-15) and its number, masked to the last four (ACC-16), on the phone's account screen. Holders
 * are shown from the synced account and edited online (the API checks the ACCOUNT_MAX_HOLDERS limit and that a member is
 * in this household). The full number is typed in and shown on the web only.
 */
import { useState } from 'react';
import { View } from 'react-native';
import { holderDrafts, holdersChanged, holdersLine, holdersToSave, type HolderDraft } from '@montra/domain';
import type { AccountDto, FamilyMemberDto } from '@montra/schemas';
import type { Api } from '../api/client';
import { useAbilities } from '../session/SessionProvider';
import { t } from '../i18n';
import { Banner, Body, Button, Card, Chips, Field, Small, Title, useToast } from './components';
import { useTheme } from './theme';

export function AccountHolders({
  api,
  ws,
  account,
  members,
  online,
  onChanged,
}: {
  api: Api;
  ws: string;
  account: AccountDto;
  members: readonly FamilyMemberDto[];
  /** False when showing the saved copy: changes need a connection. */
  online: boolean;
  onChanged: () => void;
}) {
  const th = useTheme();
  const toast = useToast();
  const can = useAbilities();
  // Changing an account is for those who set the books up, in books they can write (as on the web).
  const canEdit = can.setUp && can.writes(account.entityId);
  const [rows, setRows] = useState<HolderDraft[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (i: number, patch: Partial<HolderDraft>) =>
    setRows((r) => (r ? r.map((row, j) => (j === i ? { ...row, ...patch } : row)) : r));
  const memberOptions = (current: string) => [
    { value: '', label: t('accounts.holders_no_member') },
    ...members
      .filter((m) => m.status === 'active' || m.id === current)
      .map((m) => ({ value: m.id, label: m.name })),
  ];

  const save = async () => {
    if (!rows) return;
    setBusy(true);
    setError(null);
    try {
      await api.setAccountHolders(ws, account.id, holdersToSave(rows));
      setRows(null);
      toast.show(t('accounts.holders_saved'));
      onChanged();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card testID="account-holders">
      {account.accountNumberMasked ? (
        <View style={{ gap: th.space(1) }}>
          <Small>{t('accounts.number')}</Small>
          <View testID="account-number-masked">
            <Body style={{ fontWeight: '600' }}>{account.accountNumberMasked}</Body>
          </View>
        </View>
      ) : null}
      <Title>{t('accounts.holders')}</Title>
      {error ? <Banner tone="danger" text={error} /> : null}
      {rows === null ? (
        <>
          <View testID="account-holders-line">
            <Body>
              {account.holders.length
                ? holdersLine(account.holders, t('accounts.holders_and'))
                : t('accounts.holders_none')}
            </Body>
          </View>
          {canEdit ? (
            <Button
              kind="secondary"
              label={t('mobile.account.holders_edit')}
              onPress={() => setRows(holderDrafts(account.holders))}
              disabled={!online}
              testID="account-holders-edit"
            />
          ) : null}
        </>
      ) : (
        <>
          <Small>{t('accounts.holders_hint')}</Small>
          {rows.map((row, i) => (
            <View key={i} style={{ gap: th.space(2) }} testID={`account-holder-${i}`}>
              <Field
                label={t('accounts.holders_name')}
                value={row.name}
                maxLength={100}
                placeholder={members.find((m) => m.id === row.memberId)?.name}
                onChangeText={(name) => set(i, { name })}
              />
              <Chips
                label={t('accounts.holders_member')}
                value={row.memberId}
                options={memberOptions(row.memberId)}
                onChange={(memberId) => set(i, { memberId })}
                testID={`account-holder-${i}-member`}
              />
              <Button
                kind="secondary"
                label={t('accounts.holders_remove')}
                onPress={() => setRows((r) => (r ? r.filter((_, j) => j !== i) : r))}
              />
            </View>
          ))}
          <Button
            kind="secondary"
            label={t('accounts.holders_add')}
            onPress={() => setRows((r) => [...(r ?? []), { name: '', memberId: '' }])}
            testID="account-holders-add"
          />
          <Button
            label={t('common.save')}
            onPress={() => void save()}
            disabled={!online || !holdersChanged(account.holders, rows)}
            busy={busy}
            testID="account-holders-save"
          />
          <Button kind="secondary" label={t('common.cancel')} onPress={() => setRows(null)} />
        </>
      )}
    </Card>
  );
}
