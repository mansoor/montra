'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { AssetCategory, AssetListDto, AssetMethod } from '@montra/api-client';
import { browserApi } from '@/lib/browser-api';
import { ASSET_CATEGORY_OPTIONS, assetState, suggestedLife, unpostedYears } from '@/lib/assets';
import { minorToInput, parseAmountInput } from '@/lib/money';
import { DateText, useI18n } from '../i18n';
import { Money } from '../money';
import { StatusLine, useAction } from '../use-action';

const METHODS: readonly AssetMethod[] = ['macrs_half_year', 'straight_line', 'expense_now'];
const LIVES = [3, 5, 7, 10] as const;

export interface PurchaseChoice {
  id: string;
  date: string;
  payee: string;
  /** Minor units, positive. */
  amount: string;
}

/** The register and its forms (BIZ-16): record an asset, post depreciation, and see what the business owns. */
export function AssetRegister({
  workspaceId,
  entityId,
  list,
  today,
  purchase,
}: {
  workspaceId: string;
  entityId: string;
  list: AssetListDto;
  today: string;
  purchase: PurchaseChoice | null;
}) {
  const { run, busy, message, setMessage, t } = useAction();
  const { locale } = useI18n();
  const router = useRouter();
  const ccy = list.currency;
  const base = `/w/${workspaceId}/business/${entityId}/assets`;
  const thisYear = Number(today.slice(0, 4));
  const [name, setName] = useState('');
  const [category, setCategory] = useState<AssetCategory>('computers');
  const [serial, setSerial] = useState('');
  const [cost, setCost] = useState(purchase ? minorToInput(BigInt(purchase.amount), ccy) : '');
  const [date, setDate] = useState(purchase?.date ?? today);
  const [method, setMethod] = useState<AssetMethod>('macrs_half_year');
  const [life, setLife] = useState<number>(suggestedLife('computers'));
  const [section179, setSection179] = useState('');
  const pending = unpostedYears(list.assets, thisYear);
  const first = pending[0] ?? thisYear;
  const yearChoices = Array.from({ length: thisYear - first + 1 }, (_, i) => first + i);
  const [throughYear, setThroughYear] = useState(String(Math.max(first, thisYear - 1)));

  function add(e: React.FormEvent) {
    e.preventDefault();
    const parsed = parseAmountInput(cost, ccy, locale, t);
    if (!parsed.ok) return setMessage({ tone: 'bad', text: parsed.error });
    let s179: string | undefined;
    if (section179.trim()) {
      const p = parseAmountInput(section179, ccy, locale, t);
      if (!p.ok) return setMessage({ tone: 'bad', text: p.error });
      s179 = String(p.minor);
    }
    void run(
      () =>
        browserApi.createAsset(workspaceId, {
          entityId,
          name: name.trim(),
          category,
          serial: serial.trim() || null,
          cost: String(parsed.minor),
          inServiceDate: date,
          method,
          lifeYears: life as 3 | 5 | 7 | 10,
          ...(s179 && method !== 'expense_now' ? { section179: s179 } : {}),
          transactionId: purchase?.id ?? null,
        }),
      t('assets.added'),
    ).then((a) => {
      if (a) router.push(`${base}/${a.id}`);
    });
  }

  return (
    <div className="space-y-5">
      <form className="card space-y-3" aria-label={t('assets.add')} onSubmit={add}>
        <h2 className="text-base font-semibold">{t('assets.add')}</h2>
        {purchase && (
          <p className="text-sm" data-testid="asset-purchase">
            {t('assets.from_purchase')} {purchase.payee} · <DateText date={purchase.date} /> ·{' '}
            <Money amount={purchase.amount} currency={ccy} />
          </p>
        )}
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <label>
            <span className="field-label">{t('assets.name')}</span>
            <input
              className="input"
              required
              maxLength={200}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label>
            <span className="field-label">{t('assets.category')}</span>
            <select
              className="input"
              value={category}
              onChange={(e) => {
                const c = e.target.value as AssetCategory;
                setCategory(c);
                setLife(suggestedLife(c));
                if (c === 'software' && method === 'macrs_half_year') setMethod('straight_line');
              }}
            >
              {ASSET_CATEGORY_OPTIONS.map((c) => (
                <option key={c} value={c}>
                  {t(`assets.category_${c}`)}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span className="field-label">{t('assets.serial')}</span>
            <input
              className="input"
              maxLength={100}
              value={serial}
              onChange={(e) => setSerial(e.target.value)}
            />
          </label>
          <label>
            <span className="field-label">{t('assets.cost')}</span>
            <input
              className="input"
              inputMode="decimal"
              required
              value={cost}
              onChange={(e) => setCost(e.target.value)}
            />
          </label>
          <label>
            <span className="field-label">{t('assets.in_service')}</span>
            <input
              className="input"
              type="date"
              required
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
          </label>
          <label>
            <span className="field-label">{t('assets.method')}</span>
            <select
              className="input"
              value={method}
              onChange={(e) => setMethod(e.target.value as AssetMethod)}
            >
              {METHODS.filter((m) => !(category === 'software' && m === 'macrs_half_year')).map((m) => (
                <option key={m} value={m}>
                  {t(`assets.method_${m}`)}
                </option>
              ))}
            </select>
          </label>
          {method !== 'expense_now' && (
            <>
              <label>
                <span className="field-label">{t('assets.life')}</span>
                <select className="input" value={life} onChange={(e) => setLife(Number(e.target.value))}>
                  {LIVES.map((n) => (
                    <option key={n} value={n}>
                      {t('assets.years', { n })}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span className="field-label">{t('assets.section_179')}</span>
                <input
                  className="input"
                  inputMode="decimal"
                  value={section179}
                  onChange={(e) => setSection179(e.target.value)}
                />
              </label>
            </>
          )}
        </div>
        <p className="text-xs text-muted">
          {method === 'expense_now'
            ? t('assets.expense_now_note', { limit: '$2,500' })
            : t('assets.method_note')}
        </p>
        <button type="submit" className="btn-primary" disabled={busy}>
          {t('assets.add')}
        </button>
        <StatusLine message={message} />
      </form>

      {list.candidates.length > 0 && (
        <section className="card space-y-2" aria-labelledby="candidates-title">
          <h2 id="candidates-title" className="text-base font-semibold">
            {t('assets.candidates')}
          </h2>
          <p className="text-sm text-muted">{t('assets.candidates_hint', { limit: '$2,500' })}</p>
          <ul className="divide-y divide-line">
            {list.candidates.map((c) => (
              <li
                key={c.transactionId}
                className="flex flex-wrap items-center justify-between gap-2 py-2"
                data-testid="asset-candidate"
              >
                <span>
                  {c.payee ?? t('business.no_name')} · <DateText date={c.date} />
                  {c.categoryName ? ` · ${c.categoryName}` : ''}
                </span>
                <span className="flex items-center gap-3">
                  <Money amount={c.amount} currency={ccy} />
                  <Link className="underline" href={`${base}?transactionId=${c.transactionId}`}>
                    {t('expense.record_as_asset')}
                  </Link>
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {pending.length > 0 && (
        <form
          className="card flex flex-wrap items-end gap-3"
          aria-label={t('assets.post_title')}
          onSubmit={(e) => {
            e.preventDefault();
            void run(
              () => browserApi.postDepreciation(workspaceId, { entityId, throughYear: Number(throughYear) }),
              (r) => t('assets.posted', { n: r.posted.length }),
            );
          }}
        >
          <label>
            <span className="field-label">{t('assets.post_through')}</span>
            <select className="input" value={throughYear} onChange={(e) => setThroughYear(e.target.value)}>
              {yearChoices.map((y) => (
                <option key={y} value={y}>
                  {y}
                </option>
              ))}
            </select>
          </label>
          <button type="submit" className="btn-secondary" disabled={busy}>
            {t('assets.post')}
          </button>
          <p className="w-full text-xs text-muted">{t('assets.post_hint', { years: pending.join(', ') })}</p>
        </form>
      )}

      {list.assets.length > 0 && (
        <section className="card-flush" aria-label={t('assets.list')}>
          <table className="tbl">
            <thead>
              <tr>
                <th className="px-4 py-2">{t('assets.name')}</th>
                <th className="px-2 py-2">{t('assets.in_service')}</th>
                <th className="px-2 py-2 text-right">{t('assets.cost')}</th>
                <th className="px-2 py-2 text-right">{t('assets.book_value')}</th>
                <th className="px-4 py-2">{t('assets.status')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {list.assets.map((a) => {
                const state = assetState(a);
                return (
                  <tr key={a.id} data-testid="asset-row">
                    <td className="px-4 py-2">
                      <Link className="font-medium underline" href={`${base}/${a.id}`}>
                        {a.name}
                      </Link>
                      <span className="block text-xs text-muted">
                        {t(`assets.category_${a.category}`)}
                        {a.serial ? ` · ${a.serial}` : ''}
                      </span>
                    </td>
                    <td className="px-2 py-2">
                      <DateText date={a.inServiceDate} />
                    </td>
                    <td className="px-2 py-2 text-right">
                      <Money amount={a.cost} currency={ccy} />
                    </td>
                    <td className="px-2 py-2 text-right">
                      <Money amount={a.bookValue} currency={ccy} />
                    </td>
                    <td className="px-4 py-2">
                      <span className={state === 'disposed' ? 'chip' : 'chip chip-good'}>
                        {state === 'assigned'
                          ? t('assets.with_person', { name: a.assignedTo!.personName })
                          : t(`assets.state_${state}`)}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}
