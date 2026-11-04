'use client';

import { Plus, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { CategoryDto, InvoiceDto, PartyDto } from '@montra/api-client';
import { browserApi } from '@/lib/browser-api';
import { buildLines, emptyRow, liveTotals, rowsOf, type InvoiceRow } from '@/lib/business';
import { useI18n } from '../i18n';
import { Money } from '../money';
import { StatusLine, useAction } from '../use-action';

const NEW = '__new';

/** Drafting an invoice (BIZ-05): a customer, dates and lines with tax. Only a draft can change. */
export function InvoiceEditor({
  workspaceId,
  entityId,
  currency,
  customers,
  incomeCategories,
  today,
  invoice,
}: {
  workspaceId: string;
  entityId: string;
  currency: string;
  customers: PartyDto[];
  incomeCategories: CategoryDto[];
  today: string;
  invoice?: InvoiceDto;
}) {
  const router = useRouter();
  const { locale } = useI18n();
  const { run, busy, message, setMessage, t } = useAction();
  const defaultCategory =
    incomeCategories.find((c) => c.name === 'Sales & services')?.id ?? incomeCategories[0]?.id ?? '';
  const [nextKey, setNextKey] = useState(1);
  const [rows, setRows] = useState<InvoiceRow[]>(
    invoice ? rowsOf(invoice) : [emptyRow('new-0', defaultCategory)],
  );
  const [partyId, setPartyId] = useState(invoice?.partyId ?? customers.find((c) => c.id)?.id ?? NEW);
  const [newName, setNewName] = useState('');
  const [newEmail, setNewEmail] = useState('');
  const [issueDate, setIssueDate] = useState<string>(invoice?.issueDate ?? today);
  const [dueDate, setDueDate] = useState<string>(invoice?.dueDate ?? '');
  const [notes, setNotes] = useState(invoice?.notes ?? '');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const totals = liveTotals(rows, currency, locale);
  const setRow = (key: string, patch: Partial<InvoiceRow>) =>
    setRows((list) => list.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const known = customers.filter((c) => c.id !== null && !c.archived);
  // Found from transactions but with no details yet: picking one creates it.
  const found = customers.filter((c) => c.id === null);

  async function save() {
    const built = buildLines(rows, currency, locale, t);
    if (!built.ok) {
      setErrors(built.errors);
      setMessage({ tone: 'bad', text: t('invoices.fix_fields') });
      return;
    }
    if (partyId === NEW && !newName.trim()) {
      setErrors({ party: t('invoices.customer_required') });
      setMessage({ tone: 'bad', text: t('invoices.fix_fields') });
      return;
    }
    setErrors({});
    const saved = await run(async () => {
      let customer = partyId;
      if (partyId === NEW) {
        const created = await browserApi.createParty(workspaceId, {
          entityId,
          kind: 'customer',
          name: newName.trim(),
          ...(newEmail.trim() ? { email: newEmail.trim() } : {}),
        });
        customer = created.id!;
      } else if (partyId.startsWith('key:')) {
        const p = found.find((c) => `key:${c.payeeKey}` === partyId)!;
        const created = await browserApi.createParty(workspaceId, {
          entityId,
          kind: 'customer',
          name: p.name,
          payeeKey: p.payeeKey,
        });
        customer = created.id!;
      }
      const body = {
        partyId: customer,
        issueDate,
        ...(dueDate ? { dueDate } : {}),
        notes: notes.trim() || null,
        lines: built.lines,
      };
      return invoice
        ? browserApi.updateInvoice(workspaceId, invoice.id, { ...body, version: invoice.version })
        : browserApi.createInvoice(workspaceId, { entityId, ...body });
    }, t('invoices.saved'));
    if (saved && !invoice) router.push(`/w/${workspaceId}/business/${entityId}/invoices/${saved.id}`);
  }

  return (
    <div className="space-y-4">
      <section className="card grid gap-3 sm:grid-cols-2 lg:grid-cols-3" aria-label={t('invoices.details')}>
        <label className="lg:col-span-1">
          <span className="field-label">{t('invoices.customer')}</span>
          <select className="input" value={partyId} onChange={(e) => setPartyId(e.target.value)}>
            {known.map((c) => (
              <option key={c.id} value={c.id!}>
                {c.name}
              </option>
            ))}
            {found.map((c) => (
              <option key={c.payeeKey} value={`key:${c.payeeKey}`}>
                {c.name}
              </option>
            ))}
            <option value={NEW}>{t('invoices.new_customer')}</option>
          </select>
        </label>
        {partyId === NEW && (
          <>
            <label>
              <span className="field-label">{t('invoices.customer_name')}</span>
              <input
                className="input"
                value={newName}
                maxLength={200}
                aria-invalid={errors.party ? 'true' : undefined}
                onChange={(e) => setNewName(e.target.value)}
              />
              {errors.party && (
                <span className="field-error" role="alert">
                  {errors.party}
                </span>
              )}
            </label>
            <label>
              <span className="field-label">{t('invoices.customer_email')}</span>
              <input
                className="input"
                type="email"
                value={newEmail}
                onChange={(e) => setNewEmail(e.target.value)}
              />
            </label>
          </>
        )}
        <label>
          <span className="field-label">{t('invoices.issue_date')}</span>
          <input
            className="input"
            type="date"
            value={issueDate}
            onChange={(e) => setIssueDate(e.target.value)}
          />
        </label>
        <label>
          <span className="field-label">{t('invoices.due_date')}</span>
          <input className="input" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
          {!dueDate && <span className="mt-1 block text-xs text-muted">{t('invoices.due_default')}</span>}
        </label>
      </section>

      <section className="card space-y-2" aria-label={t('invoices.lines')}>
        <h2 className="text-sm font-semibold">{t('invoices.lines')}</h2>
        {rows.map((r) => {
          const name = r.description || t('invoices.this_line');
          const err = (f: string) => errors[`${r.key}.${f}`];
          return (
            <div
              key={r.key}
              data-testid="invoice-line"
              className="grid items-start gap-2 sm:grid-cols-[minmax(0,1fr)_5rem_7rem_5rem_11rem_auto]"
            >
              <Cell label={t('invoices.description')} error={err('description')}>
                <input
                  className="input"
                  value={r.description}
                  maxLength={500}
                  placeholder={t('invoices.description')}
                  onChange={(e) => setRow(r.key, { description: e.target.value })}
                />
              </Cell>
              <Cell label={t('invoices.quantity_of', { name })} error={err('quantity')}>
                <input
                  className="input"
                  inputMode="decimal"
                  value={r.quantity}
                  placeholder={t('invoices.quantity')}
                  onChange={(e) => setRow(r.key, { quantity: e.target.value })}
                />
              </Cell>
              <Cell label={t('invoices.price_of', { name })} error={err('unitPrice')}>
                <input
                  className="input"
                  inputMode="decimal"
                  value={r.unitPrice}
                  placeholder={t('invoices.price')}
                  onChange={(e) => setRow(r.key, { unitPrice: e.target.value })}
                />
              </Cell>
              <Cell label={t('invoices.tax_of', { name })} error={err('taxRate')}>
                <input
                  className="input"
                  inputMode="decimal"
                  value={r.taxRate}
                  placeholder={t('invoices.tax_percent')}
                  onChange={(e) => setRow(r.key, { taxRate: e.target.value })}
                />
              </Cell>
              <Cell label={t('invoices.category_of', { name })}>
                <select
                  className="input"
                  value={r.incomeAccountId}
                  onChange={(e) => setRow(r.key, { incomeAccountId: e.target.value })}
                >
                  {incomeCategories.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </Cell>
              <button
                type="button"
                className="icon-btn"
                disabled={rows.length === 1}
                onClick={() => setRows((list) => list.filter((x) => x.key !== r.key))}
                aria-label={t('invoices.remove_line', { name })}
              >
                <X aria-hidden size={15} />
              </button>
            </div>
          );
        })}
        <button
          type="button"
          className="btn-secondary"
          onClick={() => {
            setRows((list) => [...list, emptyRow(`new-${nextKey}`, defaultCategory)]);
            setNextKey((n) => n + 1);
          }}
        >
          <Plus aria-hidden size={14} /> {t('invoices.add_line')}
        </button>
        <dl className="ml-auto max-w-xs space-y-1 border-t border-line pt-2 text-sm">
          <div className="flex justify-between gap-4">
            <dt>{t('invoices.subtotal')}</dt>
            <dd>
              <Money amount={totals.subtotal} currency={currency} />
            </dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt>{t('invoices.tax')}</dt>
            <dd>
              <Money amount={totals.tax} currency={currency} />
            </dd>
          </div>
          <div className="flex justify-between gap-4 font-semibold">
            <dt>{t('invoices.total')}</dt>
            <dd data-testid="invoice-total">
              <Money amount={totals.total} currency={currency} />
            </dd>
          </div>
        </dl>
      </section>

      <label className="card block">
        <span className="field-label">{t('invoices.notes')}</span>
        <textarea
          className="input"
          rows={2}
          maxLength={2000}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
        />
      </label>
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" className="btn-primary" disabled={busy} onClick={save}>
          {t('invoices.save_draft')}
        </button>
        <StatusLine message={message} />
      </div>
    </div>
  );
}

function Cell({ label, error, children }: { label: string; error?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="sr-only">{label}</span>
      {children}
      {error && (
        <span className="field-error" role="alert">
          {error}
        </span>
      )}
    </label>
  );
}
