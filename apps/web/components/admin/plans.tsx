'use client';

import type {
  AdminPlanDto,
  AdminPlanVersionDto,
  PlanEntitlementsDto,
  StaffMemberDto,
} from '@montra/api-client';
import { useState } from 'react';
import { browserApi } from '@/lib/browser-api';
import { useI18n } from '../i18n';
import { StatusLine, useAction } from '../use-action';

const FEATURES = ['payroll', 'staffTime', 'scans', 'voice', 'ownStorage', 'familyVault'] as const;
const GB = 1024 ** 3;
const ROLES = ['support', 'admin', 'owner'] as const;

const gbOf = (bytes: string) => String(Number(bytes) / GB);
const usdOf = (micro: string | null) => (micro === null ? '' : String(Number(micro) / 1e6));
const microOf = (usd: string) => (usd.trim() === '' ? null : (Number(usd) * 1e6).toFixed(0));
const bytesOf = (gb: string) => (Number(gb) * GB).toFixed(0);
const countOf = (v: string) => (v.trim() === '' ? null : Number(v));

/** ADR-0049 §3: owners add, change and remove staff. Each change is emailed to every owner. */
export function StaffPanel({ staff }: { staff: StaffMemberDto[] }) {
  const { run, busy, message, t } = useAction();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<(typeof ROLES)[number]>('support');
  return (
    <section className="space-y-3" aria-label={t('admin.tab.staff')}>
      <p className="text-sm text-muted">{t('admin.staff_hint')}</p>
      <div className="card-flush overflow-x-auto">
        <table className="tbl">
          <thead>
            <tr>
              <th className="px-3 py-2">{t('admin.staff_email')}</th>
              <th className="px-3 py-2">{t('admin.staff_role')}</th>
              <th className="px-3 py-2">{t('admin.staff_added_by')}</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {staff.map((s) => (
              <tr key={s.userId} data-testid="staff-row">
                <td className="px-3 py-2 text-sm">{s.email}</td>
                <td className="px-3 py-2 text-sm">
                  <select
                    className="input"
                    aria-label={t('admin.staff_role_for', { email: s.email })}
                    value={s.role}
                    disabled={busy}
                    onChange={(e) =>
                      void run(
                        () =>
                          browserApi.adminSetStaff({
                            email: s.email,
                            role: e.target.value as StaffMemberDto['role'],
                          }),
                        t('admin.saved'),
                      )
                    }
                  >
                    {ROLES.map((r) => (
                      <option key={r} value={r}>
                        {t(`admin.role.${r}`)}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="px-3 py-2 text-sm text-muted">{s.addedBy ?? '—'}</td>
                <td className="px-3 py-2 text-right text-sm">
                  <button
                    type="button"
                    className="underline"
                    disabled={busy}
                    onClick={() => {
                      if (window.confirm(t('admin.staff_remove_confirm', { email: s.email }))) {
                        void run(() => browserApi.adminRemoveStaff(s.userId), t('admin.saved'));
                      }
                    }}
                  >
                    {t('admin.staff_remove')}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <form
        className="card flex flex-wrap items-end gap-3"
        aria-label={t('admin.staff_add')}
        onSubmit={async (e) => {
          e.preventDefault();
          const done = await run(() => browserApi.adminSetStaff({ email, role }), t('admin.saved'));
          if (done !== undefined) setEmail('');
        }}
      >
        <label>
          <span className="field-label">{t('admin.staff_email')}</span>
          <input
            className="input"
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </label>
        <label>
          <span className="field-label">{t('admin.staff_role')}</span>
          <select className="input" value={role} onChange={(e) => setRole(e.target.value as typeof role)}>
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {t(`admin.role.${r}`)}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" className="btn-primary" disabled={busy}>
          {t('admin.staff_add')}
        </button>
      </form>
      <StatusLine message={message} />
    </section>
  );
}

/** ADR-0049 §1: plans, their versions and prices. Admins see them; owners change them. */
export function PlansPanel({ plans, canChange }: { plans: AdminPlanDto[]; canChange: boolean }) {
  const { t } = useI18n();
  // A new plan's first version starts from Free's.
  const free = plans.find((p) => p.key === 'free')?.versions[0]?.entitlements;
  return (
    <section className="space-y-4" aria-label={t('admin.tab.plans')}>
      <p className="text-sm text-muted">{t('admin.plans_hint')}</p>
      {plans.map((p) => (
        <PlanCard key={p.key} plan={p} canChange={canChange} start={free} />
      ))}
      {canChange && <NewPlan />}
    </section>
  );
}

function PlanCard({
  plan,
  canChange,
  start,
}: {
  plan: AdminPlanDto;
  canChange: boolean;
  start: PlanEntitlementsDto | undefined;
}) {
  const { run, busy, message, t } = useAction();
  const [name, setName] = useState(plan.name);
  const [description, setDescription] = useState(plan.description);
  const [sortOrder, setSortOrder] = useState(String(plan.sortOrder));
  const [offered, setOffered] = useState(plan.offered);
  const [editing, setEditing] = useState(false);
  const from = plan.versions[0]?.entitlements ?? start;
  return (
    <article
      className="card space-y-3"
      data-testid={`plan-${plan.key}`}
      aria-labelledby={`plan-${plan.key}-title`}
    >
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id={`plan-${plan.key}-title`} className="text-base font-semibold">
          {plan.name} <span className="text-xs text-muted">({plan.key})</span>
        </h2>
        <span className="text-xs text-muted">
          {t(plan.offered ? 'admin.plan_offered' : 'admin.plan_withdrawn')}
        </span>
      </header>
      {canChange && (
        <form
          className="flex flex-wrap items-end gap-3"
          aria-label={t('admin.plan_details', { name: plan.name })}
          onSubmit={(e) => {
            e.preventDefault();
            void run(
              () =>
                browserApi.adminSavePlan({
                  key: plan.key,
                  name,
                  description,
                  sortOrder: Number(sortOrder),
                  offered,
                }),
              t('admin.saved'),
            );
          }}
        >
          <label>
            <span className="field-label">{t('admin.plan_name')}</span>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="grow">
            <span className="field-label">{t('admin.plan_description')}</span>
            <input
              className="input w-full"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </label>
          <label>
            <span className="field-label">{t('admin.plan_order')}</span>
            <input
              className="input w-20"
              type="number"
              min={0}
              value={sortOrder}
              onChange={(e) => setSortOrder(e.target.value)}
            />
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={offered}
              disabled={plan.key === 'free'}
              onChange={(e) => setOffered(e.target.checked)}
            />
            {t('admin.plan_offered')}
          </label>
          <button type="submit" className="btn-secondary" disabled={busy}>
            {t('admin.save')}
          </button>
        </form>
      )}
      <StatusLine message={message} />
      {plan.versions.map((v) => (
        <VersionRow key={v.id} plan={plan} version={v} canChange={canChange} />
      ))}
      {canChange && from && !editing && (
        <button type="button" className="btn-secondary" onClick={() => setEditing(true)}>
          {t('admin.plan_new_version')}
        </button>
      )}
      {canChange && editing && from && (
        <VersionForm planKey={plan.key} from={from} onDone={() => setEditing(false)} />
      )}
    </article>
  );
}

function summary(
  e: PlanEntitlementsDto,
  t: (k: string, v?: Record<string, string | number>) => string,
): string {
  return [
    t('admin.ent_business', { count: e.businessBooks }),
    t('admin.ent_rental', { count: e.rentalPortfolios }),
    t('admin.ent_storage', { gb: gbOf(e.storageBytes) }),
    e.familyLogins === null ? t('admin.ent_logins_any') : t('admin.ent_logins', { count: e.familyLogins }),
    e.aiMonthlyMicroUsd === null
      ? t('admin.ent_ai_any')
      : t('admin.ent_ai', { usd: usdOf(e.aiMonthlyMicroUsd) }),
    t('admin.ent_sms', { count: e.smsMonthly }),
    e.features.map((f) => t(`admin.feature.${f}`)).join(', ') || t('admin.ent_no_features'),
  ].join(' · ');
}

function VersionRow({
  plan,
  version: v,
  canChange,
}: {
  plan: AdminPlanDto;
  version: AdminPlanVersionDto;
  canChange: boolean;
}) {
  const { run, busy, message, t, locale } = useActionWithLocale();
  const [interval, setInterval] = useState<'month' | 'year'>('month');
  const [priceRef, setPriceRef] = useState('');
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState('USD');
  const [moveTo, setMoveTo] = useState('');
  const [after, setAfter] = useState('');
  const others = plan.versions.filter((o) => o.id !== v.id);
  const starts = new Date(v.effectiveFrom);
  return (
    <div className="space-y-2 border-t border-line pt-3 text-sm" data-testid="plan-version">
      <p className="font-medium">
        {t('admin.plan_version', { version: v.version })}
        {starts > new Date() && ` · ${t('admin.plan_starts', { date: starts.toLocaleDateString(locale) })}`}
        {' · '}
        {t('admin.plan_subscribers', { count: v.subscribers })}
        {v.pending > 0 && ` · ${t('admin.plan_pending', { count: v.pending })}`}
      </p>
      <p className="text-xs text-muted">{summary(v.entitlements, t)}</p>
      {v.prices.length > 0 && (
        <ul className="text-xs">
          {v.prices.map((p) => (
            <li key={p.id} className="flex flex-wrap items-center gap-2">
              <span>
                {new Intl.NumberFormat(locale, { style: 'currency', currency: p.currency }).format(
                  Number(p.amountMinor) / 100,
                )}{' '}
                / {t(`admin.interval.${p.interval}`)} · {p.priceRef}
                {!p.active && ` · ${t('admin.price_ended')}`}
              </span>
              {canChange && p.active && (
                <button
                  type="button"
                  className="underline"
                  disabled={busy}
                  onClick={() => void run(() => browserApi.adminEndPlanPrice(p.id), t('admin.saved'))}
                >
                  {t('admin.price_end')}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {canChange && plan.key !== 'free' && (
        <form
          className="flex flex-wrap items-end gap-2"
          aria-label={t('admin.price_add_for', { version: v.version })}
          onSubmit={async (e) => {
            e.preventDefault();
            const done = await run(
              () =>
                browserApi.adminAddPlanPrice(v.id, {
                  provider: 'stripe',
                  interval,
                  priceRef,
                  amountMinor: (Number(amount) * 100).toFixed(0),
                  currency,
                }),
              t('admin.saved'),
            );
            if (done !== undefined) setPriceRef('');
          }}
        >
          <select
            className="input"
            value={interval}
            onChange={(e) => setInterval(e.target.value as typeof interval)}
          >
            <option value="month">{t('admin.interval.month')}</option>
            <option value="year">{t('admin.interval.year')}</option>
          </select>
          <label>
            <span className="field-label">{t('admin.price_ref')}</span>
            <input
              className="input"
              required
              value={priceRef}
              onChange={(e) => setPriceRef(e.target.value)}
            />
          </label>
          <label>
            <span className="field-label">{t('admin.price_amount')}</span>
            <input
              className="input w-24 num"
              required
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </label>
          <label>
            <span className="field-label">{t('admin.price_currency')}</span>
            <input className="input w-20" value={currency} onChange={(e) => setCurrency(e.target.value)} />
          </label>
          <button type="submit" className="btn-secondary" disabled={busy}>
            {t('admin.price_add')}
          </button>
        </form>
      )}
      {canChange && v.subscribers > 0 && others.length > 0 && (
        <form
          className="flex flex-wrap items-end gap-2"
          aria-label={t('admin.move_for', { version: v.version })}
          onSubmit={(e) => {
            e.preventDefault();
            void run(
              () =>
                browserApi.adminMoveSubscribers({
                  from: v.id,
                  to: moveTo,
                  ...(after ? { after: new Date(`${after}T00:00:00Z`).toISOString() } : {}),
                }),
              (r) => t(r.when === 'now' ? 'admin.moved_now' : 'admin.moved_renewal', { count: r.moved }),
            );
          }}
        >
          <label>
            <span className="field-label">{t('admin.move_to')}</span>
            <select className="input" required value={moveTo} onChange={(e) => setMoveTo(e.target.value)}>
              <option value="" />
              {others.map((o) => (
                <option key={o.id} value={o.id}>
                  {t('admin.plan_version', { version: o.version })}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span className="field-label">{t('admin.move_after')}</span>
            <input className="input" type="date" value={after} onChange={(e) => setAfter(e.target.value)} />
          </label>
          <button type="submit" className="btn-secondary" disabled={busy || !moveTo}>
            {t('admin.move')}
          </button>
        </form>
      )}
      <StatusLine message={message} />
    </div>
  );
}

function useActionWithLocale() {
  const a = useAction();
  const { locale } = useI18n();
  return { ...a, locale };
}

/** A new version of a plan, starting from the latest one's entitlements. */
function VersionForm({
  planKey,
  from,
  onDone,
}: {
  planKey: string;
  from: PlanEntitlementsDto;
  onDone: () => void;
}) {
  const { run, busy, message, t } = useAction();
  const [business, setBusiness] = useState(String(from.businessBooks));
  const [rental, setRental] = useState(String(from.rentalPortfolios));
  const [storage, setStorage] = useState(gbOf(from.storageBytes));
  const [logins, setLogins] = useState(from.familyLogins === null ? '' : String(from.familyLogins));
  const [ai, setAi] = useState(usdOf(from.aiMonthlyMicroUsd));
  const [sms, setSms] = useState(String(from.smsMonthly));
  const [features, setFeatures] = useState<string[]>(from.features);
  const [start, setStart] = useState('');
  const num = (label: string, value: string, set: (v: string) => void, placeholder?: string) => (
    <label>
      <span className="field-label">{label}</span>
      <input
        className="input w-28 num"
        inputMode="decimal"
        placeholder={placeholder}
        value={value}
        onChange={(e) => set(e.target.value)}
      />
    </label>
  );
  return (
    <form
      className="space-y-3 border-t border-line pt-3"
      aria-label={t('admin.plan_new_version')}
      onSubmit={async (e) => {
        e.preventDefault();
        const done = await run(
          () =>
            browserApi.adminAddPlanVersion(planKey, {
              entitlements: {
                businessBooks: Number(business),
                rentalPortfolios: Number(rental),
                storageBytes: bytesOf(storage),
                familyLogins: countOf(logins),
                aiMonthlyMicroUsd: microOf(ai),
                smsMonthly: Number(sms),
                features: features as PlanEntitlementsDto['features'],
              },
              ...(start ? { effectiveFrom: new Date(`${start}T00:00:00Z`).toISOString() } : {}),
            }),
          t('admin.saved'),
        );
        if (done !== undefined) onDone();
      }}
    >
      <div className="flex flex-wrap gap-3">
        {num(t('admin.ent_business_label'), business, setBusiness)}
        {num(t('admin.ent_rental_label'), rental, setRental)}
        {num(t('admin.ent_storage_label'), storage, setStorage)}
        {num(t('admin.ent_logins_label'), logins, setLogins, t('admin.no_limit'))}
        {num(t('admin.ent_ai_label'), ai, setAi, t('admin.no_limit'))}
        {num(t('admin.ent_sms_label'), sms, setSms)}
      </div>
      <fieldset className="flex flex-wrap gap-3 text-sm">
        <legend className="field-label">{t('admin.ent_features')}</legend>
        {FEATURES.map((f) => (
          <label key={f} className="flex items-center gap-1">
            <input
              type="checkbox"
              checked={features.includes(f)}
              onChange={(e) =>
                setFeatures((cur) => (e.target.checked ? [...cur, f] : cur.filter((x) => x !== f)))
              }
            />
            {t(`admin.feature.${f}`)}
          </label>
        ))}
      </fieldset>
      <label>
        <span className="field-label">{t('admin.plan_start')}</span>
        <input className="input" type="date" value={start} onChange={(e) => setStart(e.target.value)} />
        <span className="block text-xs text-muted">{t('admin.plan_start_hint')}</span>
      </label>
      <div className="flex gap-2">
        <button type="submit" className="btn-primary" disabled={busy}>
          {t('admin.plan_add_version')}
        </button>
        <button type="button" className="btn-secondary" onClick={onDone}>
          {t('common.cancel')}
        </button>
      </div>
      <StatusLine message={message} />
    </form>
  );
}

/** A new tier. It starts with Free's allowances and no price, and isn't offered until it has one. */
function NewPlan() {
  const { run, busy, message, t } = useAction();
  const [key, setKey] = useState('');
  const [name, setName] = useState('');
  return (
    <form
      className="card flex flex-wrap items-end gap-3"
      aria-label={t('admin.plan_add')}
      onSubmit={async (e) => {
        e.preventDefault();
        const done = await run(
          () => browserApi.adminSavePlan({ key, name, description: '', sortOrder: 100, offered: false }),
          t('admin.saved'),
        );
        if (done !== undefined) {
          setKey('');
          setName('');
        }
      }}
    >
      <label>
        <span className="field-label">{t('admin.plan_key')}</span>
        <input
          className="input"
          required
          pattern="[a-z][a-z0-9_-]{1,31}"
          value={key}
          onChange={(e) => setKey(e.target.value)}
        />
      </label>
      <label>
        <span className="field-label">{t('admin.plan_name')}</span>
        <input className="input" required value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <button type="submit" className="btn-primary" disabled={busy}>
        {t('admin.plan_add')}
      </button>
      <StatusLine message={message} />
    </form>
  );
}
