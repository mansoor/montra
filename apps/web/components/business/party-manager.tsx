'use client';

import { useState } from 'react';
import type { PartyDto } from '@montra/api-client';
import { browserApi } from '@/lib/browser-api';
import { DateText } from '../i18n';
import { Money } from '../money';
import { StatusLine, useAction } from '../use-action';

/**
 * Customers or vendors (BIZ-04). Anyone with activity is already listed; details are added when they're needed, and
 * saving them creates the record.
 */
export function PartyManager({
  workspaceId,
  entityId,
  currency,
  kind,
  parties,
}: {
  workspaceId: string;
  entityId: string;
  currency: string;
  kind: 'customer' | 'vendor';
  parties: PartyDto[];
}) {
  const { run, busy, message, t } = useAction();
  const [editing, setEditing] = useState<string | null>(null);
  const [form, setForm] = useState({ name: '', email: '', phone: '', address: '', terms: '' });
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));
  const keyOf = (p: PartyDto) => p.id ?? `key:${p.payeeKey}`;

  function start(p?: PartyDto) {
    setEditing(p ? keyOf(p) : 'new');
    setForm({
      name: p?.name ?? '',
      email: p?.email ?? '',
      phone: p?.phone ?? '',
      address: p?.address ?? '',
      terms: p?.termsDays != null ? String(p.termsDays) : '',
    });
  }

  function save(p?: PartyDto) {
    const details = {
      name: form.name.trim(),
      email: form.email.trim() || null,
      phone: form.phone.trim() || null,
      address: form.address.trim() || null,
      termsDays: form.terms.trim() ? Number(form.terms) : null,
    };
    void run(
      () =>
        p?.id
          ? browserApi.updateParty(workspaceId, p.id, { ...details, version: p.version! })
          : browserApi.createParty(workspaceId, {
              entityId,
              kind,
              ...details,
              ...(p?.payeeKey ? { payeeKey: p.payeeKey } : {}),
            }),
      t('parties.saved', { name: details.name }),
    ).then((r) => {
      if (r) setEditing(null);
    });
  }

  const fields = (p?: PartyDto) => (
    <form
      className="grid gap-3 rounded-md border border-line p-3 sm:grid-cols-2 lg:grid-cols-3"
      aria-label={t('parties.details_for', { name: form.name || t(`parties.new_${kind}`) })}
      onSubmit={(e) => {
        e.preventDefault();
        save(p);
      }}
    >
      <label>
        <span className="field-label">{t('parties.name')}</span>
        <input className="input" required maxLength={200} value={form.name} onChange={set('name')} />
      </label>
      <label>
        <span className="field-label">{t('parties.email')}</span>
        <input className="input" type="email" value={form.email} onChange={set('email')} />
      </label>
      <label>
        <span className="field-label">{t('parties.phone')}</span>
        <input className="input" maxLength={50} value={form.phone} onChange={set('phone')} />
      </label>
      <label>
        <span className="field-label">{t('parties.address')}</span>
        <input className="input" maxLength={1000} value={form.address} onChange={set('address')} />
      </label>
      <label>
        <span className="field-label">{t('parties.terms')}</span>
        <input className="input" type="number" min={0} max={365} value={form.terms} onChange={set('terms')} />
      </label>
      <div className="flex items-end gap-2">
        <button type="submit" className="btn-primary" disabled={busy}>
          {t('parties.save')}
        </button>
        <button type="button" className="btn-ghost" onClick={() => setEditing(null)}>
          {t('common.cancel')}
        </button>
      </div>
    </form>
  );

  return (
    <div className="space-y-4">
      <div>
        {editing === 'new' ? (
          fields()
        ) : (
          <button type="button" className="btn-secondary" onClick={() => start()}>
            {t(`parties.add_${kind}`)}
          </button>
        )}
      </div>
      <StatusLine message={message} />
      {parties.length === 0 ? (
        <p className="card text-sm text-muted">{t(`parties.empty_${kind}`)}</p>
      ) : (
        <ul className="card-flush divide-y divide-line">
          {parties.map((p) => (
            <li key={keyOf(p)} className="space-y-2 px-4 py-3" data-testid="party-row">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-medium">
                    {p.name}
                    {p.id === null && <span className="chip ml-2">{t('parties.from_transactions')}</span>}
                    {p.archived && <span className="chip ml-2">{t('common.archived')}</span>}
                  </p>
                  <p className="text-xs text-muted">
                    {[p.email, p.phone].filter(Boolean).join(' · ')}
                    {p.lastActivity && (
                      <>
                        {p.email || p.phone ? ' · ' : ''}
                        {t('parties.last_activity')} <DateText date={p.lastActivity} />
                      </>
                    )}
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-right text-sm">
                    <Money amount={p.yearTotal} currency={currency} />
                    <span className="block text-xs text-muted">{t(`parties.year_total_${kind}`)}</span>
                  </span>
                  <button type="button" className="text-sm underline" onClick={() => start(p)}>
                    {p.id ? t('parties.edit') : t('parties.add_details')}
                  </button>
                </div>
              </div>
              {editing === keyOf(p) && fields(p)}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
