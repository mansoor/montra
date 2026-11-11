'use client';

import { useRef, useState, type ReactNode } from 'react';
import type { AccountDto, FamilyMemberDto, GoalDto, WorkspaceDto } from '@montra/api-client';
import { browserApi } from '@/lib/browser-api';
import { minorToInput, parseAmountInput } from '@/lib/money';
import { percentOf } from '@/lib/planning';
import { ProgressBar } from '../charts/line-chart';
import { DateText, useI18n } from '../i18n';
import { Money } from '../money';
import { StatusLine, useAction } from '../use-action';

const TYPES = ['emergency_fund', 'savings', 'sinking_fund', 'debt_payoff'] as const;

interface GoalOptions {
  workspace: WorkspaceDto;
  accounts: AccountDto[];
  members: FamilyMemberDto[];
}

/**
 * Goals and sinking funds (BUD-07, BUD-08, FAM-07): the active goals, each editable and archivable, then the
 * archived ones, which can be restored. One status line reports archive and restore, since the goal moves lists.
 */
export function GoalsBoard({
  goals,
  empty,
  ...options
}: GoalOptions & { goals: GoalDto[]; empty: ReactNode }) {
  const { t } = useI18n();
  const { run, busy, message } = useAction();
  const active = goals.filter((g) => !g.archived);
  const archived = goals.filter((g) => g.archived);
  const setArchived = (g: GoalDto, value: boolean) =>
    run(
      () => browserApi.updateGoal(options.workspace.id, g.id, { archived: value, version: g.version }),
      t(value ? 'goal.archived_done' : 'goal.restored', { name: g.name }),
    );
  return (
    <>
      <StatusLine message={message} />
      {active.length === 0 ? (
        empty
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {active.map((g) => (
            <GoalCard
              key={`${g.id}-${g.version}`}
              goal={g}
              options={options}
              busy={busy}
              onArchive={() => {
                if (window.confirm(t('goal.archive_confirm', { name: g.name }))) void setArchived(g, true);
              }}
            />
          ))}
        </div>
      )}
      {archived.length > 0 && (
        <details className="card" data-testid="archived-goals">
          <summary className="cursor-pointer text-sm font-semibold">
            {t('goal.archived_title', { count: archived.length })}
          </summary>
          <ul className="mt-3 divide-y divide-line">
            {archived.map((g) => (
              <li key={g.id} className="flex items-center justify-between gap-3 py-2">
                <span className="min-w-0">
                  <span className="block truncate font-medium">{g.name}</span>
                  <span className="text-xs text-muted">
                    {t(`goal.type_${g.type}`)}
                    {g.target && (
                      <>
                        {' · '}
                        <Money amount={g.target} currency={g.currency} />
                      </>
                    )}
                  </span>
                </span>
                <button
                  type="button"
                  className="btn-secondary"
                  disabled={busy}
                  aria-label={t('goal.restore_named', { name: g.name })}
                  onClick={() => void setArchived(g, false)}
                >
                  {t('common.restore')}
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}
    </>
  );
}

function GoalCard({
  goal: g,
  options,
  busy,
  onArchive,
}: {
  goal: GoalDto;
  options: GoalOptions;
  busy: boolean;
  onArchive: () => void;
}) {
  const { t } = useI18n();
  const [editing, setEditing] = useState(false);
  const editButton = useRef<HTMLButtonElement>(null);
  if (editing)
    return (
      <GoalForm
        {...options}
        goal={g}
        onClose={() => {
          setEditing(false);
          requestAnimationFrame(() => editButton.current?.focus());
        }}
      />
    );
  return (
    <article className="card space-y-3" aria-labelledby={`goal-${g.id}`}>
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
          <dd>{g.progress.projectedCompletion ? <DateText date={g.progress.projectedCompletion} /> : '—'}</dd>
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
      <div className="flex flex-wrap gap-2 border-t border-line pt-3">
        <button
          ref={editButton}
          type="button"
          className="btn-secondary"
          aria-label={t('goal.edit_named', { name: g.name })}
          onClick={() => setEditing(true)}
        >
          {t('common.edit')}
        </button>
        <button
          type="button"
          className="btn-ghost"
          disabled={busy}
          aria-label={t('goal.archive_named', { name: g.name })}
          onClick={onArchive}
        >
          {t('common.archive')}
        </button>
      </div>
    </article>
  );
}

/**
 * Adds a goal, or with `goal` edits one: the same fields pre-filled, saved with the goal's version. Kind and
 * books are fixed once a goal exists.
 */
export function GoalForm({
  workspace,
  accounts,
  members: allMembers,
  goal,
  onClose,
}: GoalOptions & { goal?: GoalDto; onClose?: () => void }) {
  const { t, locale } = useI18n();
  const { run, busy, message, setMessage } = useAction();
  const personal = workspace.entities.find((e) => e.type === 'personal') ?? workspace.entities[0]!;
  // Active members, plus the one the goal is for even if they've since left, so saving keeps them.
  const members = allMembers.filter((m) => m.status === 'active' || m.id === goal?.memberId);
  const toInput = (minor: string | null | undefined, currency: string) =>
    minor ? minorToInput(BigInt(minor), currency) : '';
  const [entityId, setEntityId] = useState(goal?.entityId ?? personal.id);
  const [memberId, setMemberId] = useState(goal?.memberId ?? '');
  const [type, setType] = useState<(typeof TYPES)[number]>(goal?.type ?? 'savings');
  const [name, setName] = useState(goal?.name ?? '');
  const [target, setTarget] = useState(toInput(goal?.target, goal?.currency ?? 'USD'));
  const [due, setDue] = useState<string>(goal?.dueDate ?? '');
  const [strategy, setStrategy] = useState<'avalanche' | 'snowball'>(goal?.strategy ?? 'avalanche');
  const [extra, setExtra] = useState(toInput(goal?.extraPayment, goal?.currency ?? 'USD'));
  const [linked, setLinked] = useState<string[]>(goal?.linkedAccountIds ?? []);
  const ccy = workspace.entities.find((e) => e.id === entityId)?.functionalCurrency ?? workspace.baseCurrency;
  const pool = accounts.filter(
    (a) =>
      a.entityId === entityId &&
      // An archived account stays listed while the goal still links it, so saving doesn't drop it unseen.
      (!a.archived || goal?.linkedAccountIds.includes(a.id)) &&
      (type === 'debt_payoff' ? a.type === 'liability' : a.type === 'asset'),
  );
  const title = goal ? t('goal.edit_named', { name: goal.name }) : t('goal.add');
  const amount = (raw: string) => {
    if (!raw.trim()) return null;
    const p = parseAmountInput(raw, ccy, locale);
    return p.ok && p.minor >= 0n ? String(p.minor) : undefined;
  };

  return (
    <form
      className="card space-y-4"
      aria-label={title}
      onSubmit={(e) => {
        e.preventDefault();
        const tgt = amount(target);
        const ext = amount(extra);
        if (tgt === undefined || ext === undefined) {
          setMessage({ tone: 'bad', text: t('budget.amount_invalid') });
          return;
        }
        if (goal) {
          const debt = goal.type === 'debt_payoff';
          void run(
            () =>
              browserApi.updateGoal(workspace.id, goal.id, {
                name,
                memberId: memberId || null,
                target: tgt,
                dueDate: due || null,
                linkedAccountIds: linked,
                ...(debt ? { strategy, extraPayment: ext } : {}),
                version: goal.version,
              }),
            t('goal.saved'),
          ).then((r) => {
            if (r) onClose?.();
          });
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
      <div>
        <h2 className="text-base font-semibold">{title}</h2>
        {goal && (
          <p className="text-xs text-muted">
            {t(`goal.type_${goal.type}`)} · {t('goal.kind_fixed')}
          </p>
        )}
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {!goal && (
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
        )}
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
        {!goal && workspace.entities.length > 1 && (
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
            autoFocus={Boolean(goal)}
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
      <div className="flex flex-wrap gap-2">
        <button
          type="submit"
          className="btn-primary"
          disabled={busy || (type === 'debt_payoff' && linked.length === 0)}
        >
          {goal ? t('goal.save') : t('goal.add')}
        </button>
        {goal && (
          <button type="button" className="btn-secondary" onClick={onClose}>
            {t('common.cancel')}
          </button>
        )}
      </div>
      <StatusLine message={message} />
    </form>
  );
}
