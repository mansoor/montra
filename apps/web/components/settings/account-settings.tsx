'use client';

import { useState } from 'react';
import type { AccountDto, FamilyMemberDto, WorkspaceDto } from '@montra/api-client';
import { canDeleteAccounts, deleteStep } from '@/lib/account-delete';
import { canManageAccountNumber } from '@/lib/account-holders';
import { browserApi } from '@/lib/browser-api';
import { errorAction, friendlyMessage } from '@/lib/errors';
import { minorToInput, parseAmountInput } from '@/lib/money';
import { Money } from '../money';
import { useConfirm } from '../ui/confirm-dialog';
import { StatusLine, useAction } from '../use-action';
import { useI18n } from '../i18n';
import { AccountHoldersEditor, AccountNumberPanel } from './account-holders';
import { AccountPlanning } from './account-planning';

/** Rename, archive, hide, delete when empty, and adjust balances with an audit note (ACC-05, ACC-06, ACC-14, UP-04). */
export function AccountSettings({
  workspace,
  accounts,
  members,
  today,
}: {
  workspace: WorkspaceDto;
  accounts: AccountDto[];
  members: FamilyMemberDto[];
  today: string;
}) {
  const { t } = useI18n();
  if (accounts.length === 0) return <p className="card text-sm text-muted">{t('home.no_accounts')}</p>;
  const entityName = new Map(workspace.entities.map((e) => [e.id, e.name]));
  return (
    <ul className="space-y-3" aria-label={t('settings.tab.accounts')}>
      {accounts.map((a) => (
        <AccountCard
          key={a.id}
          workspaceId={workspace.id}
          account={a}
          entity={entityName.get(a.entityId) ?? ''}
          today={today}
          canDelete={canDeleteAccounts(workspace.role)}
          canManageNumber={canManageAccountNumber(workspace.role)}
          members={members}
        />
      ))}
    </ul>
  );
}

function AccountCard({
  workspaceId,
  account,
  entity,
  today,
  canDelete,
  canManageNumber,
  members,
}: {
  workspaceId: string;
  account: AccountDto;
  entity: string;
  today: string;
  canDelete: boolean;
  canManageNumber: boolean;
  members: FamilyMemberDto[];
}) {
  const { busy, message, setMessage, run, t } = useAction();
  const { locale } = useI18n();
  const { confirm, dialog } = useConfirm();
  const [name, setName] = useState(account.name);
  const [balance, setBalance] = useState(minorToInput(BigInt(account.balance.amount), account.currency));
  const [date, setDate] = useState(today);
  const [note, setNote] = useState('');
  const id = account.id;

  async function adjust() {
    const parsed = parseAmountInput(balance, account.currency, locale, t);
    if (!parsed.ok) return setMessage({ tone: 'bad', text: parsed.error });
    if (note.trim().length < 3) return setMessage({ tone: 'bad', text: t('accounts.note_required') });
    const ok = await run(
      () =>
        browserApi.adjustBalance(workspaceId, id, {
          date,
          balance: { amount: parsed.minor.toString(), currency: account.currency },
          note: note.trim(),
        }),
      t('accounts.adjusted'),
    );
    if (ok !== undefined) setNote('');
  }

  /** ACC-14: asks the API whether it is empty, shows why not, or confirms and deletes. Step-up comes back as a link. */
  async function remove() {
    setMessage(null);
    let step: ReturnType<typeof deleteStep>;
    try {
      step = deleteStep(await browserApi.accountDeletion(workspaceId, id));
    } catch (err) {
      return setMessage({ tone: 'bad', text: friendlyMessage(err, t), action: errorAction(err, t) });
    }
    if (step.kind === 'blocked') return setMessage({ tone: 'bad', text: step.reason });
    const question = step.trashedTransactions
      ? t('accounts.delete_confirm_trash', { name: account.name, count: step.trashedTransactions })
      : t('accounts.delete_confirm', { name: account.name });
    await confirm({
      title: t('accounts.delete_title'),
      body: <p>{question}</p>,
      confirmLabel: t('accounts.delete_button'),
      danger: true,
      action: () => run(() => browserApi.deleteAccount(workspaceId, id), t('accounts.deleted')),
    });
  }

  return (
    <li className="card space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-base font-semibold">{account.name}</h2>
        <span className="text-sm text-muted">
          {entity} · {t(`account.kind.${account.kind}`)}
          {account.archived && ` · ${t('common.archived')}`}
          {account.hidden && ` · ${t('accounts.hidden')}`}
        </span>
        <span className="ml-auto">
          <Money amount={account.balance.amount} currency={account.currency} />
        </span>
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-48 flex-1">
          <label htmlFor={`acc-name-${id}`} className="field-label">
            {t('fields.name')}
          </label>
          <input
            id={`acc-name-${id}`}
            className="input"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <button
          type="button"
          className="btn-secondary"
          disabled={busy || !name.trim() || name.trim() === account.name}
          onClick={() =>
            run(() => browserApi.updateAccount(workspaceId, id, { name: name.trim() }), t('common.renamed'))
          }
        >
          {t('common.rename')}
        </button>
        <button
          type="button"
          className="btn-secondary"
          disabled={busy}
          onClick={() =>
            run(
              () => browserApi.updateAccount(workspaceId, id, { hidden: !account.hidden }),
              account.hidden ? t('accounts.shown') : t('accounts.hidden_message'),
            )
          }
        >
          {account.hidden ? t('accounts.show') : t('accounts.hide')}
        </button>
        <button
          type="button"
          className="btn-secondary"
          disabled={busy}
          onClick={() =>
            run(
              () => browserApi.updateAccount(workspaceId, id, { archived: !account.archived }),
              account.archived ? t('common.unarchived') : t('common.archived_kept'),
            )
          }
        >
          {account.archived ? t('common.unarchive') : t('common.archive')}
        </button>
        {canDelete && (
          <button
            type="button"
            className="btn-secondary text-bad"
            disabled={busy}
            title={t('accounts.delete_hint')}
            onClick={remove}
          >
            {t('common.delete')}
          </button>
        )}
      </div>
      <details>
        <summary className="cursor-pointer text-sm text-muted">{t('accounts.adjust_title')}</summary>
        <div className="mt-2 flex flex-wrap items-end gap-2">
          <div>
            <label htmlFor={`adj-bal-${id}`} className="field-label">
              {account.type === 'liability' ? t('accounts.owed_on_date') : t('accounts.balance_on_date')}
            </label>
            <input
              id={`adj-bal-${id}`}
              className="input num w-36"
              inputMode="decimal"
              value={balance}
              onChange={(e) => setBalance(e.target.value)}
            />
          </div>
          <div>
            <label htmlFor={`adj-date-${id}`} className="field-label">
              {t('fields.date')}
            </label>
            <input
              id={`adj-date-${id}`}
              type="date"
              className="input"
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
          </div>
          <div className="min-w-48 flex-1">
            <label htmlFor={`adj-note-${id}`} className="field-label">
              {t('accounts.note_label')}
            </label>
            <input
              id={`adj-note-${id}`}
              className="input"
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </div>
          <button type="button" className="btn-primary" disabled={busy} onClick={adjust}>
            {t('accounts.adjust')}
          </button>
        </div>
      </details>
      <AccountHoldersEditor workspaceId={workspaceId} account={account} members={members} />
      <AccountNumberPanel workspaceId={workspaceId} account={account} canManage={canManageNumber} />
      <AccountPlanning workspaceId={workspaceId} account={account} />
      <StatusLine message={message} />
      {dialog}
    </li>
  );
}
