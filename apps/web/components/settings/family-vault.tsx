'use client';

import { useId, useState } from 'react';
import type { VaultConnectionDto, WorkspaceDto } from '@montra/api-client';
import { browserApi } from '@/lib/browser-api';
import {
  canManageVault,
  cleanPastedCode,
  clockIsOff,
  vaultDisconnectChoice,
  vaultHost,
  vaultStatusLine,
  vaultStep,
  vaultTone,
} from '@/lib/vault';
import { DateText } from '../i18n';
import { StatusLine, useAction } from '../use-action';
import { VaultSending } from './family-vault-sending';

/**
 * ADR-0054 §2, §13: the household's Family Document Vault, beside "Your own storage". Connecting in three steps (the
 * key Montra made, what to do in the vault, the code), waiting for approval, replacing the key and disconnecting; once
 * connected, what each group does and how sending is going (`VaultSending`).
 */
export function FamilyVaultCard({
  workspace,
  connection,
}: {
  workspace: WorkspaceDto;
  connection: VaultConnectionDto | null;
}) {
  const { t } = useAction();
  const owner = canManageVault(workspace.role);
  const step = vaultStep(connection);
  return (
    <section className="card space-y-4" aria-labelledby="vault-title" data-testid="vault-card">
      <div className="space-y-1">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <h2 id="vault-title" className="text-base font-semibold">
            {t('vault.title')}
          </h2>
          {connection && <StatusChip d={connection} />}
        </div>
        <p className="text-sm text-muted">{t('vault.intro')}</p>
      </div>
      {step === 'start' && <Start workspace={workspace} owner={owner} />}
      {connection && step === 'register' && <Register workspace={workspace} d={connection} owner={owner} />}
      {connection && (step === 'approval' || step === 'connected') && (
        <Connected workspace={workspace} d={connection} owner={owner} />
      )}
      {connection && step === 'disconnected' && (
        <Disconnected workspace={workspace} d={connection} owner={owner} />
      )}
    </section>
  );
}

function StatusChip({ d }: { d: VaultConnectionDto }) {
  const { t } = useAction();
  const line = vaultStatusLine(d);
  const tone = vaultTone(d);
  const cls = tone === 'good' ? 'text-good' : tone === 'bad' ? 'text-bad' : 'text-muted';
  return (
    <span className={`chip ${cls}`} data-testid="vault-status">
      {t(line.key, line.values)}
    </span>
  );
}

function Start({ workspace, owner }: { workspace: WorkspaceDto; owner: boolean }) {
  const { run, busy, message, t } = useAction();
  if (!owner) return <p className="text-sm">{t('vault.owner_connects')}</p>;
  return (
    <div className="space-y-2">
      <button
        type="button"
        className="btn-primary"
        disabled={busy}
        onClick={() => run(() => browserApi.startVaultConnection(workspace.id))}
      >
        {t('vault.connect')}
      </button>
      <StatusLine message={message} />
    </div>
  );
}

/** A public key and its fingerprint, with Copy. Not secret: shown so the owner can compare them with the vault. */
function PublicKey({ publicKey, fingerprint }: { publicKey: string; fingerprint: string }) {
  const { t } = useAction();
  const id = useId();
  const [copied, setCopied] = useState(false);
  return (
    <div className="space-y-1">
      <label htmlFor={`${id}-key`} className="field-label">
        {t('vault.public_key')}
      </label>
      <div className="flex gap-2">
        <input
          id={`${id}-key`}
          className="input w-full font-mono text-xs"
          readOnly
          value={publicKey}
          data-testid="vault-public-key"
          onFocus={(e) => e.target.select()}
        />
        <button
          type="button"
          className="btn-secondary"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(publicKey);
              setCopied(true);
            } catch {
              setCopied(false);
            }
          }}
        >
          {copied ? t('common.copied') : t('common.copy')}
        </button>
      </div>
      <p className="text-xs text-muted">
        {t('vault.fingerprint')} <span className="font-mono">{fingerprint}</span>
      </p>
    </div>
  );
}

/** Step 3, and the end of a key change: the code the vault gave. */
function PasteCode({ workspace, d }: { workspace: WorkspaceDto; d: VaultConnectionDto }) {
  const { run, busy, message, setMessage, t } = useAction();
  const id = useId();
  const [code, setCode] = useState('');
  return (
    <form
      className="space-y-2"
      aria-label={t('vault.paste_code')}
      onSubmit={(e) => {
        e.preventDefault();
        const clean = cleanPastedCode(code);
        if (!clean) return setMessage({ tone: 'bad', text: t('vault.code_needed') });
        void run(
          () => browserApi.pasteVaultCode(workspace.id, { code: clean, version: d.version }),
          (r) =>
            r.stage === 'connected'
              ? t('vault.connected_now', { name: r.householdName ?? '' })
              : t('vault.waiting_now', { name: r.householdName ?? '' }),
        ).then((r) => {
          if (r) setCode('');
        });
      }}
    >
      <label htmlFor={`${id}-code`} className="field-label">
        {t('vault.paste_code')}
      </label>
      <textarea
        id={`${id}-code`}
        className="input w-full font-mono text-xs"
        rows={3}
        autoComplete="off"
        spellCheck={false}
        value={code}
        onChange={(e) => setCode(e.target.value)}
      />
      <button type="submit" className="btn-primary" disabled={busy}>
        {t('vault.use_code')}
      </button>
      <StatusLine message={message} />
    </form>
  );
}

function Register({
  workspace,
  d,
  owner,
}: {
  workspace: WorkspaceDto;
  d: VaultConnectionDto;
  owner: boolean;
}) {
  const { run, busy, message, t } = useAction();
  if (!owner) return <p className="text-sm">{t('vault.owner_connects')}</p>;
  return (
    <div className="space-y-4">
      <ol className="list-decimal space-y-3 pl-5 text-sm">
        <li className="space-y-2">
          <p>{t('vault.step_key')}</p>
          <PublicKey publicKey={d.publicKey} fingerprint={d.fingerprint} />
        </li>
        <li className="space-y-1">
          <p>{t('vault.step_register')}</p>
          <p className="text-xs text-muted">{t('vault.step_register_addresses')}</p>
        </li>
        <li>
          <p>{t('vault.step_code')}</p>
        </li>
      </ol>
      <PasteCode workspace={workspace} d={d} />
      <div>
        <button
          type="button"
          className="text-sm underline"
          disabled={busy}
          onClick={() => run(() => browserApi.disconnectVault(workspace.id), t('vault.cancelled'))}
        >
          {t('vault.cancel_connecting')}
        </button>
        <StatusLine message={message} />
      </div>
    </div>
  );
}

function Connected({
  workspace,
  d,
  owner,
}: {
  workspace: WorkspaceDto;
  d: VaultConnectionDto;
  owner: boolean;
}) {
  const { run, busy, message, t } = useAction();
  const [choosing, setChoosing] = useState(false);
  return (
    <div className="space-y-4">
      <dl className="grid gap-2 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-xs text-muted">{t('vault.where')}</dt>
          <dd data-testid="vault-where">
            {d.householdName ?? '—'} · {vaultHost(d.address)}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted">{t('vault.acting_as')}</dt>
          <dd>{d.actingAs ?? '—'}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted">{t('vault.fingerprint')}</dt>
          <dd className="font-mono text-xs">{d.fingerprint}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted">{t('vault.last_check')}</dt>
          <dd>{d.lastSuccessAt ? <DateText date={d.lastSuccessAt.slice(0, 10)} /> : t('storage.never')}</dd>
        </div>
      </dl>
      {d.stage === 'approval' && (
        <p className="text-sm" role="note">
          {t('vault.approval_hint')}
        </p>
      )}
      {d.lastError && (
        <p className="text-sm text-bad" role="note" data-testid="vault-error">
          {d.lastError}
        </p>
      )}
      {clockIsOff(d.clockOffsetMs) && (
        <p className="text-sm text-bad" role="note">
          {t('vault.clock_off')}
        </p>
      )}
      {d.vaultKinds.length > 0 && (
        <p className="text-sm">
          {t('vault.kinds_allowed')} {d.vaultKinds.map((k) => k.name).join(', ')}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className="btn-secondary"
          disabled={busy}
          onClick={() => run(() => browserApi.checkVaultConnection(workspace.id))}
        >
          {t('vault.check_again')}
        </button>
        {owner && !d.newKey && (
          <button
            type="button"
            className="btn-secondary"
            disabled={busy}
            onClick={() => {
              if (window.confirm(t('vault.confirm_replace_key'))) {
                void run(() => browserApi.replaceVaultKey(workspace.id, { version: d.version }));
              }
            }}
          >
            {t('vault.replace_key')}
          </button>
        )}
        {owner && vaultDisconnectChoice(d) === 'confirm' && (
          <button
            type="button"
            className="btn-secondary"
            disabled={busy}
            onClick={() => {
              if (
                window.confirm(t('vault.confirm_disconnect', { name: d.householdName ?? t('vault.title') }))
              ) {
                void run(() => browserApi.disconnectVault(workspace.id), t('vault.disconnected'));
              }
            }}
          >
            {t('vault.disconnect')}
          </button>
        )}
        {owner && vaultDisconnectChoice(d) === 'choose' && !choosing && (
          <button type="button" className="btn-secondary" disabled={busy} onClick={() => setChoosing(true)}>
            {t('vault.disconnect')}
          </button>
        )}
      </div>
      {d.bringingBack && (
        <p className="text-sm" role="note" data-testid="vault-bringing-back">
          {t('vault.bringing_back_note')}{' '}
          {d.bringingBack.then === 'disconnect' && t('vault.bringing_back_then_disconnect')}
        </p>
      )}
      {owner && choosing && vaultDisconnectChoice(d) === 'choose' && (
        <div className="space-y-2 rounded-md border border-line p-3" data-testid="vault-disconnect-choice">
          <p className="text-sm">{t('vault.disconnect_choice', { count: d.files.onlyInVault })}</p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="btn-primary"
              disabled={busy}
              onClick={() =>
                void run(
                  () => browserApi.disconnectVault(workspace.id, { bringBack: true }),
                  t('vault.disconnect_bringing'),
                ).then(() => setChoosing(false))
              }
            >
              {t('vault.disconnect_bring_back')}
            </button>
            <button
              type="button"
              className="btn-secondary"
              disabled={busy}
              onClick={() => {
                if (window.confirm(t('vault.confirm_disconnect_anyway', { count: d.files.onlyInVault }))) {
                  void run(
                    () => browserApi.disconnectVault(workspace.id, { anyway: true }),
                    t('vault.disconnected'),
                  ).then(() => setChoosing(false));
                }
              }}
            >
              {t('vault.disconnect_anyway')}
            </button>
            <button type="button" className="text-sm underline" onClick={() => setChoosing(false)}>
              {t('common.cancel')}
            </button>
          </div>
        </div>
      )}
      <StatusLine message={message} />
      {d.stage === 'connected' && <VaultSending workspace={workspace} d={d} />}
      {owner && d.newKey && (
        <div className="space-y-3 border-t border-line pt-3" data-testid="vault-new-key">
          <h3 className="text-sm font-semibold">{t('vault.new_key_title')}</h3>
          <p className="text-sm">{t('vault.new_key_steps')}</p>
          <PublicKey publicKey={d.newKey.publicKey} fingerprint={d.newKey.fingerprint} />
          <PasteCode workspace={workspace} d={d} />
          <button
            type="button"
            className="text-sm underline"
            disabled={busy}
            onClick={() =>
              run(() => browserApi.replaceVaultKey(workspace.id, { version: d.version, cancel: true }))
            }
          >
            {t('vault.cancel_new_key')}
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * §10: disconnected while files were kept only in the vault. Nothing is sent and the key is gone; those files are in
 * Review's "Files to provide again". Connecting the same vault again reads them back; the connection can be removed
 * once none is left.
 */
function Disconnected({
  workspace,
  d,
  owner,
}: {
  workspace: WorkspaceDto;
  d: VaultConnectionDto;
  owner: boolean;
}) {
  const { run, busy, message, t } = useAction();
  return (
    <div className="space-y-3" data-testid="vault-disconnected">
      <p className="text-sm">
        {t('vault.disconnected_note', {
          name: d.householdName ?? t('vault.title'),
          count: d.files.onlyInVault,
        })}
      </p>
      {d.files.missing > 0 && (
        <a className="text-sm underline" href={`/w/${workspace.id}/review#files-to-provide`}>
          {t('data.missing_files_link')}
        </a>
      )}
      {owner ? (
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className="btn-primary"
            disabled={busy}
            onClick={() => run(() => browserApi.startVaultConnection(workspace.id))}
          >
            {t('vault.connect_again')}
          </button>
          {d.files.onlyInVault === 0 && (
            <button
              type="button"
              className="btn-secondary"
              disabled={busy}
              onClick={() => run(() => browserApi.disconnectVault(workspace.id), t('vault.disconnected'))}
            >
              {t('vault.remove_connection')}
            </button>
          )}
        </div>
      ) : (
        <p className="text-sm">{t('vault.owner_connects')}</p>
      )}
      <StatusLine message={message} />
    </div>
  );
}
