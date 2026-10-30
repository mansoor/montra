'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import type { AccountDto, CategoryDto, FamilyMemberDto, WorkspaceDto } from '@montra/api-client';
import type { QuickAddDraftDto } from '@montra/schemas';
import { asCurrencyCode } from '@montra/domain';
import { browserApi } from '@/lib/browser-api';
import { friendlyMessage } from '@/lib/errors';
import { draftToTransaction, highlightSpans } from '@/lib/ai';
import { minorToInput, parseAmountInput } from '@/lib/money';
import { groupCategories } from '@/lib/view-models';
import { useI18n } from './i18n';

const PARSE_DELAY_MS = 350;

const SPAN_CLASS: Record<string, string> = {
  amount: 'bg-good/15 text-good',
  date: 'bg-brand-100 text-brand-700',
  account: 'bg-warn/15 text-warn',
  category: 'bg-brand-100 text-brand-700',
  payee: 'bg-canvas font-semibold',
  member: 'bg-warn/15 text-warn',
  memo: 'text-muted',
  tag: 'bg-canvas text-muted',
};

type Overrides = Partial<{
  amount: string;
  direction: 'out' | 'in';
  date: string;
  payee: string;
  accountId: string;
  categoryId: string;
  memberId: string;
  memo: string;
}>;

/**
 * Natural-language quick add (TXN-06): "lunch 18.50 amex client meeting" is parsed into fields (AI when on,
 * rules otherwise) and shown as editable chips; Enter creates the transaction.
 */
export function QuickAddSentence({
  workspace,
  accounts,
  categories,
  members,
  today,
}: {
  workspace: WorkspaceDto;
  accounts: AccountDto[];
  categories: CategoryDto[];
  members: FamilyMemberDto[];
  today: string;
}) {
  const router = useRouter();
  const { t, locale } = useI18n();
  const inputRef = useRef<HTMLInputElement>(null);
  const [text, setText] = useState('');
  const [draft, setDraft] = useState<QuickAddDraftDto | null>(null);
  const [parsedFor, setParsedFor] = useState('');
  const [over, setOver] = useState<Overrides>({});
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const groups = useMemo(() => groupCategories(workspace, categories), [workspace, categories]);
  const accountById = useMemo(() => new Map(accounts.map((a) => [a.id, a])), [accounts]);

  async function parse(value: string): Promise<QuickAddDraftDto | null> {
    if (!value.trim()) {
      setDraft(null);
      setParsedFor('');
      return null;
    }
    try {
      const d = await browserApi.parseQuickAdd(workspace.id, { text: value, today });
      setDraft(d);
      setParsedFor(value);
      setError(null);
      return d;
    } catch (err) {
      setError(friendlyMessage(err, t));
      return null;
    }
  }

  useEffect(() => {
    if (text === parsedFor) return;
    const timer = setTimeout(() => void parse(text), PARSE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [text]); // parse follows the typed text only

  const merged = (d: QuickAddDraftDto | null) => {
    if (!d) return null;
    const accountId = over.accountId ?? d.accountId;
    const currency =
      (accountId && accountById.get(accountId)?.currency) || d.amount?.currency || workspace.baseCurrency;
    let amount = d.amount;
    if (over.amount !== undefined) {
      const p = parseAmountInput(over.amount, currency, locale, t);
      amount = p.ok
        ? { amount: (p.minor < 0n ? -p.minor : p.minor).toString(), currency: asCurrencyCode(currency) }
        : null;
    }
    return {
      ...d,
      amount,
      direction: over.direction ?? d.direction,
      date: over.date ?? d.date,
      payee: over.payee ?? d.payee,
      accountId: accountId ?? null,
      categoryId: over.categoryId !== undefined ? over.categoryId || null : d.categoryId,
      memberId: over.memberId !== undefined ? over.memberId || null : d.memberId,
      memo: over.memo ?? d.memo,
    } satisfies QuickAddDraftDto;
  };

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const d = merged(text === parsedFor ? draft : await parse(text));
    if (!d) return setError(t('quick_add.nl.type_something'));
    const body = draftToTransaction(
      d,
      accounts[0]?.id ?? null,
      (id) => accountById.get(id)?.currency ?? null,
    );
    if (!body.ok) return setError(t(body.error));
    setBusy(true);
    setError(null);
    try {
      await browserApi.createTransaction(workspace.id, body.value);
      setSaved(t('quick_add.saved', { name: d.payee || t('quick_add.transaction') }));
      setText('');
      setDraft(null);
      setParsedFor('');
      setOver({});
      router.refresh();
      inputRef.current?.focus();
    } catch (err) {
      setError(friendlyMessage(err, t));
    } finally {
      setBusy(false);
    }
  }

  const d = merged(draft);
  const currency = (d?.accountId && accountById.get(d.accountId)?.currency) || workspace.baseCurrency;

  return (
    <form onSubmit={onSubmit} className="space-y-3" aria-label={t('quick_add.nl.label')} noValidate>
      <div>
        <label htmlFor="qa-sentence" className="field-label">
          {t('quick_add.nl.label')}
        </label>
        <input
          ref={inputRef}
          id="qa-sentence"
          className="input"
          maxLength={300}
          autoComplete="off"
          placeholder={t('quick_add.nl.placeholder')}
          value={text}
          onChange={(e) => setText(e.target.value)}
          aria-describedby="qa-sentence-hint"
        />
        <p id="qa-sentence-hint" className="mt-1 text-xs text-muted">
          {t('quick_add.nl.hint')}
        </p>
      </div>
      {draft && text === parsedFor && (
        <p className="text-sm" data-testid="qa-highlight" aria-hidden="true">
          {highlightSpans(text, draft.spans).map((s, i) =>
            s.field ? (
              <mark key={i} className={`rounded px-0.5 ${SPAN_CLASS[s.field] ?? ''}`}>
                {s.text}
              </mark>
            ) : (
              <span key={i}>{s.text}</span>
            ),
          )}
          <span
            className={`chip ml-2 ${draft.source === 'ai' ? 'chip-good' : 'chip-muted'}`}
            data-testid="qa-source"
          >
            {draft.source === 'ai' ? t('quick_add.nl.source_ai') : t('quick_add.nl.source_rules')}
          </span>
        </p>
      )}
      {d && (
        <div className="grid gap-2 sm:grid-cols-3 lg:grid-cols-6" data-testid="qa-chips">
          <Chip label={t('fields.amount')}>
            <input
              className="input num py-1"
              inputMode="decimal"
              aria-label={t('fields.amount')}
              value={over.amount ?? (d.amount ? minorToInput(BigInt(d.amount.amount), currency) : '')}
              onChange={(e) => setOver({ ...over, amount: e.target.value })}
            />
          </Chip>
          <Chip label={t('fields.type')}>
            <select
              className="input py-1"
              aria-label={t('fields.type')}
              value={d.direction}
              onChange={(e) => setOver({ ...over, direction: e.target.value as 'out' | 'in' })}
            >
              <option value="out">{t('fields.expense_out')}</option>
              <option value="in">{t('fields.income_in')}</option>
            </select>
          </Chip>
          <Chip label={t('fields.date')}>
            <input
              type="date"
              className="input py-1"
              aria-label={t('fields.date')}
              value={d.date}
              onChange={(e) => setOver({ ...over, date: e.target.value })}
            />
          </Chip>
          <Chip label={t('fields.payee')}>
            <input
              className="input py-1"
              aria-label={t('fields.payee')}
              value={d.payee ?? ''}
              onChange={(e) => setOver({ ...over, payee: e.target.value })}
            />
          </Chip>
          <Chip label={t('fields.account')}>
            <select
              className="input py-1"
              aria-label={t('fields.account')}
              value={d.accountId ?? accounts[0]?.id ?? ''}
              onChange={(e) => setOver({ ...over, accountId: e.target.value })}
            >
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </Chip>
          <Chip label={t('fields.category')}>
            <select
              className="input py-1"
              aria-label={t('fields.category')}
              value={d.categoryId ?? ''}
              onChange={(e) => setOver({ ...over, categoryId: e.target.value })}
            >
              <option value="">{t('quick_add.uncategorized')}</option>
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
          </Chip>
          {members.length > 0 && (
            <Chip label={t('fields.member')}>
              <select
                className="input py-1"
                aria-label={t('fields.member')}
                value={d.memberId ?? ''}
                onChange={(e) => setOver({ ...over, memberId: e.target.value })}
              >
                <option value="">{t('members.household')}</option>
                {members
                  .filter((m) => m.status === 'active')
                  .map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
              </select>
            </Chip>
          )}
          <Chip label={t('fields.memo')}>
            <input
              className="input py-1"
              aria-label={t('fields.memo')}
              value={d.memo ?? ''}
              onChange={(e) => setOver({ ...over, memo: e.target.value })}
            />
          </Chip>
          {d.tags.length > 0 && (
            <p className="self-end text-xs text-muted sm:col-span-2">#{d.tags.join(' #')}</p>
          )}
        </div>
      )}
      {error && (
        <p role="alert" className="text-sm text-bad">
          {error}
        </p>
      )}
      <div className="flex items-center gap-3">
        <button type="submit" className="btn-primary" disabled={busy || !text.trim()}>
          {busy ? t('common.saving') : t('quick_add.add')}
        </button>
        <p aria-live="polite" className="text-sm text-good">
          {saved}
        </p>
      </div>
    </form>
  );
}

function Chip({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rounded-md border border-line p-1.5">
      <span className="block px-1 text-[0.65rem] uppercase tracking-wide text-muted" aria-hidden="true">
        {label}
      </span>
      {children}
    </div>
  );
}
