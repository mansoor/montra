'use client';

import type {
  AdminAccountDto,
  AdminSupportRequestDto,
  AdminWorkspaceDto,
  AiCeilingDto,
  AppVersionsDto,
  PasswordPolicyDto,
  FeatureFlagDto,
  SystemNoticeDto,
} from '@montra/api-client';
import Link from 'next/link';
import { useState } from 'react';
import { browserApi } from '@/lib/browser-api';
import { StatusLine, useAction } from '../use-action';

const gb = (bytes: string) => (Number(bytes) / 1024 ** 3).toFixed(2);

/** OPS-01: finding an account. People and plans only: there's nothing about money to show. */
export function AccountLookup({ canChange }: { canChange: boolean }) {
  const { run, busy, message, t } = useAction();
  const [q, setQ] = useState('');
  const [accounts, setAccounts] = useState<AdminAccountDto[] | null>(null);
  const [workspaces, setWorkspaces] = useState<Record<string, AdminWorkspaceDto[]>>({});
  const open = async (id: string) => {
    const rows = await run(() => browserApi.adminAccountWorkspaces(id));
    if (rows) setWorkspaces((w) => ({ ...w, [id]: rows }));
  };
  const setPlan = async (accountId: string, workspaceId: string, plan: 'free' | 'pro') => {
    const reason = window.prompt(t('admin.plan_reason'));
    if (!reason) return;
    const done = await run(() => browserApi.adminSetPlan(workspaceId, { plan, reason }), t('admin.saved'));
    if (done !== undefined) await open(accountId);
  };
  return (
    <section className="space-y-3" aria-label={t('admin.tab.accounts')}>
      <form
        className="card flex flex-wrap items-end gap-2"
        role="search"
        onSubmit={async (e) => {
          e.preventDefault();
          const rows = await run(() => browserApi.adminAccounts(q));
          if (rows) setAccounts(rows);
        }}
      >
        <label>
          <span className="field-label">{t('admin.find_email')}</span>
          <input className="input" type="search" value={q} onChange={(e) => setQ(e.target.value)} />
        </label>
        <button type="submit" className="btn-primary" disabled={busy || q.trim().length < 2}>
          {t('search.submit')}
        </button>
      </form>
      <StatusLine message={message} />
      {accounts?.length === 0 && <p className="text-sm text-muted">{t('search.nothing')}</p>}
      {accounts?.map((a) => (
        <div key={a.id} className="card space-y-2" data-testid="admin-account">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className="text-sm font-semibold">{a.email}</p>
              <p className="text-xs text-muted">
                {a.displayName} · {t('admin.workspaces', { count: a.workspaces })}
                {a.deletedAt && ` · ${t('admin.deleting')}`}
              </p>
            </div>
            <button type="button" className="btn-secondary" onClick={() => open(a.id)}>
              {t('admin.open')}
            </button>
          </div>
          {workspaces[a.id]?.map((w) => (
            <div
              key={w.id}
              className="space-y-1 border-t border-line pt-2 text-sm"
              data-testid="admin-workspace"
            >
              <p className="font-medium">{w.name}</p>
              <p className="text-xs text-muted">
                {w.plan} · {w.status}
                {w.provider && ` · ${w.provider}`} · {gb(w.usedBytes)} / {gb(w.quotaBytes)} GB ·{' '}
                {t('admin.members', { count: w.members })}
              </p>
              <div className="flex flex-wrap gap-2">
                {w.supportUntil ? (
                  <Link className="underline" href={`/admin/support/${w.id}`}>
                    {t('admin.support_open')}
                  </Link>
                ) : (
                  <span className="text-xs text-muted">{t('admin.support_none')}</span>
                )}
                {canChange && (
                  <button
                    type="button"
                    className="underline"
                    disabled={busy}
                    onClick={() => setPlan(a.id, w.id, w.plan === 'pro' ? 'free' : 'pro')}
                  >
                    {t(w.plan === 'pro' ? 'admin.plan_free' : 'admin.plan_pro')}
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      ))}
    </section>
  );
}

export function FlagsPanel({ flags, canChange }: { flags: FeatureFlagDto[]; canChange: boolean }) {
  const { run, busy, message, t } = useAction();
  const [key, setKey] = useState('');
  const [rollout, setRollout] = useState('100');
  const [note, setNote] = useState('');
  return (
    <section className="space-y-3" aria-label={t('admin.tab.flags')}>
      <div className="card-flush overflow-x-auto">
        <table className="tbl">
          <thead>
            <tr>
              <th className="px-3 py-2">{t('admin.flag')}</th>
              <th className="px-3 py-2">{t('admin.flag_on')}</th>
              <th className="px-3 py-2 text-right">{t('admin.flag_rollout')}</th>
              <th className="px-3 py-2">{t('admin.flag_note')}</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {flags.map((f) => (
              <tr key={f.key} data-testid="admin-flag">
                <td className="px-3 py-2 text-sm">{f.key}</td>
                <td className="px-3 py-2">
                  <input
                    type="checkbox"
                    aria-label={f.key}
                    checked={f.enabled}
                    disabled={!canChange || busy}
                    onChange={(e) =>
                      run(() =>
                        browserApi.adminSaveFlag({
                          key: f.key,
                          enabled: e.target.checked,
                          rollout: f.rollout,
                          note: f.note,
                        }),
                      )
                    }
                  />
                </td>
                <td className="px-3 py-2 text-right text-sm">{f.rollout}%</td>
                <td className="px-3 py-2 text-sm text-muted">{f.note}</td>
                <td className="px-3 py-2 text-right">
                  {canChange && (
                    <button
                      type="button"
                      className="text-sm underline"
                      disabled={busy}
                      aria-label={t('admin.delete_named', { name: f.key })}
                      onClick={() => run(() => browserApi.adminDeleteFlag(f.key))}
                    >
                      {t('reports.delete')}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {canChange && (
        <form
          className="card flex flex-wrap items-end gap-2"
          aria-label={t('admin.flag_add')}
          onSubmit={async (e) => {
            e.preventDefault();
            const done = await run(
              () => browserApi.adminSaveFlag({ key, enabled: false, rollout: Number(rollout), note }),
              t('admin.saved'),
            );
            if (done !== undefined) setKey('');
          }}
        >
          <label>
            <span className="field-label">{t('admin.flag')}</span>
            <input className="input" value={key} onChange={(e) => setKey(e.target.value)} />
          </label>
          <label>
            <span className="field-label">{t('admin.flag_rollout')}</span>
            <input
              className="input w-24"
              type="number"
              min={0}
              max={100}
              value={rollout}
              onChange={(e) => setRollout(e.target.value)}
            />
          </label>
          <label>
            <span className="field-label">{t('admin.flag_note')}</span>
            <input className="input" value={note} onChange={(e) => setNote(e.target.value)} />
          </label>
          <button type="submit" className="btn-primary" disabled={busy || !key}>
            {t('admin.flag_add')}
          </button>
        </form>
      )}
      <StatusLine message={message} />
    </section>
  );
}

export function NoticesPanel({
  notices,
  versions,
  canChange,
}: {
  notices: (SystemNoticeDto & { showFrom: string })[];
  versions: AppVersionsDto;
  canChange: boolean;
}) {
  const { run, busy, message, t } = useAction();
  const [kind, setKind] = useState<SystemNoticeDto['kind']>('maintenance');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [starts, setStarts] = useState('');
  const [ends, setEnds] = useState('');
  const [ios, setIos] = useState(versions.ios);
  const [android, setAndroid] = useState(versions.android);
  const now = Date.now();
  const live = notices.filter((n) => !n.endsAt || Date.parse(n.endsAt) > now);
  return (
    <section className="space-y-3" aria-label={t('admin.tab.notices')}>
      <ul className="card divide-y divide-line p-0">
        {live.length === 0 && <li className="px-4 py-3 text-sm text-muted">{t('admin.no_notices')}</li>}
        {live.map((n) => (
          <li
            key={n.id}
            className="flex flex-wrap items-center justify-between gap-2 px-4 py-3"
            data-testid="admin-notice"
          >
            <div>
              <p className="text-sm font-medium">
                {n.title} <span className="chip ml-1">{n.kind}</span>
              </p>
              {n.startsAt && <p className="text-xs text-muted">{new Date(n.startsAt).toLocaleString()}</p>}
            </div>
            {canChange && (
              <button
                type="button"
                className="btn-secondary"
                disabled={busy}
                aria-label={t('admin.end_named', { name: n.title })}
                onClick={() => run(() => browserApi.adminEndNotice(n.id))}
              >
                {t('admin.end')}
              </button>
            )}
          </li>
        ))}
      </ul>
      {canChange && (
        <form
          className="card grid gap-3 sm:grid-cols-2"
          aria-label={t('admin.notice_add')}
          onSubmit={async (e) => {
            e.preventDefault();
            const done = await run(
              () =>
                browserApi.adminCreateNotice({
                  kind,
                  title,
                  body,
                  ...(starts ? { startsAt: new Date(starts).toISOString() } : {}),
                  ...(ends ? { endsAt: new Date(ends).toISOString() } : {}),
                }),
              t('admin.saved'),
            );
            if (done) {
              setTitle('');
              setBody('');
            }
          }}
        >
          <label>
            <span className="field-label">{t('admin.notice_kind')}</span>
            <select
              className="input"
              value={kind}
              onChange={(e) => setKind(e.target.value as SystemNoticeDto['kind'])}
            >
              <option value="maintenance">{t('admin.notice_maintenance')}</option>
              <option value="incident">{t('admin.notice_incident')}</option>
              <option value="info">{t('admin.notice_info')}</option>
            </select>
          </label>
          <label>
            <span className="field-label">{t('admin.notice_title')}</span>
            <input
              className="input"
              value={title}
              maxLength={200}
              onChange={(e) => setTitle(e.target.value)}
            />
          </label>
          <label className="sm:col-span-2">
            <span className="field-label">{t('admin.notice_body')}</span>
            <input
              className="input"
              value={body}
              maxLength={2000}
              onChange={(e) => setBody(e.target.value)}
            />
          </label>
          <label>
            <span className="field-label">{t('admin.notice_starts')}</span>
            <input
              className="input"
              type="datetime-local"
              value={starts}
              onChange={(e) => setStarts(e.target.value)}
            />
          </label>
          <label>
            <span className="field-label">{t('admin.notice_ends')}</span>
            <input
              className="input"
              type="datetime-local"
              value={ends}
              onChange={(e) => setEnds(e.target.value)}
            />
          </label>
          <p className="text-xs text-muted sm:col-span-2">{t('admin.notice_48')}</p>
          <button type="submit" className="btn-primary justify-self-start" disabled={busy || !title.trim()}>
            {t('admin.notice_add')}
          </button>
        </form>
      )}
      <form
        className="card flex flex-wrap items-end gap-2"
        aria-label={t('admin.versions')}
        onSubmit={(e) => {
          e.preventDefault();
          void run(() => browserApi.adminSaveAppVersions({ ios, android }), t('admin.saved'));
        }}
      >
        <label>
          <span className="field-label">{t('admin.version_ios')}</span>
          <input
            className="input w-28"
            disabled={!canChange}
            value={ios}
            onChange={(e) => setIos(e.target.value)}
          />
        </label>
        <label>
          <span className="field-label">{t('admin.version_android')}</span>
          <input
            className="input w-28"
            disabled={!canChange}
            value={android}
            onChange={(e) => setAndroid(e.target.value)}
          />
        </label>
        {canChange && (
          <button type="submit" className="btn-secondary" disabled={busy}>
            {t('admin.save')}
          </button>
        )}
      </form>
      <StatusLine message={message} />
    </section>
  );
}

/** AUTH-02 (ADR-0043): the password policy the auth gateway enforces for everyone, within a minute of saving. */
export function PasswordPolicyPanel({
  policy,
  canChange,
}: {
  policy: PasswordPolicyDto;
  canChange: boolean;
}) {
  const { run, busy, message, t } = useAction();
  const [minLength, setMinLength] = useState(String(policy.minLength));
  const [minScore, setMinScore] = useState(policy.minScore);
  return (
    <section className="space-y-3" aria-label={t('admin.tab.security')}>
      <form
        className="card space-y-3"
        aria-label={t('admin.password_policy')}
        onSubmit={(e) => {
          e.preventDefault();
          void run(
            () => browserApi.adminSavePasswordPolicy({ minLength: Number(minLength), minScore }),
            t('admin.saved'),
          );
        }}
      >
        <h2 className="text-base font-semibold">{t('admin.password_policy')}</h2>
        <p className="text-sm text-muted">{t('admin.password_policy_hint')}</p>
        <div className="flex flex-wrap items-end gap-3">
          <label>
            <span className="field-label">{t('admin.password_min_length')}</span>
            <input
              className="input w-24"
              type="number"
              min={12}
              max={64}
              disabled={!canChange}
              value={minLength}
              onChange={(e) => setMinLength(e.target.value)}
            />
          </label>
          <label>
            <span className="field-label">{t('admin.password_min_score')}</span>
            <select
              className="input"
              disabled={!canChange}
              value={minScore}
              onChange={(e) => setMinScore(Number(e.target.value))}
            >
              {[0, 1, 2, 3, 4].map((n) => (
                <option key={n} value={n}>
                  {t(`auth.password_strength_${n}`)}
                </option>
              ))}
            </select>
          </label>
          {canChange && (
            <button type="submit" className="btn-secondary" disabled={busy}>
              {t('admin.save')}
            </button>
          )}
        </div>
      </form>
      <StatusLine message={message} />
    </section>
  );
}

/**
 * ADR-0049 §2: the operator's monthly limit on built-in AI across the whole service. A circuit breaker against a bug
 * or abuse: once spent, built-in AI stops for everyone until the month ends, and staff are emailed.
 */
export function AiCeilingPanel({ ceiling, canChange }: { ceiling: AiCeilingDto; canChange: boolean }) {
  const { run, busy, message, t } = useAction();
  const [usd, setUsd] = useState(ceiling.ceilingUsd === null ? '' : String(ceiling.ceilingUsd));
  return (
    <form
      className="card space-y-3"
      aria-label={t('admin.ai_ceiling')}
      onSubmit={(e) => {
        e.preventDefault();
        void run(
          () => browserApi.adminSaveAiCeiling({ ceilingUsd: usd.trim() === '' ? null : Number(usd) }),
          t('admin.saved'),
        );
      }}
    >
      <h2 className="text-base font-semibold">{t('admin.ai_ceiling')}</h2>
      <p className="text-sm text-muted">{t('admin.ai_ceiling_hint')}</p>
      <p className="text-sm" data-testid="ai-ceiling-spent">
        {t('admin.ai_ceiling_spent', { month: ceiling.month, spent: ceiling.spentUsd.toFixed(2) })}
        {ceiling.reached ? ` ${t('admin.ai_ceiling_reached')}` : ''}
      </p>
      <div className="flex flex-wrap items-end gap-3">
        <label>
          <span className="field-label">{t('admin.ai_ceiling_usd')}</span>
          <input
            className="input w-36"
            type="number"
            min={0}
            step="0.01"
            inputMode="decimal"
            placeholder={t('admin.ai_ceiling_none')}
            disabled={!canChange}
            value={usd}
            onChange={(e) => setUsd(e.target.value)}
          />
        </label>
        {canChange && (
          <button type="submit" className="btn-secondary" disabled={busy}>
            {t('admin.save')}
          </button>
        )}
      </div>
      <StatusLine message={message} />
    </form>
  );
}

export function SupportRequestsPanel({ requests }: { requests: AdminSupportRequestDto[] }) {
  const { run, busy, message, t } = useAction();
  return (
    <section className="space-y-3" aria-label={t('admin.tab.support')}>
      {requests.length === 0 && <p className="card text-sm text-muted">{t('admin.no_requests')}</p>}
      {requests.map((r) => (
        <article key={r.id} className="card space-y-1" data-testid="admin-request">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-semibold">
              {r.subject} <span className="chip ml-1">{r.kind}</span>
            </h2>
            <button
              type="button"
              className="btn-secondary"
              disabled={busy}
              onClick={() => run(() => browserApi.adminCloseSupportRequest(r.id))}
            >
              {t('admin.close')}
            </button>
          </div>
          <p className="text-xs text-muted">
            {r.email} · {new Date(r.createdAt).toLocaleString()}
          </p>
          <p className="whitespace-pre-line text-sm">{r.body}</p>
          {r.hasScreenshot && (
            <button
              type="button"
              className="text-sm underline"
              onClick={() =>
                run(async () => {
                  const blob = await browserApi.adminSupportScreenshot(r.id);
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement('a');
                  a.href = url;
                  a.download = `screenshot-${r.id}`;
                  a.click();
                  URL.revokeObjectURL(url);
                })
              }
            >
              {t('admin.screenshot')}
            </button>
          )}
          {Object.keys(r.context).length > 0 && (
            <pre className="overflow-x-auto rounded bg-sunken p-2 text-xs">
              {JSON.stringify(r.context, null, 2)}
            </pre>
          )}
        </article>
      ))}
      <StatusLine message={message} />
    </section>
  );
}

export function ReferencePanel({
  merchants,
  rates,
  canChange,
}: {
  merchants: {
    id: string;
    displayName: string;
    matchKey: string;
    categoryHint: string | null;
    version: number;
  }[];
  rates: { country: string; effectiveFrom: string; tenthsOfCent: number; source: string }[];
  canChange: boolean;
}) {
  const { run, busy, message, t } = useAction();
  const [id, setId] = useState('');
  const [name, setName] = useState('');
  const [key, setKey] = useState('');
  const [hint, setHint] = useState('');
  const [from, setFrom] = useState('');
  const [tenths, setTenths] = useState('');
  const [source, setSource] = useState('');
  return (
    <section className="space-y-3" aria-label={t('admin.tab.reference')}>
      <h2 className="text-base font-semibold">{t('admin.merchants')}</h2>
      {canChange && (
        <form
          className="card flex flex-wrap items-end gap-2"
          aria-label={t('admin.merchant_save')}
          onSubmit={(e) => {
            e.preventDefault();
            void run(
              () =>
                browserApi.adminSaveMerchant({
                  id,
                  displayName: name,
                  matchKey: key,
                  ...(hint ? { categoryHint: hint } : {}),
                }),
              t('admin.saved'),
            );
          }}
        >
          <label>
            <span className="field-label">{t('admin.merchant_id')}</span>
            <input className="input" value={id} onChange={(e) => setId(e.target.value)} />
          </label>
          <label>
            <span className="field-label">{t('admin.merchant_name')}</span>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label>
            <span className="field-label">{t('admin.merchant_key')}</span>
            <input className="input" value={key} onChange={(e) => setKey(e.target.value)} />
          </label>
          <label>
            <span className="field-label">{t('admin.merchant_hint')}</span>
            <input className="input" value={hint} onChange={(e) => setHint(e.target.value)} />
          </label>
          <button type="submit" className="btn-secondary" disabled={busy || !id || !name || !key}>
            {t('admin.merchant_save')}
          </button>
        </form>
      )}
      <ul className="card divide-y divide-line p-0">
        {merchants.map((m) => (
          <li key={m.id} className="px-4 py-2 text-sm" data-testid="admin-merchant">
            {m.displayName}{' '}
            <span className="text-xs text-muted">
              · {m.matchKey} · {m.categoryHint ?? '—'} · v{m.version}
            </span>
          </li>
        ))}
      </ul>
      <h2 className="text-base font-semibold">{t('admin.mileage')}</h2>
      {canChange && (
        <form
          className="card flex flex-wrap items-end gap-2"
          aria-label={t('admin.mileage_save')}
          onSubmit={(e) => {
            e.preventDefault();
            void run(
              () =>
                browserApi.adminSaveMileageRate({
                  country: 'US',
                  effectiveFrom: from,
                  tenthsOfCent: Number(tenths),
                  source,
                }),
              t('admin.saved'),
            );
          }}
        >
          <label>
            <span className="field-label">{t('admin.mileage_from')}</span>
            <input className="input" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </label>
          <label>
            <span className="field-label">{t('admin.mileage_tenths')}</span>
            <input
              className="input w-28"
              type="number"
              min={1}
              value={tenths}
              onChange={(e) => setTenths(e.target.value)}
            />
          </label>
          <label>
            <span className="field-label">{t('admin.mileage_source')}</span>
            <input className="input" value={source} onChange={(e) => setSource(e.target.value)} />
          </label>
          <button type="submit" className="btn-secondary" disabled={busy || !from || !tenths || !source}>
            {t('admin.mileage_save')}
          </button>
        </form>
      )}
      <ul className="card divide-y divide-line p-0">
        {rates.map((r) => (
          <li key={`${r.country}-${r.effectiveFrom}`} className="px-4 py-2 text-sm">
            {r.country} · {r.effectiveFrom} · {r.tenthsOfCent / 10}¢{' '}
            <span className="text-xs text-muted">· {r.source}</span>
          </li>
        ))}
      </ul>
      <StatusLine message={message} />
    </section>
  );
}
