'use client';

import type {
  AdminAccountDto,
  AdminImportProfileDto,
  AdminSupportRequestDto,
  AdminTaxLineDto,
  AdminWorkspaceDto,
  AiCeilingDto,
  AppVersionsStatusDto,
  PasswordPolicyDto,
  FeatureFlagDto,
  SystemNoticeDto,
} from '@montra/api-client';
import Link from 'next/link';
import { isVersionBelow } from '@montra/domain';
import { useState } from 'react';
import { IMPORT_PROFILE_SOURCES, TAX_LINE_FORMS } from '@montra/schemas';
import { browserApi } from '@/lib/browser-api';
import { bpsToPercent, MAPPING_EXAMPLE, percentToBps, readMappingJson } from '@/lib/reference-data';
import { useI18n } from '../i18n';
import { StatusLine, useAction } from '../use-action';
import { useConfirm } from '../ui/confirm-dialog';

const gb = (bytes: string) => (Number(bytes) / 1024 ** 3).toFixed(2);

/** OPS-01, ADR-0049 §4: finding and managing an account. People and plans only: there's nothing about money to show. */
export function AccountLookup({
  canChange,
  isOwner,
  plans,
}: {
  canChange: boolean;
  isOwner: boolean;
  plans: { key: string; name: string }[];
}) {
  const { run, busy, message, t, locale } = useActionWithLocale();
  const [q, setQ] = useState('');
  const [accounts, setAccounts] = useState<AdminAccountDto[] | null>(null);
  const [workspaces, setWorkspaces] = useState<Record<string, AdminWorkspaceDto[]>>({});
  const search = async () => {
    const rows = await run(() => browserApi.adminAccounts(q));
    if (rows) setAccounts(rows);
  };
  const open = async (id: string) => {
    const rows = await run(() => browserApi.adminAccountWorkspaces(id));
    if (rows) setWorkspaces((w) => ({ ...w, [id]: rows }));
  };
  const date = (iso: string) => new Date(iso).toLocaleDateString(locale);
  return (
    <section className="space-y-3" aria-label={t('admin.tab.accounts')}>
      <form
        className="card flex flex-wrap items-end gap-2"
        role="search"
        onSubmit={async (e) => {
          e.preventDefault();
          await search();
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
                {a.purgeAfter && ` · ${t('admin.closing_until', { date: date(a.purgeAfter) })}`}
              </p>
              {a.suspension && (
                <p className="text-xs text-warn" data-testid="admin-suspended">
                  {t('admin.suspended', {
                    kind: t(`admin.suspend_kind.${a.suspension.kind}`),
                    date: date(a.suspension.at),
                  })}
                  {' · '}
                  {a.suspension.reason}
                </p>
              )}
              {a.purgeHeldSince && (
                <p className="text-xs text-warn" data-testid="admin-deletion-held">
                  {t('admin.deletion_held', { date: date(a.purgeHeldSince) })}
                </p>
              )}
            </div>
            <button type="button" className="btn-secondary" onClick={() => open(a.id)}>
              {t('admin.open')}
            </button>
          </div>
          {canChange && <AccountActions account={a} isOwner={isOwner} onDone={search} />}
          {workspaces[a.id]?.map((w) => (
            <div
              key={w.id}
              className="space-y-1 border-t border-line pt-2 text-sm"
              data-testid="admin-workspace"
            >
              <p className="font-medium">{w.name}</p>
              <p className="text-xs text-muted">
                {w.planName} ({w.plan}) · {w.status}
                {w.provider && ` · ${w.provider}`}
                {w.trialEnd &&
                  w.status === 'trialing' &&
                  ` · ${t('admin.trial_until', { date: date(w.trialEnd) })}`}
                {' · '}
                {gb(w.usedBytes)} / {gb(w.quotaBytes)} GB · {t('admin.members', { count: w.members })}
              </p>
              {w.purgeHeldSince && (
                <p className="text-xs text-warn" data-testid="admin-workspace-deletion-held">
                  {t('admin.deletion_held', { date: date(w.purgeHeldSince) })}
                </p>
              )}
              <div className="flex flex-wrap gap-2">
                {w.supportUntil ? (
                  <Link className="underline" href={`/admin/support/${w.id}`}>
                    {t('admin.support_open')}
                  </Link>
                ) : (
                  <span className="text-xs text-muted">{t('admin.support_none')}</span>
                )}
              </div>
              {canChange && <WorkspaceActions workspace={w} plans={plans} onDone={() => open(a.id)} />}
            </div>
          ))}
        </div>
      ))}
    </section>
  );
}

function useActionWithLocale() {
  const a = useAction();
  const { locale } = useI18n();
  return { ...a, locale };
}

/** Suspend or restore (admin), and close on request (owner). */
function AccountActions({
  account: a,
  isOwner,
  onDone,
}: {
  account: AdminAccountDto;
  isOwner: boolean;
  onDone: () => Promise<void>;
}) {
  const { run, busy, message, t } = useAction();
  const [open, setOpen] = useState<'suspend' | 'close' | null>(null);
  const [kind, setKind] = useState<'abuse' | 'fraud' | 'legal_hold'>('abuse');
  const [reason, setReason] = useState('');
  const [fromEmail, setFromEmail] = useState('');
  const [channel, setChannel] = useState<'email' | 'support_request' | 'phone' | 'letter'>('email');
  const [note, setNote] = useState('');
  const done = async (r: unknown) => {
    if (r !== undefined) {
      setOpen(null);
      await onDone();
    }
  };
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2 text-sm">
        {a.suspension ? (
          <button
            type="button"
            className="underline"
            disabled={busy}
            onClick={async () =>
              done(await run(() => browserApi.adminRestoreAccount(a.id), t('admin.saved')))
            }
          >
            {t('admin.restore')}
          </button>
        ) : (
          <button
            type="button"
            className="underline"
            onClick={() => setOpen(open === 'suspend' ? null : 'suspend')}
          >
            {t('admin.suspend')}
          </button>
        )}
        {isOwner && !a.purgeAfter && (
          <button
            type="button"
            className="underline"
            onClick={() => setOpen(open === 'close' ? null : 'close')}
          >
            {t('admin.close_account')}
          </button>
        )}
      </div>
      {open === 'suspend' && (
        <form
          className="flex flex-wrap items-end gap-2"
          aria-label={t('admin.suspend')}
          onSubmit={async (e) => {
            e.preventDefault();
            await done(
              await run(() => browserApi.adminSuspendAccount(a.id, { kind, reason }), t('admin.saved')),
            );
          }}
        >
          <label>
            <span className="field-label">{t('admin.suspend_why')}</span>
            <select className="input" value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
              {(['abuse', 'fraud', 'legal_hold'] as const).map((k) => (
                <option key={k} value={k}>
                  {t(`admin.suspend_kind.${k}`)}
                </option>
              ))}
            </select>
          </label>
          <label className="grow">
            <span className="field-label">{t('admin.reason')}</span>
            <input
              className="input w-full"
              required
              minLength={3}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </label>
          <button type="submit" className="btn-danger" disabled={busy}>
            {t('admin.suspend')}
          </button>
          <p className="w-full text-xs text-muted">{t('admin.suspend_hint')}</p>
        </form>
      )}
      {open === 'close' && (
        <form
          className="flex flex-wrap items-end gap-2"
          aria-label={t('admin.close_account')}
          onSubmit={async (e) => {
            e.preventDefault();
            await done(
              await run(
                () => browserApi.adminCloseAccount(a.id, { fromEmail, channel, note }),
                t('admin.saved'),
              ),
            );
          }}
        >
          <label>
            <span className="field-label">{t('admin.close_from')}</span>
            <input
              className="input"
              type="email"
              required
              value={fromEmail}
              onChange={(e) => setFromEmail(e.target.value)}
            />
          </label>
          <label>
            <span className="field-label">{t('admin.close_channel')}</span>
            <select
              className="input"
              value={channel}
              onChange={(e) => setChannel(e.target.value as typeof channel)}
            >
              {(['email', 'support_request', 'phone', 'letter'] as const).map((c) => (
                <option key={c} value={c}>
                  {t(`admin.close_channel_${c}`)}
                </option>
              ))}
            </select>
          </label>
          <label className="grow">
            <span className="field-label">{t('admin.close_note')}</span>
            <input className="input w-full" value={note} onChange={(e) => setNote(e.target.value)} />
          </label>
          <button type="submit" className="btn-danger" disabled={busy}>
            {t('admin.close_account')}
          </button>
          <p className="w-full text-xs text-muted">{t('admin.close_hint')}</p>
        </form>
      )}
      <StatusLine message={message} />
    </div>
  );
}

/** Extend a trial, give a plan until a date, or give a Stripe coupon (admin). */
function WorkspaceActions({
  workspace: w,
  plans,
  onDone,
}: {
  workspace: AdminWorkspaceDto;
  plans: { key: string; name: string }[];
  onDone: () => Promise<void>;
}) {
  const { run, busy, message, t } = useAction();
  const [action, setAction] = useState<'' | 'trial' | 'plan' | 'coupon'>('');
  const [days, setDays] = useState('14');
  const [plan, setPlan] = useState(plans.find((p) => p.key !== 'free')?.key ?? 'free');
  const [until, setUntil] = useState('');
  const [coupon, setCoupon] = useState('');
  const [reason, setReason] = useState('');
  const paying = w.provider === 'stripe' && w.status !== 'canceled' && w.status !== 'none';
  const submit = async () => {
    const r =
      action === 'trial'
        ? await run(() => browserApi.adminExtendTrial(w.id, { days: Number(days), reason }), t('admin.saved'))
        : action === 'plan'
          ? await run(
              () => browserApi.adminSetPlan(w.id, { plan, reason, ...(plan === 'free' ? {} : { until }) }),
              t('admin.saved'),
            )
          : await run(() => browserApi.adminGiveCoupon(w.id, { coupon, reason }), t('admin.saved'));
    if (r !== undefined) {
      setAction('');
      await onDone();
    }
  };
  return (
    <form
      className="flex flex-wrap items-end gap-2"
      aria-label={t('admin.workspace_actions', { name: w.name })}
      onSubmit={async (e) => {
        e.preventDefault();
        await submit();
      }}
    >
      <label>
        <span className="field-label">{t('admin.workspace_action')}</span>
        <select className="input" value={action} onChange={(e) => setAction(e.target.value as typeof action)}>
          <option value="" />
          {w.status === 'trialing' && <option value="trial">{t('admin.trial_extend')}</option>}
          {paying ? (
            <option value="coupon">{t('admin.coupon_give')}</option>
          ) : (
            <option value="plan">{t('admin.plan_give')}</option>
          )}
        </select>
      </label>
      {action === 'trial' && (
        <label>
          <span className="field-label">{t('admin.trial_days')}</span>
          <input
            className="input w-20"
            type="number"
            min={1}
            max={30}
            value={days}
            onChange={(e) => setDays(e.target.value)}
          />
        </label>
      )}
      {action === 'plan' && (
        <>
          <label>
            <span className="field-label">{t('admin.plan_name')}</span>
            <select className="input" value={plan} onChange={(e) => setPlan(e.target.value)}>
              {plans.map((p) => (
                <option key={p.key} value={p.key}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          {plan !== 'free' && (
            <label>
              <span className="field-label">{t('admin.plan_until')}</span>
              <input
                className="input"
                type="date"
                required
                value={until}
                onChange={(e) => setUntil(e.target.value)}
              />
            </label>
          )}
        </>
      )}
      {action === 'coupon' && (
        <label>
          <span className="field-label">{t('admin.coupon')}</span>
          <input className="input" required value={coupon} onChange={(e) => setCoupon(e.target.value)} />
        </label>
      )}
      {action && (
        <>
          <label className="grow">
            <span className="field-label">{t('admin.reason')}</span>
            <input
              className="input w-full"
              required
              minLength={3}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </label>
          <button type="submit" className="btn-secondary" disabled={busy}>
            {t('admin.save')}
          </button>
        </>
      )}
      <StatusLine message={message} />
    </form>
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

/** OPS-04: a phone below this server's own minimum is asked to update whatever staff set. */
const inEffect = (staff: string, server: string) => (isVersionBelow(staff, server) ? server : staff);

export function NoticesPanel({
  notices,
  versions,
  canChange,
}: {
  notices: (SystemNoticeDto & { showFrom: string })[];
  versions: AppVersionsStatusDto;
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
        <p className="w-full text-xs text-muted">
          {t('admin.versions_in_effect', {
            server: versions.serverMinimum,
            ios: inEffect(versions.ios, versions.serverMinimum),
            android: inEffect(versions.android, versions.serverMinimum),
          })}
        </p>
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

/**
 * OPS-05: reference data staff change without a release. A row saved here keeps what staff saved through later
 * deploys (the loader leaves it). Currencies aren't here: money math uses the list built into the app.
 */
export function ReferencePanel({
  merchants,
  rates,
  taxLines,
  profiles,
  canChange,
}: {
  merchants: {
    id: string;
    displayName: string;
    matchKey: string;
    categoryHint: string | null;
    version: number;
    staffEditedAt: string | null;
  }[];
  rates: {
    country: string;
    effectiveFrom: string;
    tenthsOfCent: number;
    source: string;
    staffEditedAt: string | null;
  }[];
  taxLines: AdminTaxLineDto[];
  profiles: AdminImportProfileDto[];
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
              {m.staffEditedAt && ` · ${t('admin.staff_edited')}`}
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
            <span className="text-xs text-muted">
              · {r.source}
              {r.staffEditedAt && ` · ${t('admin.staff_edited')}`}
            </span>
          </li>
        ))}
      </ul>
      <StatusLine message={message} />
      <TaxLinesEditor lines={taxLines} canChange={canChange} />
      <ImportProfilesEditor profiles={profiles} canChange={canChange} />
      <p className="text-xs text-muted">{t('admin.currencies_note')}</p>
    </section>
  );
}

/** Tax lines: add or change, never delete (categories hold the code), and a line stays on its form. */
function TaxLinesEditor({ lines, canChange }: { lines: AdminTaxLineDto[]; canChange: boolean }) {
  const { run, busy, message, t } = useAction();
  const blank = {
    country: 'US',
    code: '',
    form: 'schedule_c',
    line: '',
    label: '',
    sortOrder: '',
    percent: '100',
  };
  const [f, setF] = useState(blank);
  const [editing, setEditing] = useState(false);
  const set = (k: keyof typeof blank) => (e: { target: { value: string } }) =>
    setF((x) => ({ ...x, [k]: e.target.value }));
  const bps = percentToBps(f.percent);
  const ready = !!f.code && !!f.line && !!f.label && f.sortOrder !== '' && bps !== null;
  return (
    <>
      <h2 className="text-base font-semibold">{t('admin.tax_lines')}</h2>
      <p className="text-xs text-muted">{t('admin.tax_lines_hint')}</p>
      {canChange && (
        <form
          className="card flex flex-wrap items-end gap-2"
          aria-label={t('admin.tax_line_save')}
          onSubmit={(e) => {
            e.preventDefault();
            if (bps === null) return;
            void run(
              () =>
                browserApi.adminSaveTaxLine({
                  country: f.country,
                  code: f.code,
                  form: f.form as (typeof TAX_LINE_FORMS)[number],
                  line: f.line,
                  label: f.label,
                  sortOrder: Number(f.sortOrder),
                  deductibleBps: bps,
                }),
              t('admin.saved'),
            );
          }}
        >
          <label>
            <span className="field-label">{t('admin.tax_country')}</span>
            <input
              className="input w-16"
              value={f.country}
              maxLength={2}
              readOnly={editing}
              onChange={set('country')}
            />
          </label>
          <label>
            <span className="field-label">{t('admin.tax_code')}</span>
            <input className="input" value={f.code} readOnly={editing} onChange={set('code')} />
          </label>
          <label>
            <span className="field-label">{t('admin.tax_form')}</span>
            <select className="input" value={f.form} disabled={editing} onChange={set('form')}>
              {TAX_LINE_FORMS.map((form) => (
                <option key={form} value={form}>
                  {t(`admin.tax_form.${form}`)}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span className="field-label">{t('admin.tax_line')}</span>
            <input className="input w-20" value={f.line} onChange={set('line')} />
          </label>
          <label>
            <span className="field-label">{t('admin.tax_label')}</span>
            <input className="input" value={f.label} onChange={set('label')} />
          </label>
          <label>
            <span className="field-label">{t('admin.tax_sort')}</span>
            <input
              className="input w-20"
              type="number"
              min={0}
              value={f.sortOrder}
              onChange={set('sortOrder')}
            />
          </label>
          <label>
            <span className="field-label">{t('admin.tax_deductible')}</span>
            <input className="input w-20" inputMode="decimal" value={f.percent} onChange={set('percent')} />
          </label>
          <button type="submit" className="btn-secondary" disabled={busy || !ready}>
            {t('admin.tax_line_save')}
          </button>
          {editing && (
            <button
              type="button"
              className="btn-ghost"
              onClick={() => {
                setF(blank);
                setEditing(false);
              }}
            >
              {t('common.cancel')}
            </button>
          )}
        </form>
      )}
      <ul className="card divide-y divide-line p-0">
        {lines.map((l) => (
          <li
            key={`${l.country}-${l.code}`}
            className="flex items-center justify-between gap-2 px-4 py-2 text-sm"
            data-testid="admin-tax-line"
          >
            <span>
              {l.label}{' '}
              <span className="text-xs text-muted">
                · {l.country} · {t(`admin.tax_form.${formKey(l.form)}`)} {t('admin.tax_line')} {l.line} ·{' '}
                {l.code} · {bpsToPercent(l.deductibleBps)}% · v{l.version}
                {l.staffEditedAt && ` · ${t('admin.staff_edited')}`}
              </span>
            </span>
            {canChange && (
              <button
                type="button"
                className="btn-ghost text-xs"
                onClick={() => {
                  setF({
                    country: l.country,
                    code: l.code,
                    form: l.form,
                    line: l.line,
                    label: l.label,
                    sortOrder: String(l.sortOrder),
                    percent: bpsToPercent(l.deductibleBps),
                  });
                  setEditing(true);
                }}
              >
                {t('common.edit')}
              </button>
            )}
          </li>
        ))}
      </ul>
      <StatusLine message={message} />
    </>
  );
}

const formKey = (form: string): (typeof TAX_LINE_FORMS)[number] =>
  (TAX_LINE_FORMS as readonly string[]).includes(form)
    ? (form as (typeof TAX_LINE_FORMS)[number])
    : 'schedule_c';

/** Bank statement layouts every workspace's importer can use (IMP-04, OPS-05). */
function ImportProfilesEditor({
  profiles,
  canChange,
}: {
  profiles: AdminImportProfileDto[];
  canChange: boolean;
}) {
  const { run, busy, message, setMessage, t } = useAction();
  const { confirm, dialog } = useConfirm();
  const blank = {
    id: '',
    name: '',
    institution: '',
    source: 'bank' as (typeof IMPORT_PROFILE_SOURCES)[number],
    fingerprint: '',
    fileType: 'csv' as 'csv' | 'xlsx',
    sample: '',
    mapping: MAPPING_EXAMPLE,
  };
  const [f, setF] = useState(blank);
  const set = (k: keyof typeof blank) => (e: { target: { value: string } }) =>
    setF((x) => ({ ...x, [k]: e.target.value }));
  const ready = !!f.id && !!f.name && !!f.mapping && (!!f.fingerprint.trim() || !!f.sample.trim());
  return (
    <>
      <h2 className="text-base font-semibold">{t('admin.import_profiles')}</h2>
      <p className="text-xs text-muted">{t('admin.import_profiles_hint')}</p>
      {canChange && (
        <form
          className="card grid gap-2 sm:grid-cols-2"
          aria-label={t('admin.profile_save')}
          onSubmit={(e) => {
            e.preventDefault();
            const checked = readMappingJson(f.mapping);
            if (!checked.ok) {
              setMessage({
                tone: 'bad',
                text:
                  checked.problem === 'json'
                    ? t('admin.mapping_json')
                    : t('admin.mapping_invalid', { problem: checked.problem }),
              });
              return;
            }
            void run(
              () =>
                browserApi.adminSaveImportProfile({
                  id: f.id,
                  name: f.name,
                  ...(f.institution ? { institution: f.institution } : {}),
                  source: f.source,
                  ...(f.fingerprint.trim()
                    ? { fingerprint: f.fingerprint.trim() }
                    : { sample: { fileType: f.fileType, text: f.sample } }),
                  mapping: checked.mapping,
                }),
              (r) => t('admin.profile_saved', { fingerprint: r.fingerprint }),
            );
          }}
        >
          <label>
            <span className="field-label">{t('admin.profile_id')}</span>
            <input className="input w-full" value={f.id} onChange={set('id')} />
          </label>
          <label>
            <span className="field-label">{t('admin.profile_name')}</span>
            <input className="input w-full" value={f.name} onChange={set('name')} />
          </label>
          <label>
            <span className="field-label">{t('admin.profile_institution')}</span>
            <input className="input w-full" value={f.institution} onChange={set('institution')} />
          </label>
          <label>
            <span className="field-label">{t('admin.profile_source')}</span>
            <select className="input w-full" value={f.source} onChange={set('source')}>
              {IMPORT_PROFILE_SOURCES.map((x) => (
                <option key={x} value={x}>
                  {t(`admin.profile_source.${x}`)}
                </option>
              ))}
            </select>
          </label>
          <label className="sm:col-span-2">
            <span className="field-label">{t('admin.profile_fingerprint')}</span>
            <input className="input w-full font-mono" value={f.fingerprint} onChange={set('fingerprint')} />
          </label>
          <label className="sm:col-span-2">
            <span className="field-label">{t('admin.profile_sample')}</span>
            <textarea
              className="input w-full font-mono"
              rows={3}
              value={f.sample}
              disabled={!!f.fingerprint.trim()}
              onChange={set('sample')}
            />
          </label>
          <label>
            <span className="field-label">{t('admin.profile_file_type')}</span>
            <select
              className="input w-full"
              value={f.fileType}
              disabled={!!f.fingerprint.trim()}
              onChange={set('fileType')}
            >
              <option value="csv">CSV</option>
              <option value="xlsx">Excel</option>
            </select>
          </label>
          <label className="sm:col-span-2">
            <span className="field-label">{t('admin.profile_mapping')}</span>
            <textarea
              className="input w-full font-mono"
              rows={10}
              value={f.mapping}
              onChange={set('mapping')}
            />
          </label>
          <div className="sm:col-span-2">
            <button type="submit" className="btn-secondary" disabled={busy || !ready}>
              {t('admin.profile_save')}
            </button>
          </div>
        </form>
      )}
      <ul className="card divide-y divide-line p-0">
        {profiles.map((p) => (
          <li
            key={p.id}
            className="flex items-center justify-between gap-2 px-4 py-2 text-sm"
            data-testid="admin-import-profile"
          >
            <span>
              {p.name}{' '}
              <span className="text-xs text-muted">
                · {p.id} · {p.institution ?? '—'} · {t(`admin.profile_source.${p.source}`)} ·{' '}
                <span className="font-mono">{p.fingerprint}</span> · v{p.version}
                {p.staffEditedAt && ` · ${t('admin.staff_edited')}`}
              </span>
            </span>
            {canChange && (
              <span className="flex gap-1">
                <button
                  type="button"
                  className="btn-ghost text-xs"
                  onClick={() =>
                    setF({
                      ...blank,
                      id: p.id,
                      name: p.name,
                      institution: p.institution ?? '',
                      source: p.source,
                      fingerprint: p.fingerprint,
                      mapping: JSON.stringify(p.mapping, null, 2),
                    })
                  }
                >
                  {t('common.edit')}
                </button>
                <button
                  type="button"
                  className="btn-ghost text-xs text-bad"
                  disabled={busy}
                  onClick={async () => {
                    const ok = await confirm({
                      title: t('admin.profile_delete_title'),
                      body: <p>{t('admin.profile_delete_confirm', { name: p.name })}</p>,
                      confirmLabel: t('admin.profile_delete'),
                      danger: true,
                    });
                    if (ok)
                      void run(() => browserApi.adminDeleteImportProfile(p.id), t('admin.profile_deleted'));
                  }}
                >
                  {t('common.delete')}
                </button>
              </span>
            )}
          </li>
        ))}
      </ul>
      <StatusLine message={message} />
      {dialog}
    </>
  );
}
