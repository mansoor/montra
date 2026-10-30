'use client';

import { useState, type FormEvent } from 'react';
import type { EntityDetailDto, PeriodLockEventDto } from '@montra/api-client';
import { browserApi } from '@/lib/browser-api';
import { StatusLine, useAction } from '../use-action';
import { useI18n } from '../i18n';

/** Entities (ACC-01, BIZ-01) and period close (DE-09). */
export function EntitySettings({
  workspaceId,
  entities,
  history,
  isOwner,
  today,
}: {
  workspaceId: string;
  entities: EntityDetailDto[];
  history: Record<string, PeriodLockEventDto[]>;
  isOwner: boolean;
  today: string;
}) {
  const { busy, message, run, t } = useAction();
  const [type, setType] = useState<'business' | 'rental'>('business');

  async function onAdd(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const name = String(new FormData(form).get('name') ?? '').trim();
    const created = await run(
      () => browserApi.createEntity(workspaceId, { type, name }),
      (r) => t('entities.added', { name: r.name }),
    );
    if (created) form.reset();
  }

  return (
    <div className="space-y-4">
      {entities.map((e) => (
        <EntityCard
          key={e.id}
          workspaceId={workspaceId}
          entity={e}
          history={history[e.id] ?? []}
          isOwner={isOwner}
          today={today}
        />
      ))}
      {isOwner && (
        <form
          onSubmit={onAdd}
          className="card flex flex-wrap items-end gap-3"
          aria-label={t('entities.add_books')}
        >
          <div>
            <label htmlFor="ent-type" className="field-label">
              {t('entities.add')}
            </label>
            <select
              id="ent-type"
              className="input"
              value={type}
              onChange={(e) => setType(e.target.value as 'business' | 'rental')}
            >
              <option value="business">{t('entity.type.business')}</option>
              <option value="rental">{t('entity.type.rental')}</option>
            </select>
          </div>
          <div className="min-w-48 flex-1">
            <label htmlFor="ent-name" className="field-label">
              {t('fields.name')}
            </label>
            <input id="ent-name" name="name" className="input" required maxLength={200} />
          </div>
          <button type="submit" className="btn-primary" disabled={busy}>
            {t('entities.add_books')}
          </button>
          <div className="w-full">
            <StatusLine message={message} />
          </div>
        </form>
      )}
    </div>
  );
}

function EntityCard({
  workspaceId,
  entity,
  history,
  isOwner,
  today,
}: {
  workspaceId: string;
  entity: EntityDetailDto;
  history: PeriodLockEventDto[];
  isOwner: boolean;
  today: string;
}) {
  const { busy, message, run, t } = useAction();
  const { date } = useI18n();
  const [name, setName] = useState(entity.name);
  const [lockDate, setLockDate] = useState(today);
  const [lockNote, setLockNote] = useState('');
  const [reopenNote, setReopenNote] = useState('');
  const locked = entity.lockedThrough;
  const id = entity.id;

  return (
    <section className="card space-y-4" aria-labelledby={`ent-${id}`}>
      <div className="flex flex-wrap items-center gap-2">
        <h2 id={`ent-${id}`} className="text-base font-semibold">
          {entity.name}
        </h2>
        <span className="text-sm text-muted">
          {t(`entity.type.${entity.type}`)} · {entity.functionalCurrency}
          {entity.archived && ` · ${t('common.archived')}`}
        </span>
        <span className="ml-auto text-sm" data-testid={`lock-${id}`}>
          {locked ? t('entities.closed_through', { date: date(locked) }) : t('entities.open')}
        </span>
      </div>

      {isOwner && (
        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-48 flex-1">
            <label htmlFor={`name-${id}`} className="field-label">
              {t('fields.name')}
            </label>
            <input
              id={`name-${id}`}
              className="input"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <button
            type="button"
            className="btn-secondary"
            disabled={busy || name.trim() === entity.name || !name.trim()}
            onClick={() =>
              run(() => browserApi.updateEntity(workspaceId, id, { name: name.trim() }), t('common.renamed'))
            }
          >
            {t('common.rename')}
          </button>
          {entity.type !== 'personal' && (
            <button
              type="button"
              className="btn-secondary"
              disabled={busy}
              onClick={() =>
                run(
                  () => browserApi.updateEntity(workspaceId, id, { archived: !entity.archived }),
                  entity.archived ? t('common.unarchived') : t('common.archived_kept'),
                )
              }
            >
              {entity.archived ? t('common.unarchive') : t('common.archive')}
            </button>
          )}
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        <fieldset className="space-y-2 rounded-md border border-line p-3">
          <legend className="px-1 text-sm font-medium">{t('entities.close_title')}</legend>
          <div className="flex flex-wrap items-end gap-2">
            <div>
              <label htmlFor={`lock-date-${id}`} className="field-label">
                {t('entities.through')}
              </label>
              <input
                id={`lock-date-${id}`}
                type="date"
                className="input"
                value={lockDate}
                onChange={(e) => setLockDate(e.target.value)}
              />
            </div>
            <div className="min-w-40 flex-1">
              <label htmlFor={`lock-note-${id}`} className="field-label">
                {t('entities.note_optional')}
              </label>
              <input
                id={`lock-note-${id}`}
                className="input"
                value={lockNote}
                onChange={(e) => setLockNote(e.target.value)}
              />
            </div>
            <button
              type="button"
              className="btn-primary"
              disabled={busy || !lockDate}
              onClick={() =>
                run(
                  () =>
                    browserApi.lockPeriod(workspaceId, id, {
                      lockedThrough: lockDate,
                      note: lockNote || undefined,
                    }),
                  t('entities.closed_message', { date: date(lockDate) }),
                )
              }
            >
              {t('entities.close')}
            </button>
          </div>
        </fieldset>
        {locked && isOwner && (
          <fieldset className="space-y-2 rounded-md border border-line p-3">
            <legend className="px-1 text-sm font-medium">{t('entities.reopen_title')}</legend>
            <div className="flex flex-wrap items-end gap-2">
              <div className="min-w-40 flex-1">
                <label htmlFor={`reopen-${id}`} className="field-label">
                  {t('entities.reopen_reason')}
                </label>
                <input
                  id={`reopen-${id}`}
                  className="input"
                  value={reopenNote}
                  onChange={(e) => setReopenNote(e.target.value)}
                />
              </div>
              <button
                type="button"
                className="btn-secondary"
                disabled={busy || reopenNote.trim().length < 3}
                onClick={() =>
                  run(
                    () => browserApi.unlockPeriod(workspaceId, id, reopenNote.trim()),
                    t('entities.reopened'),
                  )
                }
              >
                {t('entities.reopen')}
              </button>
            </div>
          </fieldset>
        )}
      </div>

      {history.length > 0 && (
        <details>
          <summary className="cursor-pointer text-sm text-muted">
            {t('entities.history', { count: history.length })}
          </summary>
          <ul className="mt-2 space-y-1 text-sm">
            {history.map((h, i) => (
              <li key={i}>
                <time dateTime={h.at}>{new Date(h.at).toLocaleString()}</time> ·{' '}
                {t(`entities.action.${h.action}`)}
                {h.lockedThrough && ` ${t('entities.through_date', { date: date(h.lockedThrough) })}`}
                {h.note && ` — ${h.note}`}
              </li>
            ))}
          </ul>
        </details>
      )}
      <StatusLine message={message} />
    </section>
  );
}
