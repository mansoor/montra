'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AccountDto, CategoryDto, FamilyMemberDto, WorkspaceDto } from '@montra/api-client';
import type { PropertyDto, ReviewItemDto, RuleSuggestionDto } from '@montra/schemas';
import { browserApi } from '@/lib/browser-api';
import { friendlyMessage } from '@/lib/errors';
import {
  clampCursor,
  confidenceOf,
  countAtOrAbove,
  isEditableTarget,
  madeTransferMessage,
  parsePropertyPick,
  percent,
  propertyLabel,
  propertyOptions,
  proposedCategoryId,
  proposedProperty,
  proposedTransfer,
  removeItems,
  reviewCommand,
  SHORTCUTS,
  suggestedCategoryId,
  suggestedMemberId,
  transferOptions,
  transferTargets,
} from '@/lib/review';
import { hasFilters, listApiQuery, parseListFilters } from '@/lib/list-filters';
import { groupCategories } from '@/lib/view-models';
import { ConfidenceChip, Explanation, MerchantMark } from '../ai/shared';
import { DateText, useI18n } from '../i18n';
import { ListEmpty, ListFilterBar, ListWindowFooter } from '../list-filter-bar';
import { Money } from '../money';
import { PickerDialog, type PickerOption } from './picker-dialog';
import { RuleOffer } from './rule-offer';

const PAGE = 100;

/**
 * Review queue (AI-03/04, PLT-10): everything the pipeline wasn't sure about, keyboard-first. Accepting keeps
 * the suggestion; picking another category is a correction the app learns from, and after two identical
 * corrections it offers a rule (AI-05).
 */
export function ReviewQueue({
  workspace,
  accounts,
  categories,
  members,
  threshold,
  properties = [],
}: {
  workspace: WorkspaceDto;
  accounts: AccountDto[];
  categories: CategoryDto[];
  members: FamilyMemberDto[];
  threshold: number;
  /** AI-02: the rental properties, to show and change a line's property. */
  properties?: PropertyDto[];
}) {
  const { t, locale } = useI18n();
  // The filter bar's date window, merchant, amount and direction, from the URL.
  const searchKey = useSearchParams().toString();
  const filters = useMemo(() => parseListFilters(new URLSearchParams(searchKey)).filters, [searchKey]);
  const narrow = useMemo(
    () => listApiQuery(filters, { timeZone: workspace.timeZone, currency: workspace.baseCurrency, locale }),
    [filters, workspace.timeZone, workspace.baseCurrency, locale],
  );
  const [older, setOlder] = useState(0);
  const [items, setItems] = useState<ReviewItemDto[]>([]);
  const [total, setTotal] = useState(0);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [cursor, setCursor] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [picker, setPicker] = useState<'category' | 'member' | 'property' | 'transfer' | null>(null);
  const [aboveOpen, setAboveOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [above, setAbove] = useState(percent(threshold));
  const [offer, setOffer] = useState<RuleSuggestionDto | null>(null);
  const [announce, setAnnounce] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const base = `/w/${workspace.id}`;

  const categoryById = useMemo(() => new Map(categories.map((c) => [c.id, c])), [categories]);
  const accountById = useMemo(() => new Map(accounts.map((a) => [a.id, a])), [accounts]);
  const memberById = useMemo(() => new Map(members.map((m) => [m.id, m])), [members]);
  const categoryOptions: PickerOption[] = useMemo(
    () =>
      groupCategories(workspace, categories).flatMap((g) =>
        g.categories.map((c) => ({ id: c.id, label: c.name, group: g.label })),
      ),
    [workspace, categories],
  );
  const memberOptions: PickerOption[] = useMemo(
    () => [
      { id: '', label: t('members.household') },
      ...members.filter((m) => m.status === 'active').map((m) => ({ id: m.id, label: m.name })),
    ],
    [members, t],
  );

  const load = useCallback(
    async (after: string | null) => {
      setLoading(true);
      try {
        const page = await browserApi.listReview(workspace.id, {
          ...narrow,
          cursor: after ?? undefined,
          limit: PAGE,
        });
        setItems((prev) => (after ? [...prev, ...page.items] : page.items));
        setTotal(page.total);
        setNextCursor(page.nextCursor);
        // What the window leaves out still waits for review: say how much.
        if (!after) {
          const { from, ...rest } = narrow;
          setOlder(
            from
              ? Math.max(
                  0,
                  (await browserApi.listReview(workspace.id, { ...rest, limit: 1 })).total - page.total,
                )
              : 0,
          );
        }
      } catch (err) {
        setError(friendlyMessage(err, t));
      } finally {
        setLoading(false);
      }
    },
    [workspace.id, t, narrow],
  );

  useEffect(() => {
    setCursor(0);
    setSelected(new Set());
    void load(null);
  }, [load]);

  const current = items[clampCursor(cursor, items.length)];

  // Keep the active row in view.
  useEffect(() => {
    if (!current) return;
    document.getElementById(`review-${current.transactionId}`)?.scrollIntoView({ block: 'nearest' });
  }, [current]);

  const drop = useCallback(
    (ids: Set<string>) => {
      const next = removeItems(items, ids, cursor);
      setItems(next.items);
      setCursor(next.cursor);
      setTotal((n) => Math.max(0, n - ids.size));
      setSelected((s) => new Set([...s].filter((id) => !ids.has(id))));
    },
    [items, cursor],
  );

  const acceptedMessage = useCallback(
    (r: { accepted: number; transfers: number }) =>
      r.transfers > 0
        ? t('review.accepted_transfers', { count: r.accepted, transfers: r.transfers })
        : t('review.accepted', { count: r.accepted }),
    [t],
  );

  const accept = useCallback(async () => {
    const ids = selected.size
      ? new Set(selected)
      : current
        ? new Set([current.transactionId])
        : new Set<string>();
    if (ids.size === 0) return;
    const before = { items, cursor, total };
    setError(null);
    drop(ids);
    try {
      const r = await browserApi.acceptReview(workspace.id, { transactionIds: [...ids] });
      setAnnounce(acceptedMessage(r));
      if (r.skipped > 0) setError(t('review.skipped', { count: r.skipped }));
      // A transfer absorbs its other side, which may be further down the list.
      if (r.transfers > 0) await load(null);
    } catch (err) {
      setItems(before.items);
      setCursor(before.cursor);
      setTotal(before.total);
      setError(friendlyMessage(err, t));
    }
  }, [selected, current, items, cursor, total, drop, workspace.id, t, load, acceptedMessage]);

  const resolve = useCallback(
    async (
      item: ReviewItemDto,
      categoryId: string,
      memberId: string | null | undefined,
      property?: { propertyId: string | null; unitId: string | null },
    ) => {
      const before = { items, cursor, total };
      setError(null);
      drop(new Set([item.transactionId]));
      try {
        const r = await browserApi.resolveReview(workspace.id, item.transactionId, {
          categoryId,
          ...(memberId !== undefined ? { memberId } : {}),
          ...(property ? { propertyId: property.propertyId, unitId: property.unitId } : {}),
          version: item.version,
        });
        setAnnounce(
          t('review.resolved', {
            payee: item.payee || item.description || t('transactions.no_payee'),
            category: categoryById.get(categoryId)?.name ?? '',
          }),
        );
        if (r.ruleSuggestion) setOffer(r.ruleSuggestion);
      } catch (err) {
        setItems(before.items);
        setCursor(before.cursor);
        setTotal(before.total);
        setError(friendlyMessage(err, t));
      }
    },
    [items, cursor, total, drop, workspace.id, t, categoryById],
  );

  // "Make transfer…" for a line nothing was suggested for: a card or loan payment that carries the payee's ID.
  const transferPick = useMemo(
    () => (current ? transferOptions(transferTargets(accounts, current), t) : []),
    [current, accounts, t],
  );
  const makeTransfer = useCallback(
    async (item: ReviewItemDto, accountId: string) => {
      const before = { items, cursor, total };
      setError(null);
      setNotice(null);
      drop(new Set([item.transactionId]));
      try {
        const r = await browserApi.makeTransfer(workspace.id, item.transactionId, { accountId });
        const message = madeTransferMessage(r, accountById.get(accountId)?.name ?? '', t);
        setAnnounce(message);
        setNotice(message);
        // The other side it absorbed may be further down the list.
        if (r.absorbedId) await load(null);
      } catch (err) {
        setItems(before.items);
        setCursor(before.cursor);
        setTotal(before.total);
        setError(friendlyMessage(err, t));
      }
    },
    [items, cursor, total, drop, workspace.id, t, accountById, load],
  );

  async function acceptAbove() {
    setAboveOpen(false);
    setError(null);
    try {
      const r = await browserApi.acceptReview(workspace.id, { minConfidence: above / 100, ...narrow });
      setAnnounce(acceptedMessage(r));
      setCursor(0);
      setSelected(new Set());
      await load(null);
    } catch (err) {
      setError(friendlyMessage(err, t));
    }
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (picker || aboveOpen) return; // dialogs handle their own keys
      const cmd = reviewCommand({
        key: e.key,
        shiftKey: e.shiftKey,
        ctrlKey: e.ctrlKey,
        metaKey: e.metaKey,
        altKey: e.altKey,
        editable: isEditableTarget(e.target),
      });
      if (!cmd) return;
      if (cmd === 'close') {
        if (helpOpen) setHelpOpen(false);
        return;
      }
      // Buttons and links keep Enter and Space for themselves.
      const onControl =
        e.target instanceof HTMLElement && ['button', 'a'].includes(e.target.tagName.toLowerCase());
      if (onControl && (e.key === 'Enter' || e.key === ' ')) return;
      e.preventDefault();
      switch (cmd) {
        case 'next':
          setCursor((c) => clampCursor(c + 1, items.length));
          break;
        case 'prev':
          setCursor((c) => clampCursor(c - 1, items.length));
          break;
        case 'accept':
          void accept();
          break;
        case 'category':
          if (current) setPicker('category');
          break;
        case 'member':
          if (current) setPicker('member');
          break;
        case 'property':
          if (current && properties.length > 0) setPicker('property');
          break;
        case 'select':
          if (current)
            setSelected((s) => {
              const n = new Set(s);
              if (n.has(current.transactionId)) n.delete(current.transactionId);
              else n.add(current.transactionId);
              return n;
            });
          break;
        case 'acceptAbove':
          setAbove(percent(threshold));
          setAboveOpen(true);
          break;
        case 'help':
          setHelpOpen((h) => !h);
          break;
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [picker, aboveOpen, helpOpen, items.length, current, accept, threshold, properties.length]);

  const categoryName = (id: string | null) => (id ? (categoryById.get(id)?.name ?? null) : null);
  // AI-02: a line's property is chosen among those in its category's books.
  const currentPropertyOptions = useMemo(() => {
    if (!current) return [];
    const cat = suggestedCategoryId(current);
    const entityId = (cat && categoryById.get(cat)?.entityId) || current.entityId;
    return propertyOptions(properties, entityId, t('review.no_property'));
  }, [current, properties, categoryById, t]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted" data-testid="review-total">
          {t('review.count', { count: total })}
        </p>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className="btn-secondary"
            disabled={items.length === 0}
            onClick={() => {
              setAbove(percent(threshold));
              setAboveOpen(true);
            }}
          >
            {t('review.accept_above_button')}
          </button>
          <button type="button" className="btn-secondary" onClick={() => setHelpOpen((h) => !h)}>
            {t('review.shortcuts')}
          </button>
        </div>
      </div>

      <p aria-live="polite" className="sr-only" data-testid="review-announce">
        {announce}
      </p>
      {error && (
        <p role="alert" className="text-sm text-bad">
          {error}
        </p>
      )}
      {notice && (
        <p className="text-sm text-muted" data-testid="review-notice">
          {notice}
        </p>
      )}
      {offer && (
        <RuleOffer
          workspaceId={workspace.id}
          suggestion={offer}
          categoryName={categoryName}
          onDone={(m) => {
            setOffer(null);
            if (m) setAnnounce(m);
          }}
        />
      )}

      {helpOpen && (
        <section className="card" aria-label={t('review.shortcuts')} data-testid="shortcut-help">
          <h2 className="mb-2 font-semibold">{t('review.shortcuts')}</h2>
          <dl className="grid grid-cols-[8rem_1fr] gap-x-4 gap-y-1 text-sm">
            {SHORTCUTS.map((s) => (
              <div key={s.keys} className="contents">
                <dt>
                  <kbd className="rounded border border-line bg-canvas px-1.5 py-0.5 text-xs">{s.keys}</kbd>
                </dt>
                <dd>{t(s.label)}</dd>
              </div>
            ))}
          </dl>
        </section>
      )}

      <ListFilterBar
        screen="review"
        workspace={workspace}
        merchantHint={t('filters.merchant_hint')}
        showDirection
      />

      {items.length === 0 && !loading && hasFilters(filters) ? (
        <ListEmpty screen="review" fallback={t('review.empty')} />
      ) : items.length === 0 && !loading ? (
        <div className="card space-y-2 text-sm">
          <p className="font-medium">{t('review.empty')}</p>
          <p className="text-muted">
            <Link className="underline" href={`${base}/transactions`}>
              {t('review.back_to_transactions')}
            </Link>
          </p>
        </div>
      ) : (
        <ul
          ref={listRef}
          role="listbox"
          aria-label={t('review.list_label')}
          aria-multiselectable="true"
          aria-activedescendant={current ? `review-${current.transactionId}` : undefined}
          tabIndex={0}
          className="card divide-y divide-line p-0 focus:outline-none"
        >
          {items.map((item, i) => {
            const active = item === current;
            const sugCat = proposedCategoryId(item);
            const sugTransfer = proposedTransfer(item);
            const transferTo = sugTransfer && item.amount && item.amount.amount.startsWith('-');
            const otherAccount = sugTransfer
              ? (accountById.get(sugTransfer.accountId)?.name ?? t('review.another_account'))
              : null;
            const sugMember = suggestedMemberId(item);
            const conf = confidenceOf(item);
            const sugProperty = proposedProperty(item);
            const place = propertyLabel(item, properties);
            return (
              <li
                key={item.transactionId}
                id={`review-${item.transactionId}`}
                role="option"
                aria-selected={selected.has(item.transactionId)}
                aria-current={active ? 'true' : undefined}
                data-testid="review-row"
                onClick={() => setCursor(i)}
                className={`flex items-start gap-3 px-4 py-3 ${active ? 'bg-brand-50 ring-2 ring-inset ring-brand-600' : ''}`}
              >
                <input
                  type="checkbox"
                  className="mt-1"
                  tabIndex={-1}
                  checked={selected.has(item.transactionId)}
                  onChange={() =>
                    setSelected((s) => {
                      const n = new Set(s);
                      if (n.has(item.transactionId)) n.delete(item.transactionId);
                      else n.add(item.transactionId);
                      return n;
                    })
                  }
                  aria-label={t('review.select_row', { payee: item.payee || item.description })}
                />
                <MerchantMark merchant={item.merchant} fallback={item.payee} />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">
                    <Link className="hover:underline" href={`${base}/transactions/${item.transactionId}`}>
                      {item.merchant?.name ?? (item.payee || item.description || t('transactions.no_payee'))}
                    </Link>
                  </p>
                  <p className="truncate text-xs text-muted">
                    <DateText date={item.date} />
                    {item.accountId &&
                      accountById.get(item.accountId) &&
                      ` · ${accountById.get(item.accountId)!.name}`}
                    {item.payee &&
                      item.description &&
                      item.description !== item.payee &&
                      ` · ${item.description}`}
                  </p>
                  <p className="mt-1 flex flex-wrap items-center gap-2 text-sm">
                    <span data-testid="suggested-category">
                      {sugTransfer
                        ? t(transferTo ? 'review.transfer_to' : 'review.transfer_from', {
                            account: otherAccount ?? '',
                          })
                        : (categoryName(sugCat) ?? (
                            <span className="text-muted">{t('review.no_suggestion')}</span>
                          ))}
                    </span>
                    {(sugCat || sugTransfer) && <ConfidenceChip confidence={conf} threshold={threshold} />}
                    {sugMember && memberById.get(sugMember) && (
                      <span className="chip chip-muted">{memberById.get(sugMember)!.name}</span>
                    )}
                    {place && (
                      <span
                        className="chip chip-muted"
                        data-testid="suggested-property"
                        title={sugProperty?.explanation}
                      >
                        {sugProperty ? t('review.property_suggested', { property: place }) : place}
                        {sugProperty && ` · ${percent(sugProperty.confidence)}%`}
                      </span>
                    )}
                  </p>
                  <Explanation categorization={item.categorization} />
                </div>
                <div className="flex flex-col items-end gap-2">
                  {item.amount ? (
                    <Money
                      amount={item.amount.amount}
                      currency={item.amount.currency}
                      signed
                      className="font-medium"
                    />
                  ) : (
                    <span className="text-muted">—</span>
                  )}
                  <div className="flex gap-1">
                    <button
                      type="button"
                      className="btn-secondary px-2 py-1"
                      disabled={!sugCat && !sugTransfer}
                      aria-label={t(sugTransfer ? 'review.make_transfer_row' : 'review.accept_row', {
                        payee: item.payee || item.description,
                      })}
                      onClick={(e) => {
                        e.stopPropagation();
                        setCursor(i);
                        void browserApi
                          .acceptReview(workspace.id, { transactionIds: [item.transactionId] })
                          .then(
                            (r) => {
                              drop(new Set([item.transactionId]));
                              setAnnounce(acceptedMessage(r));
                              if (r.skipped > 0) setError(t('review.skipped', { count: r.skipped }));
                              if (r.transfers > 0) void load(null);
                            },
                            (err) => setError(friendlyMessage(err, t)),
                          );
                      }}
                    >
                      {sugTransfer ? t('review.make_transfer') : t('review.accept')}
                    </button>
                    {!sugTransfer && transferTargets(accounts, item).length > 0 && (
                      <button
                        type="button"
                        className="btn-secondary px-2 py-1"
                        data-testid="make-transfer-pick"
                        aria-label={t('review.make_transfer_pick_row', {
                          payee: item.payee || item.description,
                        })}
                        onClick={(e) => {
                          e.stopPropagation();
                          setCursor(i);
                          setPicker('transfer');
                        }}
                      >
                        {t('review.make_transfer_pick')}
                      </button>
                    )}
                    <button
                      type="button"
                      className="btn-secondary px-2 py-1"
                      aria-label={t('review.change_row', { payee: item.payee || item.description })}
                      onClick={(e) => {
                        e.stopPropagation();
                        setCursor(i);
                        setPicker('category');
                      }}
                    >
                      {t('review.change')}
                    </button>
                    {properties.length > 0 && !sugTransfer && (
                      <button
                        type="button"
                        className="btn-secondary px-2 py-1"
                        data-testid="change-property"
                        aria-label={t('review.change_property_row', {
                          payee: item.payee || item.description,
                        })}
                        onClick={(e) => {
                          e.stopPropagation();
                          setCursor(i);
                          setPicker('property');
                        }}
                      >
                        {t('review.change_property')}
                      </button>
                    )}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {nextCursor && (
        <button
          type="button"
          className="btn-secondary"
          disabled={loading}
          onClick={() => void load(nextCursor)}
        >
          {t('review.load_more')}
        </button>
      )}
      {loading && (
        <p role="status" className="text-xs text-muted">
          {t('common.loading')}
        </p>
      )}
      <ListWindowFooter
        screen="review"
        note={older > 0 ? t('filters.older_to_review', { count: older }) : undefined}
      />

      <PickerDialog
        open={picker === 'category'}
        title={t('review.pick_category')}
        options={categoryOptions}
        initialId={current ? suggestedCategoryId(current) : null}
        onClose={() => setPicker(null)}
        onPick={(id) => {
          setPicker(null);
          if (current) void resolve(current, id, undefined);
        }}
      />
      <PickerDialog
        open={picker === 'member'}
        title={t('review.pick_member')}
        options={memberOptions}
        initialId={current ? (suggestedMemberId(current) ?? '') : null}
        onClose={() => setPicker(null)}
        onPick={(id) => {
          setPicker(null);
          if (!current) return;
          const cat = suggestedCategoryId(current);
          if (!cat) return setError(t('review.member_needs_category'));
          void resolve(current, cat, id || null);
        }}
      />
      <PickerDialog
        open={picker === 'property'}
        title={t('review.pick_property')}
        options={currentPropertyOptions}
        initialId={
          current
            ? (() => {
                const p = proposedProperty(current);
                const id = current.propertyId ?? p?.propertyId ?? null;
                const unit = current.propertyId ? current.unitId : (p?.unitId ?? null);
                return id ? (unit ? `${id}/${unit}` : id) : '';
              })()
            : null
        }
        onClose={() => setPicker(null)}
        onPick={(id) => {
          setPicker(null);
          if (!current) return;
          const cat = suggestedCategoryId(current);
          if (!cat) return setError(t('review.property_needs_category'));
          void resolve(current, cat, undefined, parsePropertyPick(id));
        }}
      />
      <PickerDialog
        open={picker === 'transfer'}
        title={t('review.pick_transfer_account')}
        options={transferPick}
        onClose={() => setPicker(null)}
        onPick={(id) => {
          setPicker(null);
          if (current) void makeTransfer(current, id);
        }}
      />
      <AcceptAboveDialog
        open={aboveOpen}
        value={above}
        onChange={setAbove}
        count={countAtOrAbove(items, above / 100)}
        loadedAll={!nextCursor}
        onConfirm={acceptAbove}
        onClose={() => setAboveOpen(false)}
      />
    </div>
  );
}

function AcceptAboveDialog({
  open,
  value,
  onChange,
  count,
  loadedAll,
  onConfirm,
  onClose,
}: {
  open: boolean;
  value: number;
  onChange: (v: number) => void;
  count: number;
  loadedAll: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    else if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      aria-labelledby="accept-above-title"
      onClose={onClose}
      className="m-auto w-[min(28rem,calc(100vw-2rem))] rounded-lg border border-line bg-surface p-0 text-ink backdrop:bg-black/40"
    >
      <form
        method="dialog"
        className="space-y-4 p-4"
        onSubmit={(e) => {
          e.preventDefault();
          onConfirm();
        }}
      >
        <h2 id="accept-above-title" className="text-base font-semibold">
          {t('review.accept_above_title')}
        </h2>
        <div>
          <label htmlFor="accept-above" className="field-label">
            {t('review.accept_above_label', { percent: value })}
          </label>
          <input
            id="accept-above"
            type="range"
            min={50}
            max={99}
            value={value}
            onChange={(e) => onChange(Number(e.target.value))}
            className="w-full"
            autoFocus
          />
        </div>
        <p className="text-sm" data-testid="accept-above-count">
          {loadedAll
            ? t('review.accept_above_count', { count, percent: percent(value / 100) })
            : t('review.accept_above_count_loaded', { count, percent: percent(value / 100) })}
        </p>
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-secondary" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button type="submit" className="btn-primary">
            {t('review.accept_above_confirm')}
          </button>
        </div>
      </form>
    </dialog>
  );
}
