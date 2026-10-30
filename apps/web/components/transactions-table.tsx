'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type ReactNode } from 'react';
import type { CategoryDto, FamilyMemberDto, WorkspaceDto } from '@montra/api-client';
import { browserApi } from '@/lib/browser-api';
import { summarizeBulk, toBulkSet, toggleSelection, type BulkAction } from '@/lib/bulk';
import { friendlyMessage } from '@/lib/errors';
import { groupCategories, type TransactionRow } from '@/lib/view-models';
import { ReviewBadge, RowAmount } from './transaction-list';

type BulkKind = BulkAction['kind'];

/**
 * Transaction list with multi-select and a bulk bar (TXN-10): set category, move to another entity (UP-08),
 * set member, add/remove tags, mark reviewed. Trash rows get a Restore button instead.
 */
export function TransactionsTable({
  workspace,
  rows,
  categories,
  members,
  trash,
}: {
  workspace: WorkspaceDto;
  rows: TransactionRow[];
  categories: CategoryDto[];
  members: FamilyMemberDto[];
  trash: boolean;
}) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [kind, setKind] = useState<BulkKind>('reviewed');
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'good' | 'bad'; text: string } | null>(null);
  const visible = rows.map((r) => r.id);
  const groups = groupCategories(workspace, categories);
  const base = `/w/${workspace.id}/transactions`;

  async function applyBulk() {
    const action: BulkAction =
      kind === 'category'
        ? { kind, categoryId: value }
        : kind === 'entity'
          ? { kind, entityId: value }
          : kind === 'member'
            ? { kind, memberId: value || null }
            : kind === 'addTags' || kind === 'removeTags'
              ? { kind, tags: value }
              : { kind: 'reviewed' };
    const set = toBulkSet(action);
    if ('error' in set) return setMessage({ tone: 'bad', text: set.error as string });
    setBusy(true);
    setMessage(null);
    try {
      const result = await browserApi.bulkEdit(workspace.id, { ids: [...selected], set });
      setMessage({ tone: result.skipped.length ? 'bad' : 'good', text: summarizeBulk(result) });
      setSelected(new Set());
      setValue('');
      router.refresh();
    } catch (err) {
      setMessage({ tone: 'bad', text: friendlyMessage(err) });
    } finally {
      setBusy(false);
    }
  }

  async function restore(id: string) {
    setBusy(true);
    try {
      await browserApi.restoreTransaction(workspace.id, id);
      setMessage({ tone: 'good', text: 'Restored.' });
      router.refresh();
    } catch (err) {
      setMessage({ tone: 'bad', text: friendlyMessage(err) });
    } finally {
      setBusy(false);
    }
  }

  if (rows.length === 0) {
    return (
      <div className="space-y-3">
        {message && (
          <p role="status" className={`text-sm ${message.tone === 'good' ? 'text-good' : 'text-bad'}`}>
            {message.text}
          </p>
        )}
        <p className="card text-sm text-muted">{trash ? 'Trash is empty.' : 'No transactions here.'}</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {!trash && (
        <div
          role="region"
          aria-label="Bulk edit"
          className="card flex flex-wrap items-end gap-2"
          data-testid="bulk-bar"
        >
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={selected.size > 0 && selected.size === visible.length}
              onChange={() => setSelected(toggleSelection(selected, 'all', visible))}
              aria-label="Select all"
            />
            <span aria-live="polite">{selected.size} selected</span>
          </label>
          <div>
            <label htmlFor="bulk-kind" className="field-label">
              Action
            </label>
            <select
              id="bulk-kind"
              className="input"
              value={kind}
              onChange={(e) => {
                setKind(e.target.value as BulkKind);
                setValue('');
              }}
            >
              <option value="reviewed">Mark reviewed</option>
              <option value="category">Set category</option>
              <option value="entity">Move to books</option>
              <option value="member">Set family member</option>
              <option value="addTags">Add tags</option>
              <option value="removeTags">Remove tags</option>
            </select>
          </div>
          {kind === 'category' && (
            <BulkField label="Category">
              {(id) => (
                <select id={id} className="input" value={value} onChange={(e) => setValue(e.target.value)}>
                  <option value="">Choose…</option>
                  {groups.map((g) => (
                    <optgroup key={g.label} label={g.label}>
                      {g.categories.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </select>
              )}
            </BulkField>
          )}
          {kind === 'entity' && (
            <BulkField label="Books">
              {(id) => (
                <select id={id} className="input" value={value} onChange={(e) => setValue(e.target.value)}>
                  <option value="">Choose…</option>
                  {workspace.entities.map((e) => (
                    <option key={e.id} value={e.id}>
                      {e.name}
                    </option>
                  ))}
                </select>
              )}
            </BulkField>
          )}
          {kind === 'member' && (
            <BulkField label="Member">
              {(id) => (
                <select id={id} className="input" value={value} onChange={(e) => setValue(e.target.value)}>
                  <option value="">Household</option>
                  {members
                    .filter((m) => m.status === 'active')
                    .map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name}
                      </option>
                    ))}
                </select>
              )}
            </BulkField>
          )}
          {(kind === 'addTags' || kind === 'removeTags') && (
            <BulkField label="Tags (comma separated)">
              {(id) => (
                <input id={id} className="input" value={value} onChange={(e) => setValue(e.target.value)} />
              )}
            </BulkField>
          )}
          <button
            type="button"
            className="btn-primary"
            disabled={busy || selected.size === 0}
            onClick={applyBulk}
          >
            Apply to {selected.size}
          </button>
        </div>
      )}
      {message && (
        <p role="status" className={`text-sm ${message.tone === 'good' ? 'text-good' : 'text-bad'}`}>
          {message.text}
        </p>
      )}
      <ul className="card divide-y divide-line p-0" aria-label="Transactions">
        {rows.map((r) => (
          <li key={r.id} className="flex items-start gap-3 px-4 py-3" data-testid="txn-row">
            {!trash && (
              <input
                type="checkbox"
                className="mt-1"
                checked={selected.has(r.id)}
                onChange={() => setSelected(toggleSelection(selected, r.id, visible))}
                aria-label={`Select ${r.title} on ${r.date}`}
              />
            )}
            <div className="min-w-0 flex-1">
              <p className="truncate font-medium">
                <Link href={`${base}/${r.id}`} className="hover:underline">
                  {r.title}
                </Link>
                {r.needsReview && <ReviewBadge />}
                {r.status === 'scheduled' && (
                  <span className="ml-2 rounded bg-canvas px-1.5 py-0.5 text-xs text-muted">Scheduled</span>
                )}
              </p>
              <p className="truncate text-xs text-muted">
                <time dateTime={r.date}>{r.date}</time> · {r.accountName}
                {r.categories.length > 0 && ` · ${r.categories.join(', ')}`}
                {r.tags.length > 0 && ` · #${r.tags.join(' #')}`}
              </p>
            </div>
            <RowAmount row={r} />
            {trash && (
              <button type="button" className="btn-secondary" disabled={busy} onClick={() => restore(r.id)}>
                Restore
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function BulkField({ label, children }: { label: string; children: (id: string) => ReactNode }) {
  const id = `bulk-${label.replace(/\W+/g, '-').toLowerCase()}`;
  return (
    <div>
      <label htmlFor={id} className="field-label">
        {label}
      </label>
      {children(id)}
    </div>
  );
}
