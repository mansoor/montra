'use client';

import { useId, useState } from 'react';
import type { AccountDto, BankFeedAccountDto, BankFeedDto, WorkspaceDto } from '@montra/api-client';
import { browserApi } from '@/lib/browser-api';
import {
  bankFeedStatus,
  canManageBankFeeds,
  guessKind,
  linkTargets,
  setupTokenInput,
} from '@/lib/bank-feeds';
import { DateText, useI18n } from '../i18n';
import { StatusLine, useAction } from '../use-action';

type Target = Pick<AccountDto, 'id' | 'name' | 'kind' | 'currency' | 'archived'>;

/**
 * Bank feeds (ADR-0055 §3, §4): connect SimpleFIN Bridge with a setup token, then link each account it reports to a
 * Montra account, create one, or ignore it. Owners change it; admins and partners see it.
 */
export function BankFeedsCard({
  workspace,
  feed,
  accounts,
}: {
  workspace: WorkspaceDto;
  feed: BankFeedDto | null;
  accounts: Target[];
}) {
  const { t } = useI18n();
  const owner = canManageBankFeeds(workspace.role);
  return (
    <section className="card space-y-4" aria-labelledby="bank-feeds-title" data-testid="bank-feeds-card">
      <div className="space-y-1">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <h2 id="bank-feeds-title" className="text-base font-semibold">
            {t('bank_feeds.title')}
          </h2>
          {feed && <StatusChip feed={feed} />}
        </div>
        <p className="text-sm text-muted">{t('bank_feeds.intro')}</p>
      </div>
      {!feed ? (
        <Start workspace={workspace} owner={owner} />
      ) : (
        <Connected workspace={workspace} feed={feed} accounts={accounts} owner={owner} />
      )}
    </section>
  );
}

function StatusChip({ feed }: { feed: BankFeedDto }) {
  const { t } = useI18n();
  const s = bankFeedStatus(feed);
  const cls = s.tone === 'good' ? 'text-good' : s.tone === 'bad' ? 'text-bad' : 'text-muted';
  return (
    <span className={`chip ${cls}`} data-testid="bank-feeds-status">
      {t(s.key)}
    </span>
  );
}

/** §3: the steps at SimpleFIN Bridge, then the setup token. The token is never shown back or kept in the page. */
function Start({ workspace, owner }: { workspace: WorkspaceDto; owner: boolean }) {
  const { run, busy, message, setMessage, t } = useAction();
  const id = useId();
  const [token, setToken] = useState('');
  const [label, setLabel] = useState('');
  if (!owner) return <p className="text-sm text-muted">{t('bank_feeds.owner_connects')}</p>;
  return (
    <div className="space-y-3">
      <ol className="list-decimal space-y-1 pl-5 text-sm">
        <li>{t('bank_feeds.step_signup')}</li>
        <li>{t('bank_feeds.step_token')}</li>
        <li>{t('bank_feeds.step_paste')}</li>
      </ol>
      <form
        className="space-y-2"
        autoComplete="off"
        aria-label={t('bank_feeds.connect')}
        onSubmit={(e) => {
          e.preventDefault();
          const setupToken = setupTokenInput(token);
          if (!setupToken) return setMessage({ tone: 'bad', text: t('bank_feeds.token_needed') });
          void run(
            () =>
              browserApi.connectBankFeed(workspace.id, { setupToken, ...(label.trim() ? { label } : {}) }),
            t('bank_feeds.connected'),
          ).then(() => setToken(''));
        }}
      >
        <label htmlFor={`${id}-token`} className="field-label">
          {t('bank_feeds.token')}
        </label>
        <textarea
          id={`${id}-token`}
          className="input w-full font-mono text-xs"
          rows={3}
          autoComplete="off"
          spellCheck={false}
          value={token}
          onChange={(e) => setToken(e.target.value)}
          data-testid="bank-feeds-token"
        />
        <label htmlFor={`${id}-label`} className="field-label">
          {t('bank_feeds.label')}
        </label>
        <input
          id={`${id}-label`}
          className="input w-full"
          maxLength={100}
          value={label}
          onChange={(e) => setLabel(e.target.value)}
        />
        <button type="submit" className="btn-primary" disabled={busy} data-testid="bank-feeds-connect">
          {t('bank_feeds.connect')}
        </button>
        <StatusLine message={message} />
      </form>
    </div>
  );
}

function Connected({
  workspace,
  feed,
  accounts,
  owner,
}: {
  workspace: WorkspaceDto;
  feed: BankFeedDto;
  accounts: Target[];
  owner: boolean;
}) {
  const { run, busy, message, t } = useAction();
  const [confirming, setConfirming] = useState(false);
  return (
    <div className="space-y-4">
      <div className="space-y-1 text-sm">
        <p>
          {t('bank_feeds.connected_line', { host: feed.host ?? '' })} <DateText date={feed.connectedAt} />
          {feed.label ? ` · ${feed.label}` : ''}
        </p>
        <p className="text-xs text-muted">
          {t('bank_feeds.requests', { today: feed.requests.today, perDay: feed.requests.perDay })}
        </p>
        {feed.lastError && (
          <p className="text-bad" role="alert">
            {feed.lastError}
          </p>
        )}
        <p className="text-xs text-muted">{t('bank_feeds.not_syncing_yet')}</p>
      </div>

      {feed.accounts.length === 0 ? (
        <p className="text-sm text-muted">{t('bank_feeds.no_accounts')}</p>
      ) : (
        <ul className="divide-y divide-line" data-testid="bank-feeds-accounts">
          {feed.accounts.map((a) => (
            <AccountRow
              key={a.id}
              workspace={workspace}
              feed={feed}
              account={a}
              accounts={accounts}
              owner={owner}
            />
          ))}
        </ul>
      )}

      {owner && (
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className="btn-secondary"
            disabled={busy}
            onClick={() =>
              void run(() => browserApi.refreshBankFeed(workspace.id, feed.id), t('bank_feeds.refreshed'))
            }
          >
            {t('bank_feeds.refresh')}
          </button>
          <button
            type="button"
            className="btn-secondary"
            disabled={busy}
            onClick={() =>
              void run(() =>
                browserApi.updateBankFeed(workspace.id, feed.id, {
                  paused: feed.status !== 'paused',
                  version: feed.version,
                }),
              )
            }
          >
            {feed.status === 'paused' ? t('bank_feeds.resume') : t('bank_feeds.pause')}
          </button>
          {confirming ? (
            <span className="flex flex-wrap items-center gap-2">
              <span className="text-sm">{t('bank_feeds.disconnect_confirm')}</span>
              <button
                type="button"
                className="btn-danger"
                disabled={busy}
                onClick={() =>
                  void run(
                    () => browserApi.disconnectBankFeed(workspace.id, feed.id, feed.version),
                    t('bank_feeds.disconnected'),
                  )
                }
              >
                {t('bank_feeds.disconnect')}
              </button>
              <button type="button" className="btn-secondary" onClick={() => setConfirming(false)}>
                {t('common.cancel')}
              </button>
            </span>
          ) : (
            <button type="button" className="btn-secondary" onClick={() => setConfirming(true)}>
              {t('bank_feeds.disconnect')}
            </button>
          )}
        </div>
      )}
      <StatusLine message={message} />
    </div>
  );
}

/** §4: one account the feed reports, and what an owner can do with it. */
function AccountRow({
  workspace,
  feed,
  account: a,
  accounts,
  owner,
}: {
  workspace: WorkspaceDto;
  feed: BankFeedDto;
  account: BankFeedAccountDto;
  accounts: Target[];
  owner: boolean;
}) {
  const { run, busy, message, t } = useAction();
  const { money } = useI18n();
  const id = useId();
  const targets = linkTargets(accounts, a, feed);
  const [target, setTarget] = useState(a.suggestedAccountId ?? targets[0]?.id ?? '');
  const [start, setStart] = useState('');
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState(a.name);
  const [kind, setKind] = useState<string>(guessKind(a));
  const linkedTo = accounts.find((x) => x.id === a.accountId);
  const send = (input: Parameters<typeof browserApi.updateBankFeedAccount>[3], done?: string) =>
    void run(() => browserApi.updateBankFeedAccount(workspace.id, feed.id, a.id, input), done);
  const startInput = (
    <span className="flex flex-col">
      <label htmlFor={`${id}-start`} className="text-xs text-muted">
        {t('bank_feeds.start_date')}
      </label>
      <input
        id={`${id}-start`}
        type="date"
        className="input"
        min={feed.earliestStartDate}
        value={start}
        onChange={(e) => setStart(e.target.value)}
      />
    </span>
  );

  return (
    <li className="space-y-2 py-3" data-testid="bank-feeds-account">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <p className="font-medium">{a.name}</p>
          <p className="text-xs text-muted">
            {[a.institution, a.currency ?? t('bank_feeds.custom_currency')].filter(Boolean).join(' · ')}
          </p>
        </div>
        {a.balance && a.currency && (
          <p className="num text-sm">
            {money(BigInt(a.balance.amount), a.currency)}{' '}
            <span className="text-xs text-muted">
              <DateText date={a.balance.date} />
            </span>
          </p>
        )}
      </div>
      {a.problem && (
        <p className="text-sm text-bad">{a.problem.message || t('bank_feeds.account_problem')}</p>
      )}
      {a.missing && <p className="text-sm text-muted">{t('bank_feeds.missing')}</p>}

      {a.state === 'linked' && (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span>
            {t('bank_feeds.linked_to', { name: linkedTo?.name ?? '' })}
            {a.startDate && (
              <>
                {' · '}
                {t('bank_feeds.from')} <DateText date={a.startDate} />
              </>
            )}
          </span>
          {owner && (
            <button
              type="button"
              className="btn-secondary"
              disabled={busy}
              onClick={() => send({ action: 'unlink', version: a.version })}
            >
              {t('bank_feeds.unlink')}
            </button>
          )}
        </div>
      )}

      {a.state === 'ignored' && (
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted">
          <span>{t('bank_feeds.ignored')}</span>
          {owner && (
            <button
              type="button"
              className="btn-secondary"
              disabled={busy}
              onClick={() => send({ action: 'unlink', version: a.version })}
            >
              {t('bank_feeds.decide_again')}
            </button>
          )}
        </div>
      )}

      {a.state === 'new' && !owner && <p className="text-sm text-muted">{t('bank_feeds.not_linked')}</p>}
      {a.state === 'new' && owner && !a.currency && (
        <p className="text-sm text-muted">{t('bank_feeds.cannot_link')}</p>
      )}
      {a.state === 'new' && owner && a.currency && !creating && (
        <div className="flex flex-wrap items-end gap-2">
          {targets.length > 0 && (
            <span className="flex flex-col">
              <label htmlFor={`${id}-target`} className="text-xs text-muted">
                {a.suggestedAccountId ? t('bank_feeds.suggested') : t('bank_feeds.link_to')}
              </label>
              <select
                id={`${id}-target`}
                className="input"
                value={target}
                onChange={(e) => setTarget(e.target.value)}
              >
                {targets.map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.name}
                  </option>
                ))}
              </select>
            </span>
          )}
          {targets.length > 0 && startInput}
          {targets.length > 0 && (
            <button
              type="button"
              className="btn-primary"
              disabled={busy || !target}
              onClick={() =>
                send(
                  {
                    action: 'link',
                    accountId: target,
                    ...(start ? { startDate: start } : {}),
                    version: a.version,
                  },
                  t('bank_feeds.linked'),
                )
              }
              data-testid="bank-feeds-link"
            >
              {t('bank_feeds.link')}
            </button>
          )}
          <button type="button" className="btn-secondary" disabled={busy} onClick={() => setCreating(true)}>
            {t('bank_feeds.create')}
          </button>
          <button
            type="button"
            className="btn-secondary"
            disabled={busy}
            onClick={() => send({ action: 'ignore', version: a.version })}
          >
            {t('bank_feeds.ignore')}
          </button>
        </div>
      )}
      {a.state === 'new' && owner && a.currency && creating && (
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            send(
              {
                action: 'create',
                name: name.trim() || a.name,
                kind: kind as 'checking',
                ...(start ? { startDate: start } : {}),
                version: a.version,
              },
              t('bank_feeds.created'),
            );
          }}
        >
          <span className="flex flex-col">
            <label htmlFor={`${id}-name`} className="text-xs text-muted">
              {t('bank_feeds.account_name')}
            </label>
            <input
              id={`${id}-name`}
              className="input"
              value={name}
              maxLength={100}
              onChange={(e) => setName(e.target.value)}
            />
          </span>
          <span className="flex flex-col">
            <label htmlFor={`${id}-kind`} className="text-xs text-muted">
              {t('bank_feeds.account_kind')}
            </label>
            <select
              id={`${id}-kind`}
              className="input"
              value={kind}
              onChange={(e) => setKind(e.target.value)}
            >
              {(['checking', 'savings', 'credit_card', 'line_of_credit', 'loan', 'mortgage'] as const).map(
                (k) => (
                  <option key={k} value={k}>
                    {t(`account.kind.${k}`)}
                  </option>
                ),
              )}
            </select>
          </span>
          {startInput}
          <button type="submit" className="btn-primary" disabled={busy}>
            {t('bank_feeds.create_and_link')}
          </button>
          <button type="button" className="btn-secondary" onClick={() => setCreating(false)}>
            {t('common.cancel')}
          </button>
        </form>
      )}
      <p className="text-xs text-muted">
        {a.state === 'new' && owner && a.currency ? t('bank_feeds.start_hint') : ''}
      </p>
      <StatusLine message={message} />
    </li>
  );
}
