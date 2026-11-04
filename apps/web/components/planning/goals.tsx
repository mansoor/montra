'use client';

import { useState } from 'react';
import type { AccountDto, FamilyMemberDto, GoalDto, WorkspaceDto } from '@montra/api-client';
import { browserApi } from '@/lib/browser-api';
import { parseAmountInput } from '@/lib/money';
import { percentOf } from '@/lib/planning';
import { ProgressBar } from '../charts/line-chart';
import { DateText, useI18n } from '../i18n';
import { Money } from '../money';
import { StatusLine, useAction } from '../use-action';

const TYPES = ['emergency_fund', 'savings', 'sinking_fund', 'debt_payoff'] as const;

/** Goals and sinking funds (BUD-07, BUD-08, FAM-07): progress, projection and debt payoff plans. */
export function GoalsList({ goals }: { goals: GoalDto[] }) {
  const { t } = useI18n();
  if (goals.length === 0) return null;
  return (
    <div className="grid gap-4 md:grid-cols-2">
      {goals.map((g) => (
        <article key={g.id} className="card space-y-3" aria-labelledby={`goal-${g.id}`}>
          <div className="flex items-start justify-between gap-2">
            <div>
              <h3 id={`goal-${g.id}`} className="font-semibold">
                {g.name}
              </h3>
              <p className="text-xs text-muted">
                {t(`goal.type_${g.type}`)}
                {g.dueDate && (
                  <>
                    {' · '}
                    {t('goal.due')} <DateText date={g.dueDate} />
                  </>
                )}
              </p>
            </div>
            {g.progress.onTrack !== null && (
              <span className={`chip ${g.progress.onTrack ? 'chip-good' : 'chip-warn'}`}>
                {g.progress.onTrack ? t('goal.on_track') : t('goal.behind')}
              </span>
            )}
          </div>
          {g.target && (
            <>
              <div className="flex items-baseline justify-between text-sm">
                <span>
                  <Money amount={g.progress.saved} currency={g.currency} className="font-semibold" /> /{' '}
                  <Money amount={g.target} currency={g.currency} />
                </span>
                <span className="num text-muted">{g.progress.percent ?? 0}%</span>
              </div>
              <ProgressBar
                label={t('goal.progress_for', { name: g.name })}
                percent={percentOf(BigInt(g.progress.saved), BigInt(g.target))}
                tone="good"
              />
            </>
          )}
          <dl className="grid grid-cols-2 gap-2 text-sm">
            {g.progress.monthlyNeeded && (
              <div>
                <dt className="text-xs text-muted">{t('goal.monthly_needed')}</dt>
                <dd>
                  <Money amount={g.progress.monthlyNeeded} currency={g.currency} />
                </dd>
              </div>
            )}
            <div>
              <dt className="text-xs text-muted">{t('goal.monthly_average')}</dt>
              <dd>
                <Money amount={g.progress.monthlyAverage} currency={g.currency} />
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted">{t('goal.projected')}</dt>
              <dd>
                {g.progress.projectedCompletion ? <DateText date={g.progress.projectedCompletion} /> : '—'}
              </dd>
            </div>
          </dl>
          {g.payoff && (
            <div className="space-y-2 border-t border-line pt-3">
              <p className="text-sm">
                {t('goal.payoff_summary', { strategy: t(`goal.strategy_${g.payoff.strategy}`) })}{' '}
                {g.payoff.payoffDate ? (
                  <strong>
                    <DateText date={g.payoff.payoffDate} />
                  </strong>
                ) : (
                  <strong className="text-bad">{t('goal.never')}</strong>
                )}
              </p>
              <p className="text-xs text-muted">
                {t('goal.monthly_payment')} <Money amount={g.payoff.monthlyPayment} currency={g.currency} />
                {g.payoff.totalInterest && (
                  <>
                    {' · '}
                    {t('goal.interest')} <Money amount={g.payoff.totalInterest} currency={g.currency} />
                  </>
                )}
                {g.payoff.alternative.totalInterest && (
                  <>
                    {' · '}
                    {t('goal.alternative')}{' '}
                    <Money amount={g.payoff.alternative.totalInterest} currency={g.currency} />
                  </>
                )}
              </p>
              <table className="tbl">
                <thead>
                  <tr>
                    <th scope="col" className="px-2 py-1">
                      {t('goal.debt')}
                    </th>
                    <th scope="col" className="px-2 py-1 text-right">
                      {t('goal.balance')}
                    </th>
                    <th scope="col" className="px-2 py-1 text-right">
                      {t('goal.apr')}
                    </th>
                    <th scope="col" className="px-2 py-1 text-right">
                      {t('goal.paid_off')}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {g.payoff.debts.map((d) => (
                    <tr key={d.accountId}>
                      <td className="px-2 py-1">{d.name}</td>
                      <td className="px-2 py-1 text-right">
                        <Money amount={d.balance} currency={g.currency} />
                      </td>
                      <td className="num px-2 py-1 text-right">{(d.rateBps / 100).toFixed(2)}%</td>
                      <td className="px-2 py-1 text-right">
                        {d.payoffDate ? <DateText date={d.payoffDate} /> : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </article>
      ))}
    </div>
  );
}

export function GoalForm({
  workspace,
  accounts,
  members,
}: {
  workspace: WorkspaceDto;
  accounts: AccountDto[];
  members: FamilyMemberDto[];
}) {
  const { t, locale } = useI18n();
  const { run, busy, message, setMessage } = useAction();
  const personal = workspace.entities.find((e) => e.type === 'personal') ?? workspace.entities[0]!;
  const [entityId, setEntityId] = useState(personal.id);
  const [memberId, setMemberId] = useState('');
  const [type, setType] = useState<(typeof TYPES)[number]>('savings');
  const [name, setName] = useState('');
  const [target, setTarget] = useState('');
  const [due, setDue] = useState('');
  const [strategy, setStrategy] = useState<'avalanche' | 'snowball'>('avalanche');
  const [extra, setExtra] = useState('');
  const [linked, setLinked] = useState<string[]>([]);
  const ccy = workspace.entities.find((e) => e.id === entityId)?.functionalCurrency ?? workspace.baseCurrency;
  const pool = accounts.filter(
    (a) =>
      a.entityId === entityId &&
      !a.archived &&
      (type === 'debt_payoff' ? a.type === 'liability' : a.type === 'asset'),
  );
  const amount = (raw: string) => {
    if (!raw.trim()) return null;
    const p = parseAmountInput(raw, ccy, locale);
    return p.ok && p.minor >= 0n ? String(p.minor) : undefined;
  };

  return (
    <form
      className="card space-y-4"
      aria-label={t('goal.add')}
      onSubmit={(e) => {
        e.preventDefault();
        const tgt = amount(target);
        const ext = amount(extra);
        if (tgt === undefined || ext === undefined) {
          setMessage({ tone: 'bad', text: t('budget.amount_invalid') });
          return;
        }
        void run(
          () =>
            browserApi.createGoal(workspace.id, {
              entityId,
              memberId: memberId || null,
              name,
              type,
              target: tgt,
              dueDate: due || null,
              strategy: type === 'debt_payoff' ? strategy : null,
              linkedAccountIds: linked,
              extraPayment: type === 'debt_payoff' ? ext : null,
            }),
          t('goal.added'),
        ).then((r) => {
          if (r) {
            setName('');
            setTarget('');
            setDue('');
            setLinked([]);
          }
        });
      }}
    >
      <h2 className="text-base font-semibold">{t('goal.add')}</h2>
      <div className="grid gap-3 sm:grid-cols-2">
        <label>
          <span className="field-label">{t('goal.type')}</span>
          <select
            className="input"
            value={type}
            onChange={(e) => setType(e.target.value as (typeof TYPES)[number])}
          >
            {TYPES.map((k) => (
              <option key={k} value={k}>
                {t(`goal.type_${k}`)}
              </option>
            ))}
          </select>
        </label>
        {members.length > 0 && (
          <label>
            <span className="field-label">{t('goal.member')}</span>
            <select className="input" value={memberId} onChange={(e) => setMemberId(e.target.value)}>
              <option value="">{t('members.household')}</option>
              {members.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </label>
        )}
        {workspace.entities.length > 1 && (
          <label>
            <span className="field-label">{t('goal.entity')}</span>
            <select className="input" value={entityId} onChange={(e) => setEntityId(e.target.value)}>
              {workspace.entities.map((en) => (
                <option key={en.id} value={en.id}>
                  {en.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <label>
          <span className="field-label">{t('goal.name')}</span>
          <input
            className="input"
            required
            maxLength={200}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label>
          <span className="field-label">{t('goal.target')}</span>
          <input
            className="input num"
            inputMode="decimal"
            required={type === 'sinking_fund'}
            value={target}
            onChange={(e) => setTarget(e.target.value)}
          />
        </label>
        <label>
          <span className="field-label">{t('goal.due')}</span>
          <input
            type="date"
            className="input"
            required={type === 'sinking_fund'}
            value={due}
            onChange={(e) => setDue(e.target.value)}
          />
        </label>
        {type === 'debt_payoff' && (
          <>
            <label>
              <span className="field-label">{t('goal.strategy')}</span>
              <select
                className="input"
                value={strategy}
                onChange={(e) => setStrategy(e.target.value as 'avalanche' | 'snowball')}
              >
                <option value="avalanche">{t('goal.strategy_avalanche')}</option>
                <option value="snowball">{t('goal.strategy_snowball')}</option>
              </select>
            </label>
            <label>
              <span className="field-label">{t('goal.extra')}</span>
              <input
                className="input num"
                inputMode="decimal"
                value={extra}
                onChange={(e) => setExtra(e.target.value)}
              />
            </label>
          </>
        )}
      </div>
      {pool.length > 0 && (
        <fieldset>
          <legend className="field-label">
            {type === 'debt_payoff' ? t('goal.linked_debts') : t('goal.linked_savings')}
          </legend>
          <div className="flex flex-wrap gap-2">
            {pool.map((a) => (
              <label
                key={a.id}
                className="flex items-center gap-2 rounded-[var(--radius-m)] border border-line px-3 py-1.5 text-sm"
              >
                <input
                  type="checkbox"
                  checked={linked.includes(a.id)}
                  onChange={(e) =>
                    setLinked(e.target.checked ? [...linked, a.id] : linked.filter((x) => x !== a.id))
                  }
                />
                {a.name}
              </label>
            ))}
          </div>
          {type !== 'debt_payoff' && <p className="mt-1 text-xs text-muted">{t('goal.linked_hint')}</p>}
        </fieldset>
      )}
      <button
        type="submit"
        className="btn-primary"
        disabled={busy || (type === 'debt_payoff' && linked.length === 0)}
      >
        {t('goal.add')}
      </button>
      <StatusLine message={message} />
    </form>
  );
}
