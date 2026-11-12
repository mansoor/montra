'use client';

import { useMemo, useState, type FormEvent } from 'react';
import type { CategoryDto, CategoryGroupDto, EntityDetailDto, TaxLineDto } from '@montra/api-client';
import { browserApi } from '@/lib/browser-api';
import { StatusLine, useAction } from '../use-action';

type Kind = 'income' | 'expense';

/** The group a new spending category usually goes in, by kind of books (as the API defaults). */
const USUAL_SPENDING: Record<string, CategoryGroupDto['kind']> = {
  personal: 'daily',
  business: 'business',
  rental: 'rental',
};

/**
 * Settings → Categories (ACC-08..10): each set of books' categories by group, with add, rename, move and archive.
 * Nothing is deleted: an archived category leaves the pickers and keeps its history. Built-in ones are listed, fixed.
 */
export function CategorySettings({
  workspaceId,
  entities,
  categories,
  groups,
  taxLines,
}: {
  workspaceId: string;
  entities: Pick<EntityDetailDto, 'id' | 'name' | 'type'>[];
  categories: CategoryDto[];
  groups: CategoryGroupDto[];
  /** Schedule C lines for business books and Schedule E for rental books. */
  taxLines: { business: TaxLineDto[]; rental: TaxLineDto[] };
}) {
  const { busy, message, run, t } = useAction();
  const [entityId, setEntityId] = useState(entities[0]?.id ?? '');
  const [showArchived, setShowArchived] = useState(false);
  const [kind, setKind] = useState<Kind>('expense');
  const entity = entities.find((e) => e.id === entityId);
  const mine = categories.filter((c) => c.entityId === entityId);
  const myGroups = groups.filter((g) => g.entityId === entityId);
  const lines =
    entity?.type === 'business' ? taxLines.business : entity?.type === 'rental' ? taxLines.rental : [];
  const groupsFor = (k: Kind) => myGroups.filter((g) => (g.kind === 'income') === (k === 'income'));
  // In the add form the usual group comes first, so it is the one chosen unless the user picks another.
  const usual = kind === 'income' ? 'income' : USUAL_SPENDING[entity?.type ?? 'personal'];
  const addGroups = [...groupsFor(kind)].sort((a, b) => Number(b.kind === usual) - Number(a.kind === usual));
  const archived = mine.filter((c) => c.archived);
  const builtIn = mine.filter((c) => c.fixed && !c.archived);

  async function onAdd(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    const created = await run(
      () =>
        browserApi.createCategory(workspaceId, {
          entityId,
          name: String(f.get('name') ?? '').trim(),
          type: kind,
          groupId: String(f.get('groupId') ?? '') || undefined,
        }),
      (c) => t('categories.added', { name: c.name }),
    );
    if (created) form.reset();
  }

  return (
    <div className="space-y-6">
      <section className="card space-y-4" aria-labelledby="cat-heading">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 id="cat-heading" className="text-base font-semibold">
              {t('settings.tab.categories')}
            </h2>
            <p className="text-sm text-muted">{t('categories.intro')}</p>
          </div>
          {entities.length > 1 && (
            <div>
              <label htmlFor="cat-entity" className="field-label">
                {t('categories.books')}
              </label>
              <select
                id="cat-entity"
                className="input"
                value={entityId}
                onChange={(e) => setEntityId(e.target.value)}
              >
                {entities.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.name}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>

        <form
          onSubmit={onAdd}
          className="flex flex-wrap items-end gap-2 rounded-[var(--radius-m)] border border-line p-3"
          aria-label={t('categories.add_label')}
        >
          <div className="min-w-48 flex-1">
            <label htmlFor="cat-name" className="field-label">
              {t('categories.new_name')}
            </label>
            <input id="cat-name" name="name" className="input" required maxLength={80} />
          </div>
          <div>
            <label htmlFor="cat-kind" className="field-label">
              {t('fields.type')}
            </label>
            <select
              id="cat-kind"
              className="input"
              value={kind}
              onChange={(e) => setKind(e.target.value as Kind)}
            >
              <option value="expense">{t('categories.kind.expense')}</option>
              <option value="income">{t('categories.kind.income')}</option>
            </select>
          </div>
          <div>
            <label htmlFor="cat-group" className="field-label">
              {t('categories.group')}
            </label>
            <select id="cat-group" name="groupId" className="input" key={`${entityId}-${kind}`}>
              {addGroups.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </select>
          </div>
          <button type="submit" className="btn-primary" disabled={busy || !entityId}>
            {t('categories.add')}
          </button>
        </form>
        <StatusLine message={message} />

        {myGroups.map((g) => {
          const list = mine.filter((c) => c.groupId === g.id && !c.archived);
          return (
            <div key={g.id}>
              <h3 className="section-h mb-1">{g.name}</h3>
              {list.length === 0 ? (
                <p className="text-sm text-muted">{t('categories.none_in_group')}</p>
              ) : (
                <ul className="divide-y divide-line" data-testid={`category-group-${g.name}`}>
                  {list.map((c) => (
                    <CategoryRow
                      key={c.id}
                      workspaceId={workspaceId}
                      category={c}
                      groups={groupsFor(c.type)}
                      taxLines={lines}
                    />
                  ))}
                </ul>
              )}
            </div>
          );
        })}

        {builtIn.length > 0 && (
          <div>
            <h3 className="section-h mb-1">{t('categories.built_in')}</h3>
            <p className="mb-1 text-sm text-muted">{t('categories.built_in_hint')}</p>
            <ul className="flex flex-wrap gap-1.5">
              {builtIn.map((c) => (
                <li key={c.id} className="chip">
                  {c.name}
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      <section className="card space-y-3" aria-labelledby="cat-archived">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="cat-archived" className="text-base font-semibold">
            {t('categories.archived_title', { count: archived.length })}
          </h2>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={showArchived}
              onChange={(e) => setShowArchived(e.target.checked)}
            />
            {t('categories.show_archived')}
          </label>
        </div>
        <p className="text-sm text-muted">{t('categories.archived_hint')}</p>
        {showArchived &&
          (archived.length === 0 ? (
            <p className="text-sm text-muted">{t('categories.none_archived')}</p>
          ) : (
            <ul className="divide-y divide-line" data-testid="archived-categories">
              {archived.map((c) => (
                <ArchivedRow key={c.id} workspaceId={workspaceId} category={c} />
              ))}
            </ul>
          ))}
      </section>
    </div>
  );
}

function CategoryRow({
  workspaceId,
  category,
  groups,
  taxLines,
}: {
  workspaceId: string;
  category: CategoryDto;
  groups: CategoryGroupDto[];
  taxLines: TaxLineDto[];
}) {
  const { busy, message, run, t } = useAction();
  const [name, setName] = useState(category.name);
  const dirty = name.trim() !== category.name && name.trim() !== '';
  const lineOptions = useMemo(
    () => (category.taxLineCode && !taxLines.some((l) => l.code === category.taxLineCode) ? [] : taxLines),
    [category.taxLineCode, taxLines],
  );
  return (
    <li className="flex flex-wrap items-end gap-2 py-2.5" data-testid="category-row">
      <form
        className="flex min-w-48 flex-1 items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (dirty)
            void run(
              () => browserApi.updateCategory(workspaceId, category.id, { name: name.trim() }),
              (c) => t('categories.renamed', { name: c.name }),
            );
        }}
      >
        <div className="flex-1">
          <label htmlFor={`cat-${category.id}`} className="sr-only">
            {t('categories.name_of', { name: category.name })}
          </label>
          <input
            id={`cat-${category.id}`}
            className="input"
            value={name}
            maxLength={80}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        {dirty && (
          <button type="submit" className="btn-secondary" disabled={busy}>
            {t('common.save')}
          </button>
        )}
      </form>
      {groups.length > 1 && (
        <div>
          <label htmlFor={`cat-g-${category.id}`} className="sr-only">
            {t('categories.group_of', { name: category.name })}
          </label>
          <select
            id={`cat-g-${category.id}`}
            className="input"
            value={category.groupId ?? ''}
            disabled={busy}
            onChange={(e) =>
              run(
                () => browserApi.updateCategory(workspaceId, category.id, { groupId: e.target.value }),
                t('categories.moved', { name: category.name }),
              )
            }
          >
            {groups.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </select>
        </div>
      )}
      {lineOptions.length > 0 && (
        <div>
          <label htmlFor={`cat-t-${category.id}`} className="sr-only">
            {t('categories.tax_line_of', { name: category.name })}
          </label>
          <select
            id={`cat-t-${category.id}`}
            className="input max-w-64"
            value={category.taxLineCode ?? ''}
            disabled={busy}
            onChange={(e) =>
              run(
                () => browserApi.setTaxLine(workspaceId, category.id, e.target.value || null),
                t('categories.tax_line_set', { name: category.name }),
              )
            }
          >
            <option value="">{t('categories.no_tax_line')}</option>
            {lineOptions.map((l) => (
              <option key={l.code} value={l.code}>
                {t('categories.tax_line', { line: l.line, label: l.label })}
              </option>
            ))}
          </select>
        </div>
      )}
      <button
        type="button"
        className="btn-ghost"
        disabled={busy}
        aria-label={t('categories.archive_name', { name: category.name })}
        onClick={() =>
          run(
            () => browserApi.updateCategory(workspaceId, category.id, { archived: true }),
            t('categories.archived', { name: category.name }),
          )
        }
      >
        {t('categories.archive')}
      </button>
      <div className="basis-full">
        <StatusLine message={message} />
      </div>
    </li>
  );
}

function ArchivedRow({ workspaceId, category }: { workspaceId: string; category: CategoryDto }) {
  const { busy, message, run, t } = useAction();
  return (
    <li className="flex flex-wrap items-center justify-between gap-2 py-2">
      <span className="text-sm">
        {category.name}
        {category.group && <span className="text-muted"> · {category.group}</span>}
      </span>
      <button
        type="button"
        className="btn-secondary"
        disabled={busy}
        aria-label={t('categories.unarchive_name', { name: category.name })}
        onClick={() =>
          run(
            () => browserApi.updateCategory(workspaceId, category.id, { archived: false }),
            t('categories.unarchived', { name: category.name }),
          )
        }
      >
        {t('categories.unarchive')}
      </button>
      <div className="basis-full">
        <StatusLine message={message} />
      </div>
    </li>
  );
}
