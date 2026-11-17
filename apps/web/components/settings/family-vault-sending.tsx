'use client';

import { useEffect, useId, useState } from 'react';
import type { VaultConnectionDto, VaultExistingDto, VaultItemDto, WorkspaceDto } from '@montra/api-client';
import { isSentMode, type VaultGroup, type VaultGroupMode } from '@montra/schemas';
import { browserApi } from '@/lib/browser-api';
import {
  canManageVault,
  vaultCounts,
  vaultEstimate,
  vaultGroupChanges,
  vaultGroupRows,
  vaultUnmapped,
} from '@/lib/vault';
import { DateText } from '../i18n';
import { StatusLine, useAction } from '../use-action';

/**
 * ADR-0054 §6, §12, §13: what the household's Family Document Vault gets, once it is connected. Each group's mode and
 * vault kind ("Send these to the vault"), the counts and any hold for the vault's daily limit, Try again and Send
 * again, sending the documents already in Montra, describing documents in more detail, and pausing.
 */
export function VaultSending({ workspace, d }: { workspace: WorkspaceDto; d: VaultConnectionDto }) {
  const owner = canManageVault(workspace.role);
  return (
    <div className="space-y-5 border-t border-line pt-3" data-testid="vault-sending">
      <VaultGroups workspace={workspace} d={d} />
      <VaultProgress workspace={workspace} d={d} />
      {owner && <SendExisting workspace={workspace} d={d} />}
      {owner && <VaultOptions workspace={workspace} d={d} />}
    </div>
  );
}

type Draft = { group: VaultGroup; mode: VaultGroupMode; vaultKind: string | null }[];

function VaultGroups({ workspace, d }: { workspace: WorkspaceDto; d: VaultConnectionDto }) {
  const { run, busy, message, setMessage, t } = useAction();
  const id = useId();
  const owner = canManageVault(workspace.role);
  const rows = vaultGroupRows(d, workspace.role);
  const fresh = (): Draft => rows.map((r) => ({ group: r.group, mode: r.mode, vaultKind: r.vaultKind }));
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
        const { groups, warn } = vaultGroupChanges(d, draft);
        if (!groups.length) return setMessage({ tone: 'good', text: t('vault.groups_unchanged') });
        if (draft.some((g) => isSentMode(g.mode) && !g.vaultKind)) {
          return setMessage({ tone: 'bad', text: t('vault.kind_needed') });
        }
        // §6: payslips and tax documents go only after this warning.
        if (warn.length && !window.confirm(t('vault.restricted_warning'))) return;
        void run(
          () => browserApi.updateVaultConnection(workspace.id, { version: d.version, groups }),
          t('vault.groups_saved'),
        );
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
              <th className="py-1 font-normal">{t('vault.kind_heading')}</th>
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
                  </td>
                  <td className="py-2 align-top">
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
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-muted">{t('vault.no_copy_later')}</p>
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
