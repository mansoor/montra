'use client';

import { useEffect, useId, useState } from 'react';
import type {
  VaultConnectionDto,
  VaultExistingDto,
  VaultItemDto,
  VaultMoveDto,
  WorkspaceDto,
} from '@montra/api-client';
import {
  isSentMode,
  VAULT_COVER_NUMBERS,
  type VaultCoverNumber,
  type VaultGroup,
  type VaultGroupMode,
  type VaultUnkeptChoice,
} from '@montra/schemas';
import { browserApi } from '@/lib/browser-api';
import {
  canManageVault,
  vaultCounts,
  vaultEstimate,
  vaultFeedLine,
  vaultGroupChanges,
  vaultGroupRows,
  vaultMirrorKeeps,
  vaultMoveQuestion,
  vaultOriginalsNote,
  vaultUnmapped,
} from '@/lib/vault';
import { DateText, useI18n } from '../i18n';
import { StatusLine, useAction } from '../use-action';

/**
 * ADR-0054 §6, §12, §13: what the household's Family Document Vault gets, once it is connected. Each group's mode and
 * vault kind ("Send these to the vault"), the counts and any hold for the vault's daily limit, Try again and Send
 * again, sending the documents already in Montra, describing documents in more detail, and pausing.
 *
 * ADR-0057 (VLT-12): each sent group's "Files the vault doesn't keep" (statements can be converted to PDF, with the
 * original attached or not), what that means for the originals of a group sent with no local copy (§7), and "Account
 * number on the cover" beside the detail switch, with the warning before Full (§3).
 */
export function VaultSending({ workspace, d }: { workspace: WorkspaceDto; d: VaultConnectionDto }) {
  const owner = canManageVault(workspace.role);
  return (
    <div className="space-y-5 border-t border-line pt-3" data-testid="vault-sending">
      <VaultGroups workspace={workspace} d={d} />
      <VaultProgress workspace={workspace} d={d} />
      {owner && <SendExisting workspace={workspace} d={d} />}
      {owner && <MoveExisting workspace={workspace} d={d} />}
      {owner && <BringBack workspace={workspace} d={d} />}
      {owner && <VaultOptions workspace={workspace} d={d} />}
    </div>
  );
}

type Draft = {
  group: VaultGroup;
  mode: VaultGroupMode;
  vaultKind: string | null;
  unkept: VaultUnkeptChoice;
}[];

function VaultGroups({ workspace, d }: { workspace: WorkspaceDto; d: VaultConnectionDto }) {
  const { run, busy, message, setMessage, t } = useAction();
  const id = useId();
  const owner = canManageVault(workspace.role);
  const rows = vaultGroupRows(d, workspace.role);
  const fresh = (): Draft =>
    rows.map((r) => ({ group: r.group, mode: r.mode, vaultKind: r.vaultKind, unkept: r.unkept }));
  const [draft, setDraft] = useState<Draft>(fresh);
  // A saved change, or a check that reported other kinds, starts the form again from what is saved.
  useEffect(() => setDraft(fresh()), [d.version, d.vaultKinds.length]);
  const unmapped = vaultUnmapped(d);
  const set = (group: VaultGroup, change: Partial<Draft[number]>) =>
    setDraft((cur) => cur.map((g) => (g.group === group ? { ...g, ...change } : g)));
  const groupName = (g: VaultGroup) => t(`vault.group.${g}`);

  return (
    <form
      className="space-y-2"
      aria-labelledby={`${id}-title`}
      onSubmit={(e) => {
        e.preventDefault();
        const { groups, warn, noCopy } = vaultGroupChanges(d, draft);
        if (!groups.length) return setMessage({ tone: 'good', text: t('vault.groups_unchanged') });
        if (draft.some((g) => isSentMode(g.mode) && !g.vaultKind)) {
          return setMessage({ tone: 'bad', text: t('vault.kind_needed') });
        }
        // §6: payslips and tax documents go only after this warning.
        if (warn.length && !window.confirm(t('vault.restricted_warning'))) return;
        // §5a: Montra removes its own copies of these once the vault has filed them.
        if (noCopy.length && !window.confirm(t('vault.no_copy_warning'))) return;
        void run(
          () => browserApi.updateVaultConnection(workspace.id, { version: d.version, groups }),
          t('vault.groups_saved'),
        ).then(async (saved) => {
          // §5, the owner's "offer to move now": what the vault had already filed of those groups keeps Montra's copy
          // unless the owner says to move it too. Nothing moves without this confirmation.
          if (!saved || !noCopy.length) return;
          const offer = await browserApi.getVaultMove(workspace.id, noCopy).catch(() => null);
          const ask = offer ? vaultMoveQuestion(offer) : null;
          if (!offer || !ask) return;
          if (!window.confirm(t(ask.key, ask.values))) {
            setMessage({ tone: 'good', text: t('vault.move_not_now') });
            return;
          }
          void run(
            () => browserApi.moveToVault(workspace.id, { expected: offer.count, groups: noCopy }),
            t('vault.move_queued', { count: offer.count }),
          );
        });
      }}
    >
      <h3 id={`${id}-title`} className="text-sm font-semibold">
        {t('vault.send_these')}
      </h3>
      <p className="text-xs text-muted">{t('vault.send_these_hint')}</p>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-muted">
              <th className="py-1 pr-3 font-normal">{t('vault.group_heading')}</th>
              <th className="py-1 pr-3 font-normal">{t('vault.mode_heading')}</th>
              <th className="py-1 pr-3 font-normal">{t('vault.kind_heading')}</th>
              <th className="py-1 font-normal">{t('vault.unkept_heading')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const g = draft.find((x) => x.group === r.group)!;
              return (
                <tr key={r.group} className="border-t border-line" data-testid={`vault-group-${r.group}`}>
                  <td className="py-2 pr-3 align-top">
                    {groupName(r.group)}
                    {r.restricted && (
                      <span className="block text-xs text-muted">{t('vault.restricted_note')}</span>
                    )}
                  </td>
                  <td className="py-2 pr-3 align-top">
                    <select
                      className="input"
                      aria-label={t('vault.mode_for', { group: groupName(r.group) })}
                      disabled={!r.editable || busy}
                      value={g.mode}
                      onChange={(e) => set(r.group, { mode: e.target.value as VaultGroupMode })}
                    >
                      {r.modes.map((m) => (
                        <option key={m} value={m}>
                          {t(`vault.mode.${m}`)}
                        </option>
                      ))}
                    </select>
                    {vaultMirrorKeeps(d, r.group, g.mode) && (
                      <span className="mt-1 block text-xs text-muted" data-testid="vault-mirror-keeps">
                        {t('vault.mirror_keeps')}
                      </span>
                    )}
                    {vaultOriginalsNote(g) && (
                      <span className="mt-1 block text-xs text-muted" data-testid="vault-originals-note">
                        {t(vaultOriginalsNote(g)!)}
                      </span>
                    )}
                  </td>
                  <td className="py-2 pr-3 align-top">
                    {isSentMode(g.mode) ? (
                      <select
                        className="input"
                        aria-label={t('vault.kind_for', { group: groupName(r.group) })}
                        disabled={!owner || busy}
                        value={g.vaultKind ?? ''}
                        onChange={(e) => set(r.group, { vaultKind: e.target.value || null })}
                      >
                        <option value="">{t('vault.kind_choose')}</option>
                        {d.vaultKinds.map((k) => (
                          <option key={k.key} value={k.key}>
                            {k.name}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <span className="text-muted">—</span>
                    )}
                  </td>
                  <td className="py-2 align-top">
                    {!isSentMode(g.mode) ? (
                      <span className="text-muted">—</span>
                    ) : r.unkeptChoices.length > 1 ? (
                      <select
                        className="input"
                        aria-label={t('vault.unkept_for', { group: groupName(r.group) })}
                        disabled={busy}
                        value={g.unkept}
                        data-testid={`vault-unkept-${r.group}`}
                        onChange={(e) => set(r.group, { unkept: e.target.value as VaultUnkeptChoice })}
                      >
                        {r.unkeptChoices.map((u) => (
                          <option key={u} value={u}>
                            {t(`vault.unkept.${u}`)}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <span className="text-sm">{t(`vault.unkept.${g.unkept}`)}</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-muted">{t('vault.no_copy_hint')}</p>
      <p className="text-xs text-muted">{t('vault.unkept_hint')}</p>
      {unmapped.length > 0 && (
        <p className="text-sm text-bad" role="note" data-testid="vault-unmapped">
          {t('vault.unmapped', { groups: unmapped.map(groupName).join(', ') })}
        </p>
      )}
      {rows.some((r) => r.editable) && (
        <button type="submit" className="btn-primary" disabled={busy}>
          {t('vault.save_groups')}
        </button>
      )}
      <StatusLine message={message} />
    </form>
  );
}

function VaultProgress({ workspace, d }: { workspace: WorkspaceDto; d: VaultConnectionDto }) {
  const { run, busy, message, setMessage, t } = useAction();
  const [list, setList] = useState<{ status: 'failed' | 'not_kept'; items: VaultItemDto[] } | null>(null);
  const counts = vaultCounts(d);
  const show = async (status: 'failed' | 'not_kept') => {
    try {
      setList({ status, items: await browserApi.listVaultItems(workspace.id, status) });
    } catch {
      setMessage({ tone: 'bad', text: t('vault.list_failed') });
    }
  };
  return (
    <div className="space-y-2" data-testid="vault-progress">
      <h3 className="text-sm font-semibold">{t('vault.progress_title')}</h3>
      {counts.length ? (
        <ul className="flex flex-wrap gap-x-4 gap-y-1 text-sm" data-testid="vault-counts">
          {counts.map((c) => (
            <li key={c.key}>{t(c.key, { n: c.n })}</li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted">{t('vault.nothing_sent')}</p>
      )}
      {d.heldUntil.sending && (
        <p className="text-sm" role="note" data-testid="vault-held">
          {t('vault.held_sending')} <DateText date={d.heldUntil.sending.slice(0, 10)} />
        </p>
      )}
      {d.dailyLimit && (
        <p className="text-xs text-muted">
          {t('vault.daily_limit', { files: d.dailyLimit.files, today: d.dailyLimit.filesToday })}
        </p>
      )}
      <FeedLine d={d} />
      <div className="flex flex-wrap gap-2">
        {d.items.failed > 0 && (
          <button
            type="button"
            className="btn-secondary"
            disabled={busy}
            onClick={() =>
              run(
                () => browserApi.retryVaultItems(workspace.id, {}),
                (r) => t('vault.retried', { n: r.retried }),
              )
            }
          >
            {t('vault.try_again')}
          </button>
        )}
        {d.items.failed > 0 && (
          <button type="button" className="text-sm underline" onClick={() => void show('failed')}>
            {t('vault.show_failed')}
          </button>
        )}
        {d.items.notKept > 0 && (
          <button type="button" className="text-sm underline" onClick={() => void show('not_kept')}>
            {t('vault.show_not_kept')}
          </button>
        )}
      </div>
      {list && (
        <ul className="space-y-1 text-sm" data-testid="vault-items">
          {list.items.length === 0 && <li className="text-muted">{t('vault.list_empty')}</li>}
          {list.items.map((i) => (
            <li key={i.fileId} className="flex flex-wrap items-baseline gap-2">
              <span className="font-medium">{i.fileName ?? t('vault.file_gone')}</span>
              <span className="text-muted">{i.notKeptReason ?? i.lastError ?? ''}</span>
              {i.status === 'not_kept' && i.resendAllowed && (
                <button
                  type="button"
                  className="underline"
                  disabled={busy}
                  onClick={() =>
                    run(
                      () => browserApi.retryVaultItems(workspace.id, { fileIds: [i.fileId] }),
                      t('vault.sent_again'),
                    ).then((r) => {
                      if (r) setList(null);
                    })
                  }
                >
                  {t('vault.send_again')}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      <StatusLine message={message} />
    </div>
  );
}

/** §9: when Montra last read what the vault did with its documents. */
function FeedLine({ d }: { d: VaultConnectionDto }) {
  const { t } = useI18n();
  const line = vaultFeedLine(d);
  return (
    <p className="text-xs text-muted" data-testid="vault-feed">
      {t(line.key)} {line.at && <DateText date={line.at.slice(0, 10)} />}
    </p>
  );
}

function SendExisting({ workspace, d }: { workspace: WorkspaceDto; d: VaultConnectionDto }) {
  const { run, busy, message, t } = useAction();
  const [existing, setExisting] = useState<VaultExistingDto | null>(null);
  if (d.stage !== 'connected') return null;
  const estimate = existing ? vaultEstimate(existing) : null;
  return (
    <div className="space-y-2" data-testid="vault-existing">
      <h3 className="text-sm font-semibold">{t('vault.existing_title')}</h3>
      {!existing || !estimate ? (
        <button
          type="button"
          className="btn-secondary"
          disabled={busy}
          onClick={() =>
            void run(() => browserApi.getVaultExisting(workspace.id)).then((e) => {
              if (e) setExisting(e);
            })
          }
        >
          {t('vault.existing_look')}
        </button>
      ) : (
        <>
          <p className="text-sm" data-testid="vault-existing-count">
            {t(estimate.key, estimate.values)}
          </p>
          {existing.count > 0 && (
            <>
              <p className="text-xs text-muted">{t('vault.existing_allowance')}</p>
              <button
                type="button"
                className="btn-primary"
                disabled={busy}
                onClick={() =>
                  void run(
                    () => browserApi.sendExistingToVault(workspace.id, { expected: existing.count }),
                    t('vault.existing_queued', { count: existing.count }),
                  ).then((r) => {
                    if (r) setExisting(r);
                  })
                }
              >
                {t('vault.existing_send', { count: existing.count })}
              </button>
            </>
          )}
        </>
      )}
      <StatusLine message={message} />
    </div>
  );
}

/** §5, §12 "Move existing documents": filed files of groups sent with no local copy that still have Montra's copy. */
function MoveExisting({ workspace, d }: { workspace: WorkspaceDto; d: VaultConnectionDto }) {
  const { run, busy, message, t } = useAction();
  const [move, setMove] = useState<VaultMoveDto | null>(null);
  if (d.stage !== 'connected' || d.bringingBack || !d.groups.some((g) => g.mode === 'sent_no_copy'))
    return null;
  return (
    <div className="space-y-2" data-testid="vault-move">
      <h3 className="text-sm font-semibold">{t('vault.move_title')}</h3>
      {!move ? (
        <button
          type="button"
          className="btn-secondary"
          disabled={busy}
          onClick={() =>
            void run(() => browserApi.getVaultMove(workspace.id)).then((m) => {
              if (m) setMove(m);
            })
          }
        >
          {t('vault.move_look')}
        </button>
      ) : move.count === 0 ? (
        <p className="text-sm" data-testid="vault-move-count">
          {t('vault.move_none')}
        </p>
      ) : (
        <>
          <p className="text-sm" data-testid="vault-move-count">
            {t('vault.move_count', { count: move.count })}
          </p>
          <p className="text-xs text-muted">{t('vault.move_hint')}</p>
          <button
            type="button"
            className="btn-primary"
            disabled={busy}
            onClick={() =>
              void run(
                () => browserApi.moveToVault(workspace.id, { expected: move.count }),
                t('vault.move_queued', { count: move.count }),
              ).then((r) => {
                if (r) setMove(r);
              })
            }
          >
            {t('vault.move_send', { count: move.count })}
          </button>
        </>
      )}
      <StatusLine message={message} />
    </div>
  );
}

/** §10 "Bring the files back", staying connected: every file kept only in the vault copied back into Montra. */
function BringBack({ workspace, d }: { workspace: WorkspaceDto; d: VaultConnectionDto }) {
  const { run, busy, message, t } = useAction();
  const left = d.files.onlyInVault - d.files.missing;
  if (d.stage !== 'connected' || d.bringingBack || left <= 0) return null;
  return (
    <div className="space-y-2" data-testid="vault-bring-back">
      <button
        type="button"
        className="btn-secondary"
        disabled={busy}
        onClick={() => {
          if (window.confirm(t('vault.bring_back_confirm', { count: left }))) {
            void run(
              () => browserApi.bringBackFromVault(workspace.id),
              (r) => t('vault.bring_back_started', { count: r.queued }),
            );
          }
        }}
      >
        {t('vault.bring_back')}
      </button>
      <StatusLine message={message} />
    </div>
  );
}

function VaultOptions({ workspace, d }: { workspace: WorkspaceDto; d: VaultConnectionDto }) {
  const { run, busy, message, t } = useAction();
  const id = useId();
  return (
    <div className="space-y-2">
      <div className="flex items-start gap-2">
        <input
          id={`${id}-more`}
          type="checkbox"
          className="mt-1"
          checked={d.describeMore}
          disabled={busy}
          onChange={(e) =>
            void run(() =>
              browserApi.updateVaultConnection(workspace.id, {
                version: d.version,
                describeMore: e.target.checked,
              }),
            )
          }
        />
        <label htmlFor={`${id}-more`} className="text-sm">
          {t('vault.describe_more')}
          <span className="block text-xs text-muted">{t('vault.describe_more_hint')}</span>
        </label>
      </div>
      <div className="space-y-1 pl-6">
        <label htmlFor={`${id}-cover`} className="block text-sm">
          {t('vault.cover_number')}
        </label>
        <select
          id={`${id}-cover`}
          className="input"
          value={d.coverNumber}
          disabled={busy}
          data-testid="vault-cover-number"
          onChange={(e) => {
            const coverNumber = e.target.value as VaultCoverNumber;
            // ADR-0057 §3: the full number goes to the vault, where the vault decides who sees it.
            if (coverNumber === 'full' && !window.confirm(t('vault.cover_full_warning'))) return;
            void run(() =>
              browserApi.updateVaultConnection(workspace.id, { version: d.version, coverNumber }),
            );
          }}
        >
          {VAULT_COVER_NUMBERS.map((n) => (
            <option key={n} value={n}>
              {t(`vault.cover.${n}`)}
            </option>
          ))}
        </select>
        <span className="block text-xs text-muted">
          {d.describeMore ? t('vault.cover_number_hint') : t('vault.cover_number_off')}
        </span>
      </div>
      <div className="flex items-start gap-2">
        <input
          id={`${id}-delete`}
          type="checkbox"
          className="mt-1"
          checked={d.deleteWithMontra}
          // §10, D10: off by default; offered only when the vault lets Montra delete what it sent.
          disabled={busy || (!d.canDelete && !d.deleteWithMontra)}
          data-testid="vault-delete-with-montra"
          onChange={(e) =>
            void run(() =>
              browserApi.updateVaultConnection(workspace.id, {
                version: d.version,
                deleteWithMontra: e.target.checked,
              }),
            )
          }
        />
        <label htmlFor={`${id}-delete`} className="text-sm">
          {t('vault.delete_with_montra')}
          <span className="block text-xs text-muted">
            {d.canDelete ? t('vault.delete_with_montra_hint') : t('vault.delete_not_allowed')}
          </span>
        </label>
      </div>
      <button
        type="button"
        className="btn-secondary"
        disabled={busy}
        onClick={() =>
          void run(
            () =>
              browserApi.updateVaultConnection(workspace.id, {
                version: d.version,
                paused: d.status !== 'paused',
              }),
            d.status === 'paused' ? t('vault.resumed') : t('vault.paused'),
          )
        }
      >
        {d.status === 'paused' ? t('vault.resume') : t('vault.pause')}
      </button>
      <StatusLine message={message} />
    </div>
  );
}
