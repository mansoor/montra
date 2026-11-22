'use client';

import { useCallback, useEffect, useState } from 'react';
import type { AdminLogEntryDto, AdminLogQuery, AdminLogStaffDto } from '@montra/api-client';
import { browserApi } from '@/lib/browser-api';
import { friendlyMessage } from '@/lib/errors';
import { STAFF_ACTIONS, fieldLabel, formatAuditValue, staffActionText } from '@/lib/audit-log';
import { useI18n } from '../i18n';

const PAGE = 100;

interface Filters {
  staffId: string;
  action: string;
  subject: string;
  from: string;
  to: string;
}
const NO_FILTERS: Filters = { staffId: '', action: '', subject: '', from: '', to: '' };

/** OPS-01: what staff did, newest first, for admins and owners. Days are UTC. */
export function StaffLogPanel() {
  const { t, locale } = useI18n();
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [subjectDraft, setSubjectDraft] = useState('');
  const [entries, setEntries] = useState<AdminLogEntryDto[]>([]);
  const [staff, setStaff] = useState<AdminLogStaffDto[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (f: Filters, after: string | null) => {
      setLoading(true);
      setError(null);
      const q: AdminLogQuery = {
        limit: PAGE,
        cursor: after ?? undefined,
        staffId: f.staffId || undefined,
        action: f.action || undefined,
        subject: f.subject || undefined,
        from: f.from || undefined,
        to: f.to || undefined,
      };
      try {
        const page = await browserApi.adminLog(q);
        setEntries((prev) => (after ? [...prev, ...page.data] : page.data));
        setStaff(page.staff);
        setCursor(page.nextCursor);
      } catch (err) {
        setError(friendlyMessage(err, t));
      } finally {
        setLoading(false);
      }
    },
    [t],
  );

  useEffect(() => {
    void load(filters, null);
  }, [load, filters]);

  const set = (patch: Partial<Filters>) => setFilters((f) => ({ ...f, ...patch }));
  const filtered = Object.values(filters).some(Boolean);
  const actions = [...STAFF_ACTIONS]
    .map((a) => ({ a, label: staffActionText(a, t) }))
    .sort((x, y) => x.label.localeCompare(y.label, locale));

  return (
    <section className="space-y-3" aria-label={t('admin.tab.log')}>
      <p className="text-sm text-muted">{t('admin.log.intro')}</p>
      <form
        className="card flex flex-wrap items-end gap-3"
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          set({ subject: subjectDraft.trim() });
        }}
      >
        <label>
          <span className="field-label">{t('admin.log.who')}</span>
          <select
            className="input"
            value={filters.staffId}
            onChange={(e) => set({ staffId: e.target.value })}
          >
            <option value="">{t('admin.log.everyone')}</option>
            {staff.map((s) => (
              <option key={s.userId} value={s.userId}>
                {s.email}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span className="field-label">{t('admin.log.action')}</span>
          <select className="input" value={filters.action} onChange={(e) => set({ action: e.target.value })}>
            <option value="">{t('admin.log.any_action')}</option>
            {actions.map(({ a, label }) => (
              <option key={a} value={a}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span className="field-label">{t('admin.log.subject')}</span>
          <input
            className="input"
            type="search"
            value={subjectDraft}
            placeholder={t('admin.log.subject_hint')}
            onChange={(e) => setSubjectDraft(e.target.value)}
          />
        </label>
        <label>
          <span className="field-label">{t('admin.log.from')}</span>
          <input
            className="input"
            type="date"
            value={filters.from}
            max={filters.to || undefined}
            onChange={(e) => set({ from: e.target.value })}
          />
        </label>
        <label>
          <span className="field-label">{t('admin.log.to')}</span>
          <input
            className="input"
            type="date"
            value={filters.to}
            min={filters.from || undefined}
            onChange={(e) => set({ to: e.target.value })}
          />
        </label>
        <button type="submit" className="btn-secondary">
          {t('search.submit')}
        </button>
        {filtered && (
          <button
            type="button"
            className="btn-secondary"
            onClick={() => {
              setSubjectDraft('');
              setFilters(NO_FILTERS);
            }}
          >
            {t('admin.log.clear')}
          </button>
        )}
      </form>
      {error && (
        <p role="alert" className="text-sm text-bad">
          {error}
        </p>
      )}
      {entries.length === 0 && !loading ? (
        <p className="card text-sm text-muted">{t('admin.log.empty')}</p>
      ) : (
        <div className="card-flush overflow-x-auto">
          <table className="tbl">
            <thead>
              <tr>
                <th className="px-3 py-2">{t('admin.log.when')}</th>
                <th className="px-3 py-2">{t('admin.log.who')}</th>
                <th className="px-3 py-2">{t('admin.log.action')}</th>
                <th className="px-3 py-2">{t('admin.log.subject')}</th>
                <th className="px-3 py-2">{t('admin.log.detail')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {entries.map((e) => (
                <tr key={e.id} data-testid="admin-log-row">
                  <td className="whitespace-nowrap px-3 py-2 text-sm">
                    <time dateTime={e.at}>{new Date(e.at).toLocaleString(locale)}</time>
                  </td>
                  <td className="px-3 py-2 text-sm">
                    {e.staffEmail ?? t('admin.log.former_staff')}
                    {e.staffName && e.staffName !== e.staffEmail && (
                      <span className="block text-xs text-muted">{e.staffName}</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-sm">{staffActionText(e.action, t)}</td>
                  <td className="px-3 py-2 text-xs">
                    {e.subject ? (
                      <button
                        type="button"
                        className="break-all text-left underline"
                        title={t('admin.log.only_subject')}
                        onClick={() => {
                          setSubjectDraft(e.subject!);
                          set({ subject: e.subject! });
                        }}
                      >
                        {e.subject}
                      </button>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td className="px-3 py-2 text-xs">
                    {Object.entries(e.detail).map(([k, v]) => (
                      <span key={k} className="block">
                        <span className="text-muted">{fieldLabel(k)}:</span> {formatAuditValue(v)}
                      </span>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {loading && <p className="text-sm text-muted">{t('common.loading')}</p>}
      {cursor && !loading && (
        <button type="button" className="btn-secondary" onClick={() => void load(filters, cursor)}>
          {t('admin.log.more')}
        </button>
      )}
    </section>
  );
}
