'use client';

import { useState } from 'react';
import type { AccountDto, EmployerDto, FamilyMemberDto } from '@montra/api-client';
import { browserApi } from '@/lib/browser-api';
import { depositRowsOf, depositsInput, type DepositRow } from '@/lib/payslips';
import { DateText } from '../i18n';
import { Money } from '../money';
import { DepositSplitEditor } from './deposit-split-editor';
import { StatusLine, useAction } from '../use-action';

const TYPES = ['employer', 'freelance', 'pension', 'benefits', 'other'] as const;
const FREQUENCIES = ['weekly', 'biweekly', 'semimonthly', 'monthly'] as const;

/** Employers and other income sources per member (PAY-01), with where the pay lands. */
export function EmployerManager({
  workspaceId,
  employers,
  members,
  accounts,
}: {
  workspaceId: string;
  employers: EmployerDto[];
  members: FamilyMemberDto[];
  accounts: AccountDto[];
}) {
  const { run, busy, message, setMessage, t } = useAction();
  const deposit = accounts.filter((a) => !a.archived);
  const [memberId, setMemberId] = useState(members[0]?.id ?? '');
  const [name, setName] = useState('');
  const [type, setType] = useState<(typeof TYPES)[number]>('employer');
  const [payFrequency, setPayFrequency] = useState<(typeof FREQUENCIES)[number]>('monthly');
  const [depositAccountId, setDepositAccountId] = useState(deposit[0]?.id ?? '');
  const [payee, setPayee] = useState('');
  const [newSplit, setNewSplit] = useState<DepositRow[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [editRows, setEditRows] = useState<DepositRow[]>([]);
  const currencyOf = (id: string) => accounts.find((a) => a.id === id)?.currency ?? 'USD';
  /** Where a split can go: bank accounts in the same books and currency as the account that gets the rest. */
  const splitAccounts = (mainId: string) => {
    const main = accounts.find((a) => a.id === mainId);
    return deposit.filter(
      (a) => a.type === 'asset' && a.entityId === main?.entityId && a.currency === main?.currency,
    );
  };
  const memberName = new Map(members.map((m) => [m.id, m.name]));
  const accountName = new Map(accounts.map((a) => [a.id, a.name]));

  return (
    <div className="space-y-5">
      {employers.length > 0 && (
        <section className="card-flush" aria-label={t('employers.list')}>
          <table className="tbl">
            <thead>
              <tr>
                <th className="px-4 py-2">{t('employers.name')}</th>
                <th className="px-2 py-2">{t('employers.member')}</th>
                <th className="px-2 py-2">{t('employers.frequency')}</th>
                <th className="px-2 py-2">{t('employers.account')}</th>
                <th className="px-2 py-2">{t('employers.last_payslip')}</th>
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {employers.map((e) => (
                <tr key={e.id} data-testid="employer-row">
                  <td className="px-4 py-2 font-medium">
                    {e.name}
                    {e.archived && <span className="chip ml-2">{t('common.archived')}</span>}
                  </td>
                  <td className="px-2 py-2">{memberName.get(e.memberId) ?? ''}</td>
                  <td className="px-2 py-2">{t(`employers.frequency_${e.payFrequency}`)}</td>
                  <td className="px-2 py-2">
                    {accountName.get(e.depositAccountId) ?? ''}
                    {e.deposits.length > 0 && (
                      <span className="block text-xs text-muted" data-testid="employer-split-summary">
                        {e.deposits.map((d) => (
                          <span key={d.accountId} className="block">
                            {accountName.get(d.accountId) ?? ''}:{' '}
                            <Money amount={d.amount} currency={currencyOf(e.depositAccountId)} />
                          </span>
                        ))}
                      </span>
                    )}
                  </td>
                  <td className="px-2 py-2">
                    {e.lastPayDate ? <DateText date={e.lastPayDate} /> : t('employers.none_yet')}
                  </td>
                  <td className="px-4 py-2 text-right">
                    <button
                      type="button"
                      className="mr-3 text-sm underline"
                      aria-label={t('deposits.split_named', { name: e.name })}
                      onClick={() => {
                        setEditing(e.id);
                        setEditRows(depositRowsOf(e.deposits, currencyOf(e.depositAccountId)));
                      }}
                    >
                      {t('deposits.split')}
                    </button>
                    <button
                      type="button"
                      className="text-sm underline"
                      disabled={busy}
                      onClick={() =>
                        run(
                          () =>
                            browserApi.updateEmployer(workspaceId, e.id, {
                              archived: !e.archived,
                              version: e.version,
                            }),
                          e.archived ? t('common.unarchived') : t('common.archived_kept'),
                        )
                      }
                    >
                      {e.archived ? t('common.unarchive') : t('common.archive')}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {employers
        .filter((e) => e.id === editing)
        .map((e) => (
          <form
            key={e.id}
            className="card space-y-3"
            aria-label={t('deposits.split_named', { name: e.name })}
            onSubmit={(ev) => {
              ev.preventDefault();
              const split = depositsInput(editRows, currencyOf(e.depositAccountId));
              if (!split.ok) return setMessage({ tone: 'bad', text: split.error });
              void run(
                () =>
                  browserApi.updateEmployer(workspaceId, e.id, {
                    deposits: split.deposits,
                    version: e.version,
                  }),
                t('deposits.saved'),
              ).then((r) => {
                if (r) setEditing(null);
              });
            }}
          >
            <h2 className="text-base font-semibold">{t('deposits.split_named', { name: e.name })}</h2>
            <p className="text-sm text-muted">{t('deposits.plan_hint')}</p>
            <DepositSplitEditor
              rows={editRows}
              onChange={setEditRows}
              accounts={splitAccounts(e.depositAccountId)}
              mainAccountId={e.depositAccountId}
              currency={currencyOf(e.depositAccountId)}
            />
            <div className="flex gap-2">
              <button type="submit" className="btn-primary" disabled={busy}>
                {t('deposits.save')}
              </button>
              <button type="button" className="btn-secondary" onClick={() => setEditing(null)}>
                {t('common.cancel')}
              </button>
            </div>
          </form>
        ))}

      <form
        className="card space-y-3"
        aria-label={t('employers.add')}
        onSubmit={(e) => {
          e.preventDefault();
          const split = depositsInput(newSplit, currencyOf(depositAccountId));
          if (!split.ok) return setMessage({ tone: 'bad', text: split.error });
          void run(
            () =>
              browserApi.createEmployer(workspaceId, {
                memberId,
                name,
                type,
                payFrequency,
                depositAccountId,
                payee: payee.trim() || null,
                deposits: split.deposits,
              }),
            t('employers.added', { name }),
          ).then((r) => {
            if (r) {
              setName('');
              setPayee('');
              setNewSplit([]);
            }
          });
        }}
      >
        <h2 className="text-base font-semibold">{t('employers.add')}</h2>
        {members.length === 0 ? (
          <p className="text-sm text-muted">{t('employers.need_member')}</p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <label>
              <span className="field-label">{t('employers.name')}</span>
              <input
                className="input"
                required
                maxLength={200}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            <label>
              <span className="field-label">{t('employers.member')}</span>
              <select className="input" value={memberId} onChange={(e) => setMemberId(e.target.value)}>
                {members.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span className="field-label">{t('employers.type')}</span>
              <select
                className="input"
                value={type}
                onChange={(e) => setType(e.target.value as (typeof TYPES)[number])}
              >
                {TYPES.map((k) => (
                  <option key={k} value={k}>
                    {t(`employers.type_${k}`)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span className="field-label">{t('employers.frequency')}</span>
              <select
                className="input"
                value={payFrequency}
                onChange={(e) => setPayFrequency(e.target.value as (typeof FREQUENCIES)[number])}
              >
                {FREQUENCIES.map((k) => (
                  <option key={k} value={k}>
                    {t(`employers.frequency_${k}`)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span className="field-label">{t('employers.account')}</span>
              <select
                className="input"
                required
                value={depositAccountId}
                onChange={(e) => setDepositAccountId(e.target.value)}
              >
                {deposit.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span className="field-label">{t('employers.payee')}</span>
              <input
                className="input"
                maxLength={200}
                placeholder={t('employers.payee_hint')}
                value={payee}
                onChange={(e) => setPayee(e.target.value)}
              />
            </label>
          </div>
        )}
        {members.length > 0 && depositAccountId && (
          <fieldset className="space-y-2">
            <legend className="field-label">{t('deposits.title')}</legend>
            <DepositSplitEditor
              rows={newSplit}
              onChange={setNewSplit}
              accounts={splitAccounts(depositAccountId)}
              mainAccountId={depositAccountId}
              currency={currencyOf(depositAccountId)}
            />
          </fieldset>
        )}
        {members.length > 0 && (
          <button type="submit" className="btn-primary" disabled={busy || !depositAccountId}>
            {t('employers.add')}
          </button>
        )}
        <StatusLine message={message} />
      </form>
    </div>
  );
}
