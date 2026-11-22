'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { AuditActorType, AuditEntryDto, AuditLogQuery, MemberDto } from '@montra/api-client';
import { browserApi } from '@/lib/browser-api';
import { friendlyMessage } from '@/lib/errors';
import {
  AUDIT_SUBJECT_TYPES,
  auditActionText,
  auditChanges,
  auditRecordName,
  auditWho,
  fieldLabel,
  formatAuditValue,
  groupAuditEntries,
  subjectTypeLabel,
} from '@/lib/audit-log';
import { useI18n } from '../i18n';

const PAGE = 100;

interface Filters {
  who: string;
  subjectType: string;
  from: string;
  to: string;
  bookkeeping: boolean;
  /** One record's whole history, opened from a row. */
  subject: { id: string; label: string } | null;
}

const NO_FILTERS: Filters = { who: '', subjectType: '', from: '', to: '', bookkeeping: false, subject: null };

/** `who` is a person's id, or `type:worker` / `type:support` for work nobody did by hand. */
function toQuery(f: Filters, cursor: string | null): AuditLogQuery {
  const actorType = f.who.startsWith('type:') ? (f.who.slice(5) as AuditActorType) : undefined;
  return {
    limit: PAGE,
    cursor: cursor ?? undefined,
    actorUserId: f.who && !actorType ? f.who : undefined,
    actorType,
    subjectType: f.subjectType || undefined,
    subjectId: f.subject?.id,
    from: f.from || undefined,
    to: f.to || undefined,
    // A record's own history shows everything about it.
    bookkeeping: f.bookkeeping || f.subject ? 'show' : 'hide',
  };
}

/**
 * The workspace audit log (NFR-03), for owners and admins: who changed what and when, newest first. The ledger's own
 * bookkeeping (journal lines, the chart of accounts) is hidden unless asked for, and rows one save wrote are shown
 * together.
 */
export function AuditLog({ workspaceId, members }: { workspaceId: string; members: MemberDto[] }) {
  const { t, locale } = useI18n();
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [entries, setEntries] = useState<AuditEntryDto[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (f: Filters, after: string | null) => {
      setLoading(true);
      setError(null);
      try {
        const page = await browserApi.getAuditLog(workspaceId, toQuery(f, after));
        setEntries((prev) => (after ? [...prev, ...page.data] : page.data));
        setCursor(page.nextCursor);
      } catch (err) {
        setError(friendlyMessage(err, t));
      } finally {
        setLoading(false);
      }
    },
    [workspaceId, t],
  );

  useEffect(() => {
    void load(filters, null);
  }, [load, filters]);

  const set = (patch: Partial<Filters>) => {
    setOpen(null);
    setFilters((f) => ({ ...f, ...patch }));
  };

  const recordTypes = useMemo(
    () =>
      AUDIT_SUBJECT_TYPES.map((type) => ({ type, label: subjectTypeLabel(type, t) })).sort((a, b) =>
        a.label.localeCompare(b.label, locale),
      ),
    [t, locale],
  );
  const people = members.filter((m) => m.status !== 'invited');
  const groups = groupAuditEntries(entries);
  const when = (iso: string) => new Date(iso).toLocaleString(locale);
  const filtered =
    filters.who ||
    filters.subjectType ||
    filters.from ||
    filters.to ||
    filters.bookkeeping ||
    filters.subject;

  return (
    <section className="space-y-3" aria-labelledby="audit-log-title">
      <div>
        <h2 id="audit-log-title" className="text-lg font-semibold">
          {t('audit.title')}
        </h2>
        <p className="text-sm text-muted">{t('audit.intro')}</p>
      </div>

      <form
        className="card flex flex-wrap items-end gap-3"
        role="search"
        onSubmit={(e) => e.preventDefault()}
      >
        <label>
          <span className="field-label">{t('audit.filter.who')}</span>
          <select className="input" value={filters.who} onChange={(e) => set({ who: e.target.value })}>
            <option value="">{t('audit.filter.everyone')}</option>
            {people.map((m) => (
              <option key={m.userId} value={m.userId}>
                {m.displayName || m.email}
              </option>
            ))}
            <option value="type:worker">{t('audit.who.worker')}</option>
            <option value="type:support">{t('audit.who.support')}</option>
          </select>
        </label>
        <label>
          <span className="field-label">{t('audit.filter.record')}</span>
          <select
            className="input"
            value={filters.subjectType}
            onChange={(e) => set({ subjectType: e.target.value })}
          >
            <option value="">{t('audit.filter.any_record')}</option>
            {recordTypes.map((r) => (
              <option key={r.type} value={r.type}>
                {r.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span className="field-label">{t('audit.filter.from')}</span>
          <input
            className="input"
            type="date"
            value={filters.from}
            max={filters.to || undefined}
            onChange={(e) => set({ from: e.target.value })}
          />
        </label>
        <label>
          <span className="field-label">{t('audit.filter.to')}</span>
          <input
            className="input"
            type="date"
            value={filters.to}
            min={filters.from || undefined}
            onChange={(e) => set({ to: e.target.value })}
          />
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={filters.bookkeeping}
            onChange={(e) => set({ bookkeeping: e.target.checked })}
          />
          {t('audit.filter.bookkeeping')}
        </label>
        {filtered && (
          <button type="button" className="btn-secondary" onClick={() => set(NO_FILTERS)}>
            {t('audit.filter.clear')}
          </button>
        )}
      </form>
      {!filters.bookkeeping && !filters.subject && (
        <p className="text-xs text-muted">{t('audit.bookkeeping_hint')}</p>
      )}
      {filters.subject && (
        <p className="text-sm" data-testid="audit-record-history">
          {t('audit.record_history', { record: filters.subject.label })}{' '}
          <button type="button" className="underline" onClick={() => set({ subject: null })}>
            {t('audit.record_history_close')}
          </button>
        </p>
      )}

      {error && (
        <p role="alert" className="text-sm text-bad">
          {error}
        </p>
      )}
      {groups.length === 0 && !loading ? (
        <p className="card text-sm text-muted">{filtered ? t('audit.empty_filtered') : t('audit.empty')}</p>
      ) : (
        <ol className="card divide-y divide-line p-0" aria-label={t('audit.title')}>
          {groups.map((g) => {
            const head = g.entries[0]!;
            return (
              <li key={g.key} className="space-y-1 px-3 py-2" data-testid="audit-group">
                <p className="text-xs text-muted">
                  <time dateTime={head.at}>{when(head.at)}</time> · {auditWho(head, t)}
                </p>
                <ul className="space-y-1">
                  {g.entries.map((e) => {
                    const name = auditRecordName(e);
                    const changes = auditChanges(e);
                    const record = `${subjectTypeLabel(e.subjectType, t)}${name ? ` “${name}”` : ''}`;
                    return (
                      <li key={e.id} className="text-sm" data-testid="audit-row">
                        <div className="flex flex-wrap items-baseline gap-x-2">
                          <span className="font-medium">{auditActionText(e, t)}</span>
                          {name && <span className="text-muted">{name}</span>}
                          {changes.length > 0 && (
                            <button
                              type="button"
                              className="text-xs underline"
                              aria-expanded={open === e.id}
                              onClick={() => setOpen(open === e.id ? null : e.id)}
                            >
                              {open === e.id ? t('audit.hide_details') : t('audit.details')}
                            </button>
                          )}
                          {e.subjectId && !filters.subject && (
                            <button
                              type="button"
                              className="text-xs underline"
                              onClick={() => set({ subject: { id: e.subjectId!, label: record } })}
                            >
                              {t('audit.record_history_open')}
                            </button>
                          )}
                        </div>
                        {open === e.id && (
                          <dl className="mt-1 grid grid-cols-[minmax(8rem,auto)_1fr] gap-x-3 gap-y-0.5 text-xs">
                            {changes.map((c) => (
                              <div key={c.field} className="contents">
                                <dt className="text-muted">{fieldLabel(c.field)}</dt>
                                <dd className="break-words">
                                  {'before' in c && 'after' in c
                                    ? t('audit.changed_from_to', {
                                        before: formatAuditValue(c.before),
                                        after: formatAuditValue(c.after),
                                      })
                                    : formatAuditValue('after' in c ? c.after : c.before)}
                                </dd>
                              </div>
                            ))}
                          </dl>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </li>
            );
          })}
        </ol>
      )}
      {loading && <p className="text-sm text-muted">{t('common.loading')}</p>}
      {cursor && !loading && (
        <button type="button" className="btn-secondary" onClick={() => void load(filters, cursor)}>
          {t('audit.more')}
        </button>
      )}
    </section>
  );
}
