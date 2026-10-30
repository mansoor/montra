'use client';

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useI18n } from '../i18n';

export interface PickerOption {
  id: string;
  label: string;
  group?: string;
}

/**
 * Type-ahead picker in a modal dialog: type to filter, ↑/↓ to move, Enter to choose, Esc to close. Used by the
 * review queue's `c` (category) and `m` (member) shortcuts.
 */
export function PickerDialog({
  open,
  title,
  options,
  initialId,
  onPick,
  onClose,
}: {
  open: boolean;
  title: string;
  options: PickerOption[];
  initialId?: string | null;
  onPick: (id: string) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const ref = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const titleId = useId();
  const listId = useId();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter(
      (o) => o.label.toLowerCase().includes(q) || (o.group ?? '').toLowerCase().includes(q),
    );
  }, [options, query]);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      setQuery('');
      const i = initialId ? options.findIndex((o) => o.id === initialId) : -1;
      setActive(Math.max(0, i));
      d.showModal();
      inputRef.current?.focus();
    } else if (!open && d.open) d.close();
  }, [open]); // re-seed only when opening

  const choose = (o: PickerOption | undefined) => {
    if (o) onPick(o.id);
  };

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onClose={onClose}
      className="m-auto w-[min(28rem,calc(100vw-2rem))] rounded-lg border border-line bg-surface p-0 text-ink backdrop:bg-black/40"
    >
      <div className="space-y-3 p-4">
        <h2 id={titleId} className="text-base font-semibold">
          {title}
        </h2>
        <input
          ref={inputRef}
          className="input"
          role="combobox"
          aria-expanded="true"
          aria-controls={listId}
          aria-activedescendant={filtered[active] ? `${listId}-${active}` : undefined}
          aria-label={t('review.picker.search')}
          placeholder={t('review.picker.search')}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setActive((a) => Math.min(a + 1, filtered.length - 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setActive((a) => Math.max(a - 1, 0));
            } else if (e.key === 'Enter') {
              e.preventDefault();
              choose(filtered[active]);
            }
          }}
        />
        <ul id={listId} role="listbox" aria-label={title} className="max-h-72 overflow-y-auto text-sm">
          {filtered.map((o, i) => (
            <li
              key={o.id}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === active}
              onMouseEnter={() => setActive(i)}
              onClick={() => choose(o)}
              className={`cursor-pointer rounded px-2 py-1.5 ${i === active ? 'bg-brand-600 text-white' : ''}`}
            >
              {o.label}
              {o.group && (
                <span className={`ml-2 text-xs ${i === active ? 'text-white/80' : 'text-muted'}`}>
                  {o.group}
                </span>
              )}
            </li>
          ))}
          {filtered.length === 0 && <li className="px-2 py-1.5 text-muted">{t('review.picker.none')}</li>}
        </ul>
        <div className="flex justify-end">
          <button type="button" className="btn-secondary" onClick={onClose}>
            {t('common.cancel')}
          </button>
        </div>
      </div>
    </dialog>
  );
}
