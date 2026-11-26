'use client';

import { useId, useState } from 'react';
import type { VaultConnectionDto, WorkspaceDto } from '@montra/api-client';
import { browserApi } from '@/lib/browser-api';
import {
  canManageVault,
  vaultActsAsLine,
  vaultConnectInput,
  vaultDisconnectChoice,
  vaultHost,
  vaultKeyLine,
  vaultKeyPermissions,
  vaultReplaceInput,
  vaultStatusLine,
  vaultStep,
  vaultTone,
} from '@/lib/vault';
import { DateText } from '../i18n';
import { StatusLine, useAction } from '../use-action';
import { useConfirm } from '../ui/confirm-dialog';
import { VaultSending } from './family-vault-sending';

/**
 * ADR-0054 §2, §13: the household's Family Document Vault, beside "Your own storage". An owner connects with the API
 * key the vault generates for Montra (its connection string, and its secret when the string doesn't include it);
 * waiting for approval, the key's state, whom Montra acts as, replacing the key and disconnecting; once connected, what
 * each group does and how sending is going (`VaultSending`).
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

/** What to do in the vault to get a key for Montra. */
function KeySteps() {
  const { t } = useAction();
  return (
    <ol className="list-decimal space-y-2 pl-5 text-sm">
      <li className="space-y-1">
        <p>{t('vault.step_generate')}</p>
        <p className="text-xs text-muted">{t('vault.step_register_addresses')}</p>
      </li>
      <li>
        <p>{t('vault.step_paste')}</p>
      </li>
    </ol>
  );
}

/**
 * The connection string the vault showed with Montra's key, and its secret when the string doesn't include it. The
 * secret is a password field and is never shown back: once sent, Montra seals it and the web never sees it again.
 */
function KeyForm({
  label,
  submit,
  onSend,
  done,
  onDone,
}: {
  label: string;
  submit: string;
  onSend: (text: string, secret: string) => Promise<VaultConnectionDto> | null;
  done: (r: VaultConnectionDto) => string;
  /** Called once it worked, with the words to say: for a form that closes then. */
  onDone?: (words: string) => void;
}) {
  const { run, busy, message, setMessage, t } = useAction();
  const id = useId();
  const [text, setText] = useState('');
  const [secret, setSecret] = useState('');
  return (
    <form
      className="space-y-2"
      aria-label={label}
      autoComplete="off"
      onSubmit={(e) => {
        e.preventDefault();
        const sending = onSend(text, secret);
        if (!sending) return setMessage({ tone: 'bad', text: t('vault.key_needed') });
        void run(() => sending, done).then((r) => {
          // Nothing pasted stays in the page once it is used.
          if (r) {
            setText('');
            setSecret('');
            onDone?.(done(r));
          }
        });
      }}
    >
      <label htmlFor={`${id}-code`} className="field-label">
        {label}
      </label>
      <textarea
        id={`${id}-code`}
        className="input w-full font-mono text-xs"
        rows={3}
        autoComplete="off"
        spellCheck={false}
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <label htmlFor={`${id}-secret`} className="field-label">
        {t('vault.secret_label')}
      </label>
      <input
        id={`${id}-secret`}
        className="input w-full font-mono text-xs"
        type="password"
        autoComplete="off"
        spellCheck={false}
        value={secret}
        onChange={(e) => setSecret(e.target.value)}
      />
      <p className="text-xs text-muted">{t('vault.secret_hint')}</p>
      <button type="submit" className="btn-primary" disabled={busy}>
        {submit}
      </button>
      <StatusLine message={message} />
    </form>
  );
}

/** Connecting, or connecting a kept connection again (`version`). */
function ConnectForm({ workspace, version }: { workspace: WorkspaceDto; version?: number }) {
  const { t } = useAction();
  return (
    <KeyForm
      label={t('vault.paste_code')}
      submit={t('vault.use_code')}
      onSend={(text, secret) => {
        const input = vaultConnectInput(text, secret, version);
        return input ? browserApi.connectVault(workspace.id, input) : null;
      }}
      done={(r) =>
        r.stage === 'connected'
          ? t('vault.connected_now', { name: r.householdName ?? '' })
          : t('vault.waiting_now', { name: r.householdName ?? '' })
      }
    />
  );
}

/** "Replace the key": a new key the owner generated in the vault, checked before Montra switches to it. */
function ReplaceKeyForm({
  workspace,
  d,
  onDone,
}: {
  workspace: WorkspaceDto;
  d: VaultConnectionDto;
  onDone: (words: string) => void;
}) {
  const { t } = useAction();
  return (
    <KeyForm
      label={t('vault.new_key_label')}
      submit={t('vault.use_new_key')}
      onSend={(text, secret) => {
        const input = vaultReplaceInput(text, secret, d.version);
        return input ? browserApi.replaceVaultKey(workspace.id, input) : null;
      }}
      done={() => t('vault.key_replaced')}
      onDone={onDone}
    />
  );
}

function Start({ workspace, owner }: { workspace: WorkspaceDto; owner: boolean }) {
  const { t } = useAction();
  const [open, setOpen] = useState(false);
  if (!owner) return <p className="text-sm">{t('vault.owner_connects')}</p>;
  if (!open) {
    return (
      <button type="button" className="btn-primary" onClick={() => setOpen(true)}>
        {t('vault.connect')}
      </button>
    );
  }
  return (
    <div className="space-y-4" data-testid="vault-connect">
      <KeySteps />
      <ConnectForm workspace={workspace} />
    </div>
  );
}

/**
 * A connection begun before the vault's API keys, never given its code (Montra made a key pair then): it needs a key,
 * pasted as when connecting, and keeps its groups.
 */
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
  return (
    <div className="space-y-4">
      <KeyProblem d={d} />
      {owner ? (
        <>
          <KeySteps />
          <ConnectForm workspace={workspace} version={d.version} />
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
        </>
      ) : (
        <p className="text-sm">{t('vault.owner_connects')}</p>
      )}
    </div>
  );
}

/** Why the key needs replacing, or when it expires, in words (API keys). */
function KeyProblem({ d }: { d: VaultConnectionDto }) {
  const { t } = useAction();
  const line = vaultKeyLine(d);
  if (!line || line.tone === 'muted') return null;
  return (
    <p
      className={`text-sm ${line.tone === 'bad' ? 'text-bad' : 'text-warn'}`}
      role="note"
      data-testid="vault-key-problem"
    >
      {t(line.key, line.values)}
    </p>
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
  const { run, busy, message, setMessage, t } = useAction();
  const { confirm, dialog } = useConfirm();
  const [choosing, setChoosing] = useState(false);
  const [replacing, setReplacing] = useState(false);
  const actsAs = vaultActsAsLine(d);
  const keyLine = vaultKeyLine(d);
  const permissions = vaultKeyPermissions(d);
  // A key that no longer works is replaced straight away; a working one when the owner asks.
  const showReplace = owner && (replacing || d.keyProblem !== null);
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
          <dd data-testid="vault-acts-as">{actsAs ? t(actsAs.key, actsAs.values) : '—'}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted">{t('vault.key')}</dt>
          <dd data-testid="vault-key">
            {d.key?.name ?? t('vault.key_unnamed')}
            {keyLine && keyLine.tone === 'muted' && (
              <span className="block text-xs text-muted">{t(keyLine.key, keyLine.values)}</span>
            )}
            {permissions.length > 0 && (
              <span className="block text-xs text-muted">
                {t('vault.key_may')} {permissions.map((p) => t(p)).join(', ')}
              </span>
            )}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted">{t('vault.last_check')}</dt>
          <dd>{d.lastSuccessAt ? <DateText date={d.lastSuccessAt.slice(0, 10)} /> : t('storage.never')}</dd>
        </div>
      </dl>
      <KeyProblem d={d} />
      {d.stage === 'approval' && (
        <p className="text-sm" role="note">
          {t('vault.approval_hint')}
        </p>
      )}
      {d.lastError && !d.keyProblem && (
        <p className="text-sm text-bad" role="note" data-testid="vault-error">
          {d.lastError}
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
        {owner && !showReplace && (
          <button type="button" className="btn-secondary" onClick={() => setReplacing(true)}>
            {t('vault.replace_key')}
          </button>
        )}
        {owner && vaultDisconnectChoice(d) === 'confirm' && (
          <button
            type="button"
            className="btn-secondary"
            disabled={busy}
            onClick={async () => {
              const ok = await confirm({
                title: t('vault.disconnect_title'),
                body: <p>{t('vault.confirm_disconnect', { name: d.householdName ?? t('vault.title') })}</p>,
                confirmLabel: t('vault.disconnect'),
                danger: true,
              });
              if (ok) {
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
              onClick={async () => {
                const ok = await confirm({
                  title: t('vault.disconnect_anyway_title'),
                  body: <p>{t('vault.confirm_disconnect_anyway', { count: d.files.onlyInVault })}</p>,
                  confirmLabel: t('vault.disconnect_anyway'),
                  danger: true,
                });
                if (ok) {
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
      {showReplace && (
        <div className="space-y-3 border-t border-line pt-3" data-testid="vault-new-key">
          <h3 className="text-sm font-semibold">{t('vault.new_key_title')}</h3>
          <p className="text-sm">{t('vault.new_key_steps')}</p>
          <ReplaceKeyForm
            workspace={workspace}
            d={d}
            onDone={(words) => {
              setReplacing(false);
              setMessage({ tone: 'good', text: words });
            }}
          />
          {replacing && !d.keyProblem && (
            <button type="button" className="text-sm underline" onClick={() => setReplacing(false)}>
              {t('vault.cancel_new_key')}
            </button>
          )}
        </div>
      )}
      {d.stage === 'connected' && <VaultSending workspace={workspace} d={d} />}
      {dialog}
    </div>
  );
}

/**
 * §10: disconnected while files were kept only in the vault. Nothing is sent and the key is gone; those files are in
 * Review's "Files to provide again". Connecting the same vault again (with a new key) reads them back; the connection
 * can be removed once none is left.
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
  const [again, setAgain] = useState(false);
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
        <>
          <div className="flex flex-wrap gap-2">
            {!again && (
              <button type="button" className="btn-primary" onClick={() => setAgain(true)}>
                {t('vault.connect_again')}
              </button>
            )}
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
          {again && (
            <div className="space-y-4">
              <KeySteps />
              <ConnectForm workspace={workspace} version={d.version} />
            </div>
          )}
        </>
      ) : (
        <p className="text-sm">{t('vault.owner_connects')}</p>
      )}
      <StatusLine message={message} />
    </div>
  );
}
