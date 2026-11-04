'use client';

import type { BillingDto, SupportGrantDto } from '@montra/api-client';
import { useState } from 'react';
import { browserApi } from '@/lib/browser-api';
import { useI18n } from '../i18n';
import { StatusLine, useAction } from '../use-action';

const when = (iso: string | null, locale: string) =>
  iso ? new Intl.DateTimeFormat(locale, { dateStyle: 'long' }).format(new Date(iso)) : '';

/** UP-12, OPS-08: what this workspace is on. Paying happens at the provider, so card details never come here. */
export function BillingPanel({ workspaceId, billing }: { workspaceId: string; billing: BillingDto }) {
  const { run, busy, message, t } = useAction();
  const { locale } = useI18n();
  const go = async (get: () => Promise<{ url: string }>) => {
    const r = await run(get);
    if (r) window.location.assign(r.url);
  };
  if (billing.mode === 'off') {
    return (
      <section className="card max-w-xl" aria-labelledby="plan-title">
        <h2 id="plan-title" className="text-base font-semibold">
          {t('billing.title')}
        </h2>
        <p className="text-sm text-muted" data-testid="billing-off">
          {t('billing.off')}
        </p>
      </section>
    );
  }
  const pro = billing.plan === 'pro';
  const canBuy = billing.canManage && !(pro && billing.status === 'active');
  return (
    <div className="max-w-xl space-y-4">
      <section className="card space-y-3" aria-labelledby="plan-title">
        <h2 id="plan-title" className="text-base font-semibold">
          {t('billing.title')}
        </h2>
        <p className="text-sm" data-testid="billing-plan">
          {t(pro ? 'billing.plan_pro' : 'billing.plan_free')}
        </p>
        {billing.status === 'trialing' && billing.trialEnd && (
          <p className="text-sm">{t('billing.trial_until', { date: when(billing.trialEnd, locale) })}</p>
        )}
        {billing.status === 'past_due' && billing.graceUntil && (
          <p className="text-sm text-warn" role="status">
            {t('billing.past_due', { date: when(billing.graceUntil, locale) })}
          </p>
        )}
        {billing.status === 'active' && billing.currentPeriodEnd && (
          <p className="text-sm text-muted">
            {t(billing.cancelAtPeriodEnd ? 'billing.ends_on' : 'billing.renews_on', {
              date: when(billing.currentPeriodEnd, locale),
            })}
          </p>
        )}
        {billing.status === 'canceled' && <p className="text-sm text-muted">{t('billing.lapsed')}</p>}
        <ul className="list-inside list-disc text-sm text-muted">
          <li>{t('billing.includes_personal')}</li>
          <li>{t(pro ? 'billing.includes_business' : 'billing.excludes_business')}</li>
          <li>
            {t('billing.includes_storage', {
              gb: Number(BigInt(billing.features.storageBytes) / 1073741824n),
            })}
          </li>
        </ul>
        <div className="flex flex-wrap gap-2">
          {canBuy && (
            <>
              <button
                type="button"
                className="btn-primary"
                disabled={busy}
                onClick={() => go(() => browserApi.startCheckout(workspaceId, { interval: 'month' }))}
              >
                {t('billing.upgrade_monthly')}
              </button>
              <button
                type="button"
                className="btn-secondary"
                disabled={busy}
                onClick={() => go(() => browserApi.startCheckout(workspaceId, { interval: 'year' }))}
              >
                {t('billing.upgrade_yearly')}
              </button>
            </>
          )}
          {billing.canManage && billing.provider === 'stripe' && (
            <button
              type="button"
              className="btn-secondary"
              disabled={busy}
              onClick={() => go(() => browserApi.openBillingPortal(workspaceId))}
            >
              {t('billing.manage')}
            </button>
          )}
        </div>
        {!billing.canManage && <p className="text-sm text-muted">{t('billing.owner_only')}</p>}
        <StatusLine message={message} />
      </section>
    </div>
  );
}

/** OPS-02: letting support look. Read-only, for a limited time, ended whenever the owner says, and every look is logged. */
export function SupportAccessPanel({
  workspaceId,
  grants,
  canManage,
}: {
  workspaceId: string;
  grants: SupportGrantDto[];
  canManage: boolean;
}) {
  const { run, busy, message, t } = useAction();
  const { locale } = useI18n();
  const [hours, setHours] = useState('72');
  const [reason, setReason] = useState('');
  const active = grants.filter((g) => g.active);
  const time = (iso: string) =>
    new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso));
  return (
    <section className="card max-w-xl space-y-3" aria-labelledby="support-title">
      <h2 id="support-title" className="text-base font-semibold">
        {t('support_access.title')}
      </h2>
      <p className="text-sm text-muted">{t('support_access.hint')}</p>
      <ul className="list-inside list-disc text-sm text-muted">
        <li>{t('support_access.sees')}</li>
        <li>{t('support_access.not_sees')}</li>
      </ul>
      {active.map((g) => (
        <div
          key={g.id}
          className="flex flex-wrap items-center justify-between gap-2"
          data-testid="support-grant"
        >
          <p className="text-sm" role="status">
            {t('support_access.active_until', { date: time(g.expiresAt) })}
          </p>
          {canManage && (
            <button
              type="button"
              className="btn-secondary"
              disabled={busy}
              onClick={() =>
                run(() => browserApi.revokeSupportGrant(workspaceId, g.id), t('support_access.ended'))
              }
            >
              {t('support_access.end')}
            </button>
          )}
        </div>
      ))}
      {canManage && active.length === 0 && (
        <form
          className="space-y-3"
          aria-label={t('support_access.allow')}
          onSubmit={(e) => {
            e.preventDefault();
            void run(
              () => browserApi.createSupportGrant(workspaceId, { hours: Number(hours), reason }),
              t('support_access.allowed'),
            ).then((r) => {
              if (r) setReason('');
            });
          }}
        >
          <label className="block">
            <span className="field-label">{t('support_access.how_long')}</span>
            <select className="input" value={hours} onChange={(e) => setHours(e.target.value)}>
              <option value="24">{t('support_access.hours_24')}</option>
              <option value="72">{t('support_access.hours_72')}</option>
              <option value="168">{t('support_access.hours_168')}</option>
            </select>
          </label>
          <label className="block">
            <span className="field-label">{t('support_access.reason')}</span>
            <input
              className="input"
              maxLength={500}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </label>
          <button type="submit" className="btn-primary" disabled={busy}>
            {t('support_access.allow')}
          </button>
        </form>
      )}
      {!canManage && active.length === 0 && (
        <p className="text-sm text-muted">{t('support_access.owner_only')}</p>
      )}
      <StatusLine message={message} />
    </section>
  );
}
