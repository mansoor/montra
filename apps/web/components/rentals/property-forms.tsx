'use client';

import { useState } from 'react';
import type { CategoryDto, DepreciationDto, PropertyBudgetDto, PropertyDto } from '@montra/api-client';
import { bpsToPercent } from '@/lib/business';
import { browserApi } from '@/lib/browser-api';
import { minorToInput } from '@/lib/money';
import { optionalBps, optionalMinor, parseUnitLabels, positiveMinor, PROPERTY_TYPES } from '@/lib/rentals';
import { DateText } from '../i18n';
import { Money } from '../money';
import { StatusLine, useAction } from '../use-action';

const input = (minor: string | null, currency: string) =>
  minor ? minorToInput(BigInt(minor), currency) : '';

/** The figures a property carries, for adding or editing one (RNT-01). */
function useFigures(currency: string, p?: PropertyDto) {
  const [name, setName] = useState(p?.name ?? '');
  const [address, setAddress] = useState(p?.address ?? '');
  const [type, setType] = useState<(typeof PROPERTY_TYPES)[number]>(p?.type ?? 'sfh');
  const [purchaseDate, setPurchaseDate] = useState<string>(p?.purchaseDate ?? '');
  const [purchasePrice, setPurchasePrice] = useState(input(p?.purchasePrice ?? null, currency));
  const [landValue, setLandValue] = useState(input(p?.landValue ?? null, currency));
  const [cashInvested, setCashInvested] = useState(input(p?.cashInvested ?? null, currency));
  const [currentValue, setCurrentValue] = useState(input(p?.currentValue ?? null, currency));
  const [ownership, setOwnership] = useState(p ? bpsToPercent(p.ownershipBps) : '100');
  const [sqft, setSqft] = useState(p?.sqft ? String(p.sqft) : '');
  return {
    values: {
      name,
      address,
      type,
      purchaseDate,
      purchasePrice,
      landValue,
      cashInvested,
      currentValue,
      ownership,
      sqft,
    },
    set: {
      setName,
      setAddress,
      setType,
      setPurchaseDate,
      setPurchasePrice,
      setLandValue,
      setCashInvested,
      setCurrentValue,
      setOwnership,
      setSqft,
    },
  };
}

function FigureFields({ f }: { f: ReturnType<typeof useFigures> }) {
  const { t } = useAction();
  const { values: v, set: s } = f;
  const money = (label: string, value: string, on: (x: string) => void, hint?: string) => (
    <label>
      <span className="field-label">{label}</span>
      <input className="input" inputMode="decimal" value={value} onChange={(e) => on(e.target.value)} />
      {hint && <span className="mt-1 block text-xs text-muted">{hint}</span>}
    </label>
  );
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      <label>
        <span className="field-label">{t('rentals.property_name')}</span>
        <input
          className="input"
          required
          maxLength={200}
          value={v.name}
          onChange={(e) => s.setName(e.target.value)}
        />
      </label>
      <label>
        <span className="field-label">{t('rentals.address')}</span>
        <input
          className="input"
          maxLength={1000}
          value={v.address}
          onChange={(e) => s.setAddress(e.target.value)}
        />
      </label>
      <label>
        <span className="field-label">{t('rentals.type')}</span>
        <select className="input" value={v.type} onChange={(e) => s.setType(e.target.value as typeof v.type)}>
          {PROPERTY_TYPES.map((x) => (
            <option key={x} value={x}>
              {t(`rentals.type_${x}`)}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span className="field-label">{t('rentals.purchase_date')}</span>
        <input
          className="input"
          type="date"
          value={v.purchaseDate}
          onChange={(e) => s.setPurchaseDate(e.target.value)}
        />
      </label>
      {money(t('rentals.purchase_price'), v.purchasePrice, s.setPurchasePrice)}
      {money(t('rentals.land_value'), v.landValue, s.setLandValue, t('rentals.land_value_hint'))}
      {money(t('rentals.cash_invested'), v.cashInvested, s.setCashInvested, t('rentals.cash_invested_hint'))}
      {money(t('rentals.current_value'), v.currentValue, s.setCurrentValue, t('rentals.current_value_hint'))}
      <label>
        <span className="field-label">{t('rentals.ownership')}</span>
        <input
          className="input"
          inputMode="decimal"
          required
          value={v.ownership}
          onChange={(e) => s.setOwnership(e.target.value)}
        />
        <span className="mt-1 block text-xs text-muted">{t('rentals.ownership_hint')}</span>
      </label>
      <label>
        <span className="field-label">{t('rentals.sqft')}</span>
        <input
          className="input"
          inputMode="numeric"
          pattern="\d{1,9}"
          value={v.sqft}
          onChange={(e) => s.setSqft(e.target.value)}
        />
      </label>
    </div>
  );
}

/** The figures as request fields, or the first thing wrong with them. */
function figureRequest(
  f: ReturnType<typeof useFigures>,
  currency: string,
  t: ReturnType<typeof useAction>['t'],
) {
  const v = f.values;
  const out: Record<string, string | null> = {};
  for (const [key, value] of [
    ['purchasePrice', v.purchasePrice],
    ['landValue', v.landValue],
    ['cashInvested', v.cashInvested],
    ['currentValue', v.currentValue],
  ] as const) {
    const p = optionalMinor(value, currency, t);
    if (!p.ok) return { ok: false as const, error: p.error };
    out[key] = p.value;
  }
  const bps = optionalBps(v.ownership, t);
  if (!bps.ok) return { ok: false as const, error: bps.error };
  if (!bps.value) return { ok: false as const, error: t('rentals.ownership_invalid') };
  return {
    ok: true as const,
    value: {
      name: v.name.trim(),
      address: v.address.trim() || null,
      type: v.type,
      purchaseDate: (v.purchaseDate || null) as never,
      purchasePrice: out.purchasePrice ?? null,
      landValue: out.landValue ?? null,
      cashInvested: out.cashInvested ?? null,
      currentValue: out.currentValue ?? null,
      ownershipBps: bps.value,
      sqft: v.sqft ? Number(v.sqft) : null,
    },
  };
}

export function NewPropertyForm({
  workspaceId,
  entityId,
  currency,
}: {
  workspaceId: string;
  entityId: string;
  currency: string;
}) {
  const { run, busy, message, setMessage, t } = useAction();
  const f = useFigures(currency);
  const [units, setUnits] = useState('');
  return (
    <details className="card">
      <summary className="cursor-pointer text-base font-semibold">{t('rentals.add_property')}</summary>
      <form
        className="mt-3 space-y-3"
        aria-label={t('rentals.add_property')}
        onSubmit={(e) => {
          e.preventDefault();
          const req = figureRequest(f, currency, t);
          if (!req.ok) return setMessage({ tone: 'bad', text: req.error });
          void run(
            () =>
              browserApi.createProperty(workspaceId, {
                entityId,
                ...req.value,
                units: parseUnitLabels(units),
              }),
            t('rentals.property_added'),
          ).then((r) => {
            if (r) {
              f.set.setName('');
              f.set.setAddress('');
              setUnits('');
            }
          });
        }}
      >
        <FigureFields f={f} />
        <label className="block">
          <span className="field-label">{t('rentals.units_field')}</span>
          <input className="input" value={units} onChange={(e) => setUnits(e.target.value)} />
          <span className="mt-1 block text-xs text-muted">{t('rentals.units_hint')}</span>
        </label>
        <button type="submit" className="btn-primary" disabled={busy}>
          {t('rentals.add_property')}
        </button>
        <StatusLine message={message} />
      </form>
    </details>
  );
}

export function EditPropertyForm({
  workspaceId,
  property,
  currency,
}: {
  workspaceId: string;
  property: PropertyDto;
  currency: string;
}) {
  const { run, busy, message, setMessage, t } = useAction();
  const f = useFigures(currency, property);
  return (
    <details className="card">
      <summary className="cursor-pointer text-base font-semibold">{t('rentals.edit_property')}</summary>
      <form
        className="mt-3 space-y-3"
        aria-label={t('rentals.edit_property')}
        onSubmit={(e) => {
          e.preventDefault();
          const req = figureRequest(f, currency, t);
          if (!req.ok) return setMessage({ tone: 'bad', text: req.error });
          void run(
            () =>
              browserApi.updateProperty(workspaceId, property.id, {
                ...req.value,
                version: property.version,
              }),
            t('rentals.property_saved'),
          );
        }}
      >
        <FigureFields f={f} />
        <div className="flex flex-wrap gap-2">
          <button type="submit" className="btn-primary" disabled={busy}>
            {t('rentals.save')}
          </button>
          <button
            type="button"
            className="btn-secondary"
            disabled={busy}
            onClick={() =>
              run(
                () =>
                  browserApi.updateProperty(workspaceId, property.id, {
                    archived: !property.archived,
                    version: property.version,
                  }),
                property.archived ? t('rentals.restored') : t('rentals.archived'),
              )
            }
          >
            {property.archived ? t('rentals.restore') : t('rentals.archive')}
          </button>
        </div>
        <StatusLine message={message} />
      </form>
    </details>
  );
}

/** Units and whether anyone lives there (RNT-02). */
export function UnitList({
  workspaceId,
  property,
  currency,
}: {
  workspaceId: string;
  property: PropertyDto;
  currency: string;
}) {
  const { run, busy, message, setMessage, t } = useAction();
  const [label, setLabel] = useState('');
  const [beds, setBeds] = useState('');
  const [baths, setBaths] = useState('');
  const [marketRent, setMarketRent] = useState('');
  return (
    <section className="card-flush" aria-labelledby="units-title">
      <h2 id="units-title" className="px-4 pt-3 text-base font-semibold">
        {t('rentals.units')}
      </h2>
      <table className="tbl">
        <thead>
          <tr>
            <th className="px-4 py-2">{t('rentals.unit')}</th>
            <th className="px-2 py-2">{t('rentals.beds_baths')}</th>
            <th className="px-2 py-2 text-right">{t('rentals.market_rent')}</th>
            <th className="px-2 py-2">{t('rentals.status')}</th>
            <th className="px-4 py-2" />
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {property.units.map((u) => (
            <tr key={u.id} data-testid="unit-row">
              <td className="px-4 py-2 font-medium">{u.label}</td>
              <td className="px-2 py-2 text-sm">
                {u.beds ?? '—'} / {u.baths ?? '—'}
              </td>
              <td className="px-2 py-2 text-right">
                {u.marketRent ? <Money amount={u.marketRent} currency={currency} /> : '—'}
              </td>
              <td className="px-2 py-2">
                <span className={u.status === 'occupied' ? 'chip chip-good' : 'chip'}>
                  {t(`rentals.unit_${u.status}`)}
                </span>
              </td>
              <td className="px-4 py-2 text-right">
                {u.status !== 'occupied' && (
                  <button
                    type="button"
                    className="text-sm underline"
                    disabled={busy}
                    onClick={() =>
                      run(() =>
                        browserApi.updateUnit(workspaceId, u.id, {
                          underRepair: u.status !== 'under_repair',
                          version: u.version,
                        }),
                      )
                    }
                  >
                    {u.status === 'under_repair' ? t('rentals.mark_ready') : t('rentals.mark_repair')}
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <form
        className="flex flex-wrap items-end gap-2 border-t border-line p-4"
        aria-label={t('rentals.add_unit')}
        onSubmit={(e) => {
          e.preventDefault();
          const rent = optionalMinor(marketRent, currency, t);
          if (!rent.ok) return setMessage({ tone: 'bad', text: rent.error });
          void run(
            () =>
              browserApi.createUnit(workspaceId, property.id, {
                label: label.trim(),
                beds: beds ? Number(beds) : null,
                baths: baths.trim() || null,
                marketRent: rent.value,
              }),
            t('rentals.unit_added'),
          ).then((r) => {
            if (r) {
              setLabel('');
              setBeds('');
              setBaths('');
              setMarketRent('');
            }
          });
        }}
      >
        <label>
          <span className="field-label">{t('rentals.unit_label')}</span>
          <input
            className="input w-32"
            required
            maxLength={100}
            value={label}
            onChange={(e) => setLabel(e.target.value)}
          />
        </label>
        <label>
          <span className="field-label">{t('rentals.beds')}</span>
          <input
            className="input w-20"
            inputMode="numeric"
            pattern="\d{1,2}"
            value={beds}
            onChange={(e) => setBeds(e.target.value)}
          />
        </label>
        <label>
          <span className="field-label">{t('rentals.baths')}</span>
          <input
            className="input w-20"
            inputMode="decimal"
            pattern="\d{1,2}(\.5)?"
            value={baths}
            onChange={(e) => setBaths(e.target.value)}
          />
        </label>
        <label>
          <span className="field-label">{t('rentals.market_rent')}</span>
          <input
            className="input w-32"
            inputMode="decimal"
            value={marketRent}
            onChange={(e) => setMarketRent(e.target.value)}
          />
        </label>
        <button type="submit" className="btn-secondary" disabled={busy}>
          {t('rentals.add_unit')}
        </button>
      </form>
      <div className="px-4 pb-3">
        <StatusLine message={message} />
      </div>
    </section>
  );
}

/** The depreciation helper (RNT-09). It's on Schedule E but never in the ledger. */
export function DepreciationPanel({
  workspaceId,
  property,
  schedules,
  currency,
  year,
}: {
  workspaceId: string;
  property: PropertyDto;
  schedules: DepreciationDto[];
  currency: string;
  year: number;
}) {
  const { run, busy, message, setMessage, t } = useAction();
  const [name, setName] = useState('');
  const [basis, setBasis] = useState('');
  const [date, setDate] = useState<string>(property.purchaseDate ?? '');
  const [method, setMethod] = useState<'SL_27_5' | 'SL_39'>(
    property.type === 'commercial' ? 'SL_39' : 'SL_27_5',
  );
  return (
    <section className="card space-y-3" aria-labelledby="depreciation-title">
      <h2 id="depreciation-title" className="text-base font-semibold">
        {t('rentals.depreciation')}
      </h2>
      <p className="text-sm text-muted">{t('rentals.depreciation_note')}</p>
      {schedules.length > 0 && (
        <ul className="divide-y divide-line">
          {schedules.map((d) => (
            <li
              key={d.id}
              className="flex flex-wrap items-center justify-between gap-2 py-2"
              data-testid="depreciation-row"
            >
              <div>
                <p className="text-sm font-medium">{d.name}</p>
                <p className="text-xs text-muted">
                  <Money amount={d.basis} currency={currency} /> · {t(`rentals.method_${d.method}`)} ·{' '}
                  <DateText date={d.inServiceDate} />
                </p>
              </div>
              <div className="flex items-center gap-3 text-sm">
                <span>
                  {t('rentals.depreciation_year', { year })}: <Money amount={d.forYear} currency={currency} />
                </span>
                <button
                  type="button"
                  className="underline"
                  disabled={busy}
                  aria-label={t('rentals.delete_named', { name: d.name })}
                  onClick={() =>
                    run(() => browserApi.deleteDepreciation(workspaceId, d.id), t('rentals.deleted'))
                  }
                >
                  {t('rentals.delete')}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <form
        className="flex flex-wrap items-end gap-2"
        aria-label={t('rentals.add_depreciation')}
        onSubmit={(e) => {
          e.preventDefault();
          const b = positiveMinor(basis, currency, t);
          if (!b.ok) return setMessage({ tone: 'bad', text: b.error });
          void run(
            () =>
              browserApi.createDepreciation(workspaceId, {
                propertyId: property.id,
                name: name.trim(),
                basis: b.value,
                inServiceDate: date as never,
                method,
              }),
            t('rentals.depreciation_added'),
          ).then((r) => {
            if (r) {
              setName('');
              setBasis('');
            }
          });
        }}
      >
        <label>
          <span className="field-label">{t('rentals.depreciation_name')}</span>
          <input
            className="input w-48"
            required
            maxLength={200}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label>
          <span className="field-label">{t('rentals.basis')}</span>
          <input
            className="input w-36"
            inputMode="decimal"
            required
            value={basis}
            onChange={(e) => setBasis(e.target.value)}
          />
        </label>
        <label>
          <span className="field-label">{t('rentals.in_service')}</span>
          <input
            className="input"
            type="date"
            required
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        </label>
        <label>
          <span className="field-label">{t('rentals.method')}</span>
          <select
            className="input"
            value={method}
            onChange={(e) => setMethod(e.target.value as typeof method)}
          >
            <option value="SL_27_5">{t('rentals.method_SL_27_5')}</option>
            <option value="SL_39">{t('rentals.method_SL_39')}</option>
          </select>
        </label>
        <button type="submit" className="btn-secondary" disabled={busy}>
          {t('rentals.add_depreciation')}
        </button>
      </form>
      <StatusLine message={message} />
    </section>
  );
}

/** What this property should earn this month, against what it has (RNT-14). */
export function BudgetPanel({
  workspaceId,
  budget,
  categories,
}: {
  workspaceId: string;
  budget: PropertyBudgetDto;
  categories: CategoryDto[];
}) {
  const { run, busy, message, setMessage, t } = useAction();
  const ccy = budget.currency;
  const [reserve, setReserve] = useState(
    BigInt(budget.capexReservePerUnit) ? minorToInput(BigInt(budget.capexReservePerUnit), ccy) : '',
  );
  const [planned, setPlanned] = useState<Record<string, string>>(
    Object.fromEntries(
      budget.lines
        .filter((l) => BigInt(l.planned) > 0n)
        .map((l) => [l.categoryId, minorToInput(BigInt(l.planned), ccy)]),
    ),
  );
  return (
    <section className="card space-y-3" aria-labelledby="budget-title">
      <h2 id="budget-title" className="text-base font-semibold">
        {t('rentals.budget')}
      </h2>
      <dl className="grid gap-2 text-sm sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <dt className="text-muted">{t('rentals.expected_rent')}</dt>
          <dd>
            <Money amount={budget.expectedRent} currency={ccy} />
          </dd>
        </div>
        <div>
          <dt className="text-muted">{t('rentals.planned_expenses')}</dt>
          <dd>
            <Money amount={budget.planned} currency={ccy} />
          </dd>
        </div>
        <div>
          <dt className="text-muted">{t('rentals.capex_reserve')}</dt>
          <dd>
            <Money amount={budget.capexReserve} currency={ccy} />
          </dd>
        </div>
        <div>
          <dt className="text-muted">{t('rentals.expected_net')}</dt>
          <dd data-testid="budget-net">
            <Money amount={budget.expectedNet} currency={ccy} signed />
          </dd>
        </div>
      </dl>
      <form
        className="space-y-3"
        aria-label={t('rentals.budget')}
        onSubmit={(e) => {
          e.preventDefault();
          const r = optionalMinor(reserve, ccy, t);
          if (!r.ok) return setMessage({ tone: 'bad', text: r.error });
          const lines: { categoryId: string; amount: string }[] = [];
          for (const [categoryId, value] of Object.entries(planned)) {
            const p = optionalMinor(value, ccy, t);
            if (!p.ok) return setMessage({ tone: 'bad', text: p.error });
            if (p.value && BigInt(p.value) > 0n) lines.push({ categoryId, amount: p.value });
          }
          void run(
            () =>
              browserApi.savePropertyBudget(workspaceId, budget.propertyId, {
                capexReservePerUnit: r.value ?? '0',
                lines,
              }),
            t('rentals.budget_saved'),
          );
        }}
      >
        <label className="block max-w-xs">
          <span className="field-label">{t('rentals.reserve_per_unit')}</span>
          <input
            className="input"
            inputMode="decimal"
            value={reserve}
            onChange={(e) => setReserve(e.target.value)}
          />
        </label>
        <details>
          <summary className="cursor-pointer text-sm underline">{t('rentals.plan_expenses')}</summary>
          <table className="tbl mt-2">
            <thead>
              <tr>
                <th className="py-2 pr-2">{t('rentals.category')}</th>
                <th className="px-2 py-2 text-right">{t('rentals.spent')}</th>
                <th className="py-2 pl-2 text-right">{t('rentals.planned')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {categories.map((c) => {
                const line = budget.lines.find((l) => l.categoryId === c.id);
                return (
                  <tr key={c.id}>
                    <td className="py-1 pr-2 text-sm">{c.name}</td>
                    <td className="px-2 py-1 text-right text-sm">
                      <Money amount={line?.spent ?? '0'} currency={ccy} />
                    </td>
                    <td className="py-1 pl-2 text-right">
                      <input
                        className="input ml-auto w-28 text-right"
                        inputMode="decimal"
                        aria-label={t('rentals.planned_for', { name: c.name })}
                        value={planned[c.id] ?? ''}
                        onChange={(e) => setPlanned({ ...planned, [c.id]: e.target.value })}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </details>
        <button type="submit" className="btn-secondary" disabled={busy}>
          {t('rentals.save_budget')}
        </button>
        <StatusLine message={message} />
      </form>
    </section>
  );
}
