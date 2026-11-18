/**
 * The household's Family Document Vault on the phone (ADR-0054 §9, §13; VLT-10, PR 6): the connection's status in Your
 * data, the badges on a record's files, a page kept only in the vault, and "Open in the vault". Read online and never
 * kept on the device; the words and decisions are in `features/vault`. Changing the connection is on the web.
 */
import { useCallback, useEffect, useState } from 'react';
import { Alert, Linking, View } from 'react-native';
import { useRouter } from 'expo-router';
import type { FileStorageStateDto, VaultConnectionDto } from '@montra/schemas';
import {
  badgeIds,
  DUPLICATE_QUESTION,
  openInVault,
  vaultBadges,
  vaultCard,
  vaultOnlyPage,
  vaultOpenMessage,
  type VaultTone,
} from '../features/vault';
import { fmtDate, t } from '../i18n';
import { useSession } from '../session/SessionProvider';
import { Body, Button, Card, Small, useToast } from './components';
import { useTheme } from './theme';

const useToneColor = () => {
  const th = useTheme();
  return (tone: VaultTone | undefined) =>
    tone === 'good' ? th.success : tone === 'bad' ? th.danger : tone === 'warn' ? th.warning : th.muted;
};

/**
 * Your data → the vault's status (§13), beside the owner's own storage: for owners and admins, read only. Nothing when
 * the plan has no vault and none is connected, or when it can't be read (offline): it never stands in the way.
 */
export function VaultStatusCard() {
  const { state: session, api } = useSession();
  const router = useRouter();
  const color = useToneColor();
  const ws = session.status === 'signed_in' ? session.workspace : null;
  const role = ws?.role ?? 'viewer';
  const wsId = ws?.id ?? '';
  const [loaded, setLoaded] = useState<{ d: VaultConnectionDto | null; plan: boolean } | null>(null);

  useEffect(() => {
    if (!wsId || (role !== 'owner' && role !== 'admin')) return;
    let live = true;
    void Promise.all([
      api.vaultConnection(wsId),
      api.billing(wsId).then(
        (b) => b.mode === 'off' || b.entitlements.features.includes('familyVault'),
        () => false,
      ),
    ]).then(
      ([d, plan]) => live && setLoaded({ d, plan }),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [api, wsId, role]);

  const card = loaded ? vaultCard(loaded.d, role, loaded.plan) : null;
  if (!card) return null;
  return (
    <Card testID="your-data-vault">
      <Small
        color={color(card.tone)}
      >{`${t('vault.title')} · ${t(card.status.key, card.status.values)}`}</Small>
      {card.lines.map((l, i) => (
        <Small key={`${l.key ?? 'text'}-${i}`} color={l.tone ? color(l.tone) : undefined}>
          {l.key ? t(l.key, withDate(l.values)) : (l.text ?? '')}
        </Small>
      ))}
      {card.missing > 0 ? (
        <Button
          kind="secondary"
          label={t('mobile.vault.missing_in_review', { count: card.missing })}
          onPress={() => router.push('/review')}
          testID="your-data-vault-missing"
        />
      ) : null}
      <Small>{t(card.web.key, card.web.values)}</Small>
    </Card>
  );
}

/** A line's date (`YYYY-MM-DD`) in the phone's own format. */
const withDate = (values: Record<string, string | number> | undefined) =>
  typeof values?.date === 'string' ? { ...values, date: fmtDate(values.date) } : values;

/**
 * Where some files are with the vault (§13), for anyone who can see them; empty until loaded, and when they can't be
 * loaded: the badges never stand in the way of the record itself.
 */
export function useFileStorageStates(fileIds: readonly string[]): FileStorageStateDto[] {
  const { state: session, api } = useSession();
  const ws = session.status === 'signed_in' ? session.workspace.id : '';
  const [states, setStates] = useState<FileStorageStateDto[]>([]);
  const key = badgeIds(fileIds).join(',');
  useEffect(() => {
    if (!ws || !key) return;
    let live = true;
    api.fileStorageStates(ws, key.split(',')).then(
      (s) => live && setStates(s),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [api, ws, key]);
  return states;
}

/**
 * §9 "Open in the vault": on the tap, the API makes a single-use link and the phone hands it straight to the system
 * browser. The link lives only inside `openInVault`; what's said afterwards comes from the result, which never holds it.
 */
export function useOpenInVault(): { open: (fileId: string) => Promise<void>; opening: string | null } {
  const { state: session, api } = useSession();
  const toast = useToast();
  const ws = session.status === 'signed_in' ? session.workspace.id : '';
  const [opening, setOpening] = useState<string | null>(null);
  const open = useCallback(
    async (fileId: string) => {
      setOpening(fileId);
      try {
        const result = await openInVault({
          link: () => api.vaultOpenLink(ws, fileId),
          openUrl: (url) => Linking.openURL(url),
        });
        const m = vaultOpenMessage(result);
        if (m) toast.show(t(m.key, m.values));
      } finally {
        setOpening(null);
      }
    },
    [api, ws, toast],
  );
  return { open, opening };
}

/** The badges on one record's files (§13), with "Open in the vault" for each file the vault can open. */
export function VaultBadges({
  fileIds,
  states,
}: {
  fileIds: readonly string[];
  states: readonly FileStorageStateDto[];
}) {
  const th = useTheme();
  const color = useToneColor();
  const { open, opening } = useOpenInVault();
  const b = vaultBadges(states, fileIds);
  if (!b.badges.length) return null;
  return (
    <View style={{ gap: th.space(1) }} testID="vault-badges">
      {b.badges.map((x) => (
        <View key={`${x.key}-${x.detail ?? ''}`}>
          <Small color={color(x.tone)}>{t(x.key)}</Small>
          {x.detail ? <Small>{x.detail}</Small> : null}
        </View>
      ))}
      {b.name ? <Small>{t(b.name.key, b.name.values)}</Small> : null}
      {b.newer ? <Small>{t('vault.newer_version')}</Small> : null}
      {b.openable.map((fileId, i) => (
        <Button
          key={fileId}
          kind="secondary"
          label={b.openable.length > 1 ? t('vault.open_in_vault_n', { n: i + 1 }) : t('vault.open_in_vault')}
          hint={t('mobile.vault.open_hint')}
          busy={opening === fileId}
          disabled={opening !== null}
          onPress={() => void open(fileId)}
          testID="vault-open"
        />
      ))}
    </View>
  );
}

/**
 * §5: a page whose file only the vault holds, in place of the picture Montra can't show (the API would answer 409
 * `file.in_vault`): kept in the vault, with "Open in the vault"; or missing, to upload again in Review.
 */
export function VaultOnlyPage({
  fileId,
  states,
  page,
}: {
  fileId: string;
  states: readonly FileStorageStateDto[];
  page: number;
}) {
  const th = useTheme();
  const { open, opening } = useOpenInVault();
  const only = vaultOnlyPage(states, fileId);
  if (!only) return null;
  return (
    <View
      testID="vault-only-page"
      style={{ gap: th.space(1), padding: th.space(3), borderRadius: th.radius, backgroundColor: th.surface }}
    >
      <Body>{t('mobile.receipts.page_n', { n: page })}</Body>
      <Small>{only.missing ? t('vault.viewer_missing') : t('vault.open_in_vault_only')}</Small>
      {only.canOpen ? (
        <Button
          kind="secondary"
          label={t('vault.open_in_vault')}
          hint={t('mobile.vault.open_hint')}
          busy={opening === fileId}
          disabled={opening !== null}
          onPress={() => void open(fileId)}
          testID="vault-only-open"
        />
      ) : null}
    </View>
  );
}

/**
 * The possible-duplicate question (the owner's clarification, 2026-11-18), as the web asks it before a receipt, payslip
 * or bill is made from an upload that is the bytes of a file Montra already holds: a native dialog, answered as a
 * promise. No leaves the upload unused.
 */
export function askDuplicate(): Promise<boolean> {
  return new Promise((resolve) =>
    Alert.alert(
      t(DUPLICATE_QUESTION.title),
      t(DUPLICATE_QUESTION.body),
      [
        { text: t('common.cancel'), style: 'cancel', onPress: () => resolve(false) },
        { text: t(DUPLICATE_QUESTION.useAnyway), onPress: () => resolve(true) },
      ],
      { cancelable: true, onDismiss: () => resolve(false) },
    ),
  );
}

/** Whether a page is kept only in the vault, so the screen shows `VaultOnlyPage` rather than asking for the picture. */
export const keptOnlyInVault = (states: readonly FileStorageStateDto[], fileId: string): boolean =>
  vaultOnlyPage(states, fileId) !== null;
