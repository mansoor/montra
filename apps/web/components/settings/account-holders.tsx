'use client';

import { useState } from 'react';
import type { AccountDto, FamilyMemberDto } from '@montra/api-client';
import {
  accountNumberInput,
  holderDrafts,
  holdersChanged,
  holdersToSave,
  type HolderDraft,
} from '@/lib/account-holders';
import { browserApi } from '@/lib/browser-api';
import { RevealValue } from '../payroll/reveal';
import { useConfirm } from '../ui/confirm-dialog';
import { StatusLine, useAction } from '../use-action';

/**
 * ACC-15: who the bank says holds the account, in order, each optionally a family member. The default member (whose
 * spending it is) is set in Settings → Family and isn't changed here. The API holds the limit (ACCOUNT_MAX_HOLDERS).
 */
export function AccountHoldersEditor({
  workspaceId,
  account,
  members,
}: {
  workspaceId: string;
  account: AccountDto;
  members: readonly FamilyMemberDto[];
}) {
  const { busy, message, run, t } = useAction();
  const [rows, setRows] = useState<HolderDraft[]>(() => holderDrafts(account.holders));
  const id = account.id;
  const set = (i: number, patch: Partial<HolderDraft>) =>
    setRows((r) => r.map((row, j) => (j === i ? { ...row, ...patch } : row)));
  // A member who has gone inactive stays choosable on the row that already names them.
  const choosable = (current: string) => members.filter((m) => m.status === 'active' || m.id === current);

  return (
    <details>
      <summary className="cursor-pointer text-sm text-muted">{t('accounts.holders')}</summary>
      <div className="mt-2 space-y-2">
        <p className="text-sm text-muted">{t('accounts.holders_hint')}</p>
        {rows.length === 0 && <p className="text-sm">{t('accounts.holders_none')}</p>}
        <ul className="space-y-2" aria-label={t('accounts.holders')}>
          {rows.map((row, i) => (
            <li key={i} className="flex flex-wrap items-end gap-2">
              <div className="min-w-48 flex-1">
                <label htmlFor={`holder-name-${id}-${i}`} className="field-label">
                  {t('accounts.holders_name')}
                </label>
                <input
                  id={`holder-name-${id}-${i}`}
                  className="input"
                  maxLength={100}
                  value={row.name}
                  placeholder={members.find((m) => m.id === row.memberId)?.name ?? ''}
                  onChange={(e) => set(i, { name: e.target.value })}
                />
              </div>
              <div>
                <label htmlFor={`holder-member-${id}-${i}`} className="field-label">
                  {t('accounts.holders_member')}
                </label>
                <select
                  id={`holder-member-${id}-${i}`}
                  className="input w-48"
                  value={row.memberId}
                  onChange={(e) => set(i, { memberId: e.target.value })}
                >
                  <option value="">{t('accounts.holders_no_member')}</option>
                  {choosable(row.memberId).map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </select>
              </div>
              <button
                type="button"
                className="btn-secondary"
                onClick={() => setRows((r) => r.filter((_, j) => j !== i))}
              >
                {t('accounts.holders_remove')}
              </button>
            </li>
          ))}
        </ul>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className="btn-secondary"
            onClick={() => setRows((r) => [...r, { name: '', memberId: '' }])}
          >
            {t('accounts.holders_add')}
          </button>
          <button
            type="button"
            className="btn-primary"
            disabled={busy || !holdersChanged(account.holders, rows)}
            onClick={async () => {
              const saved = await run(
                () => browserApi.updateAccount(workspaceId, id, { holders: holdersToSave(rows) }),
                t('accounts.holders_saved'),
              );
              if (saved) setRows(holderDrafts(saved.holders));
            }}
          >
            {t('common.save')}
          </button>
        </div>
        <StatusLine message={message} />
      </div>
    </details>
  );
}

/**
 * ACC-16: the account number. Everyone sees "••••1234"; owners and admins type in the full number, show it after a
 * recent sign-in (each time logged) and remove it. The full number never comes back with the account.
 */
export function AccountNumberPanel({
  workspaceId,
  account,
  canManage,
}: {
  workspaceId: string;
  account: AccountDto;
  canManage: boolean;
}) {
  const { busy, message, setMessage, run, t } = useAction();
  const { confirm, dialog } = useConfirm();
  const [typed, setTyped] = useState('');
  const id = account.id;

  async function save() {
    const value = accountNumberInput(typed);
    if (!value) return setMessage({ tone: 'bad', text: t('accounts.number_invalid') });
    const ok = await run(
      () => browserApi.updateAccount(workspaceId, id, { accountNumber: value }),
      t('accounts.number_saved'),
    );
    if (ok) setTyped('');
  }

  return (
    <details>
      <summary className="cursor-pointer text-sm text-muted">{t('accounts.number')}</summary>
      <div className="mt-2 space-y-2">
        <p className="text-sm">
          {account.fullNumberKept && canManage ? (
            <RevealValue
              masked={account.accountNumberMasked}
              load={() => browserApi.revealAccountNumber(workspaceId, id).then((r) => r.value)}
              label={t('accounts.number')}
            />
          ) : (
            <span className="num" data-testid="masked-value">
              {account.accountNumberMasked ?? t('accounts.number_none')}
            </span>
          )}
        </p>
        <p className="text-sm text-muted">{t('accounts.number_hint')}</p>
        {canManage && (
          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-48 flex-1">
              <label htmlFor={`acc-number-${id}`} className="field-label">
                {account.fullNumberKept ? t('accounts.number_replace') : t('accounts.number_full')}
              </label>
              <input
                id={`acc-number-${id}`}
                className="input num"
                autoComplete="off"
                spellCheck={false}
                inputMode="text"
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
              />
            </div>
            <button type="button" className="btn-primary" disabled={busy || !typed.trim()} onClick={save}>
              {t('accounts.number_save')}
            </button>
            {account.fullNumberKept && (
              <button
                type="button"
                className="btn-secondary"
                disabled={busy}
                onClick={() =>
                  void confirm({
                    title: t('accounts.number_remove_title'),
                    body: <p>{t('accounts.number_remove_confirm')}</p>,
                    confirmLabel: t('accounts.number_remove'),
                    danger: true,
                    action: () =>
                      run(
                        () => browserApi.updateAccount(workspaceId, id, { accountNumber: null }),
                        t('accounts.number_removed'),
                      ),
                  })
                }
              >
                {t('accounts.number_remove')}
              </button>
            )}
          </div>
        )}
        <StatusLine message={message} />
      </div>
      {dialog}
    </details>
  );
}
