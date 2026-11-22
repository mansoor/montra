/**
 * Family members (OPS-13; FAM-01, FAM-02), as on the web's Settings → Family: add someone, rename them or change the
 * relationship, archive and restore. Owners, admins and partners change them, as the database allows; everyone else
 * sees the list. Inviting someone to sign in, and each account's default member, stay on the web.
 */
import { useCallback, useEffect, useState } from 'react';
import { View } from 'react-native';
import type { FamilyMemberDto } from '@montra/schemas';
import {
  RELATIONSHIPS,
  errorText,
  familyMemberPatch,
  familyStatusChange,
  newFamilyMember,
  settingsAbilities,
  type Relationship,
} from '../src/features/settings-edit';
import { t } from '../src/i18n';
import { useSession } from '../src/session/SessionProvider';
import {
  Banner,
  Body,
  Button,
  Card,
  CheckRow,
  Chips,
  Field,
  Screen,
  SectionLabel,
  Small,
  useToast,
} from '../src/ui/components';
import { haptic } from '../src/ui/haptics';
import { useTheme } from '../src/ui/theme';

const relationshipOptions = RELATIONSHIPS.map((v) => ({ value: v, label: t(`members.relationship.${v}`) }));

export default function Family() {
  const { state, api } = useSession();
  const ws = state.status === 'signed_in' ? state.workspace.id : '';
  const role = state.status === 'signed_in' ? state.workspace.role : 'viewer';
  const canEdit = settingsAbilities(role).family;
  const toast = useToast();
  const [members, setMembers] = useState<FamilyMemberDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [relationship, setRelationship] = useState<Relationship>('child');
  const [dependent, setDependent] = useState(false);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    if (!ws) return;
    try {
      setMembers(await api.familyMembers(ws));
    } catch (err) {
      setError(errorText(err, t));
    }
  }, [api, ws]);
  useEffect(() => {
    void reload();
  }, [reload]);

  /** Runs one change, says how it went, and reads the list again. */
  const run = async (fn: () => Promise<unknown>, done: string): Promise<boolean> => {
    setError(null);
    try {
      await fn();
      haptic.success();
      toast.show(done);
      await reload();
      return true;
    } catch (err) {
      setError(errorText(err, t));
      return false;
    }
  };

  const add = async () => {
    const built = newFamilyMember({ name, relationship, isDependent: dependent });
    if (!built.ok) return setError(t(built.error));
    setBusy(true);
    const ok = await run(
      () => api.createFamilyMember(ws, built.value),
      t('members.added', { name: built.value.name }),
    );
    setBusy(false);
    if (ok) {
      setName('');
      setRelationship('child');
      setDependent(false);
    }
  };

  return (
    <Screen testID="family">
      {error ? <Banner tone="danger" text={error} /> : null}
      <Small>{t('members.intro')}</Small>
      {!canEdit ? <Small>{t('mobile.settings.family_read_only')}</Small> : null}
      {(members ?? []).map((m) =>
        canEdit ? (
          <MemberCard key={m.id} member={m} run={run} ws={ws} onError={setError} />
        ) : (
          <Card key={m.id} testID="family-member">
            <Body>{m.name}</Body>
            <Small>
              {t(`members.relationship.${m.relationship}`)}
              {m.status === 'inactive' ? ` · ${t('common.archived')}` : ''}
            </Small>
          </Card>
        ),
      )}
      {canEdit ? (
        <Card testID="family-add">
          <SectionLabel>{t('members.add_label')}</SectionLabel>
          <Field
            label={t('fields.name')}
            value={name}
            onChangeText={setName}
            maxLength={100}
            testID="family-add-name"
          />
          <Small>{t('members.relationship_label')}</Small>
          <Chips
            label={t('members.relationship_label')}
            options={relationshipOptions}
            value={relationship}
            onChange={setRelationship}
            testID="family-add-relationship"
          />
          <CheckRow
            title={t('members.dependent')}
            checked={dependent}
            onPress={() => setDependent(!dependent)}
            testID="family-add-dependent"
          />
          <Button
            label={t('members.add')}
            busy={busy}
            disabled={!name.trim()}
            onPress={() => void add()}
            testID="family-add-save"
          />
        </Card>
      ) : null}
    </Screen>
  );
}

function MemberCard({
  member,
  ws,
  run,
  onError,
}: {
  member: FamilyMemberDto;
  ws: string;
  run: (fn: () => Promise<unknown>, done: string) => Promise<boolean>;
  onError: (text: string) => void;
}) {
  const th = useTheme();
  const { api } = useSession();
  const [name, setName] = useState(member.name);
  const [relationship, setRelationship] = useState<Relationship>(member.relationship);
  const [busy, setBusy] = useState(false);
  const patch = familyMemberPatch(member, { name, relationship });
  const status = familyStatusChange(member);

  const go = async (fn: () => Promise<unknown>, done: string) => {
    setBusy(true);
    await run(fn, done);
    setBusy(false);
  };

  return (
    <Card testID="family-member">
      <Field
        label={t('fields.name')}
        value={name}
        onChangeText={setName}
        maxLength={100}
        testID={`family-name-${member.id}`}
      />
      <Small>{t('members.relationship_label')}</Small>
      <Chips
        label={t('members.relationship_label')}
        options={relationshipOptions}
        value={relationship}
        onChange={setRelationship}
        testID={`family-relationship-${member.id}`}
      />
      {member.status === 'inactive' ? <Small>{t('common.archived')}</Small> : null}
      <View style={{ flexDirection: 'row', gap: th.space(2) }}>
        <View style={{ flex: 1 }}>
          <Button
            label={t('common.save')}
            busy={busy}
            disabled={!patch}
            onPress={() => {
              if (!patch) return;
              if (!patch.ok) return onError(t(patch.error));
              void go(() => api.updateFamilyMember(ws, member.id, patch.value), t('common.saved'));
            }}
            testID={`family-save-${member.id}`}
          />
        </View>
        <View style={{ flex: 1 }}>
          <Button
            kind="secondary"
            label={t(status.label)}
            busy={busy}
            onPress={() => void go(() => api.updateFamilyMember(ws, member.id, status.patch), t(status.done))}
            testID={`family-status-${member.id}`}
          />
        </View>
      </View>
    </Card>
  );
}
