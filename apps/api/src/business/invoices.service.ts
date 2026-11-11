/**
 * Invoices (BIZ-05, ADR-0017). Cash basis: an invoice posts nothing until it's paid, and a payment becomes income in the
 * invoice's categories, with its sales tax in a liability. Stored status is draft, sent or void; the rest is derived.
 */
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { newId, type InvoiceLineRow, type InvoiceRow, type Trx } from '@montra/db';
import {
  addDays,
  allocatePayment,
  asCurrencyCode,
  calendarDate,
  formatMoney,
  INVOICE_MATCH_DAYS_AFTER,
  invoiceLineAmounts,
  invoiceStatus,
  invoiceTotals,
  money,
  type CalendarDate,
} from '@montra/domain';
import type {
  CreateInvoiceRequest,
  InvoiceDto,
  InvoiceLineInput,
  InvoiceStatus,
  PaymentCandidateDto,
  RecordPaymentRequest,
  SendInvoiceRequest,
  UpdateInvoiceRequest,
} from '@montra/schemas';
import { AppError, notFound, unprocessable } from '../common/errors.js';
import { Db } from '../db/database.js';
import { MAIL_PORT, type MailPort } from '../mail/mail.service.js';
import { STORAGE_PORT, type StoragePort } from '../storage/storage.js';
import type { SplitSpec } from '../transactions/poster.js';
import { BusinessService } from './business.service.js';
import { renderInvoicePdf } from './invoice-pdf.js';
import { PaymentLinks } from './payment-links.service.js';
import { businessEntity, dateOf, formatScaled, parseScaled, todayOf, type Ctx } from './shared.js';

const conflict = () =>
  new AppError(409, 'version.conflict', 'Someone else changed this; reload and try again');

@Injectable()
export class InvoicesService {
  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(BusinessService) private readonly business: BusinessService,
    @Inject(PaymentLinks) private readonly links: PaymentLinks,
    @Inject(STORAGE_PORT) private readonly storage: StoragePort,
    @Inject(MAIL_PORT) private readonly mail: MailPort,
  ) {}

  // ----- Reading -------------------------------------------------------------------------------------------

  async list(
    ctx: Ctx,
    q: { entityId: string; status?: InvoiceStatus; partyId?: string },
  ): Promise<InvoiceDto[]> {
    return this.db.run(ctx, async (trx) => {
      const e = await businessEntity(trx, ctx, q.entityId);
      const rows = await trx
        .selectFrom('app.invoice')
        .selectAll()
        .where('workspace_id', '=', ctx.workspaceId)
        .where('entity_id', '=', q.entityId)
        .$if(!!q.partyId, (x) => x.where('party_id', '=', q.partyId!))
        .orderBy('issue_date', 'desc')
        .orderBy('number', 'desc')
        .limit(500)
        .execute();
      const today = todayOf(e);
      const out: InvoiceDto[] = [];
      for (const r of rows) out.push(await this.dto(trx, ctx, r, today));
      return q.status ? out.filter((i) => i.status === q.status) : out;
    });
  }

  async get(ctx: Ctx, id: string): Promise<InvoiceDto> {
    return this.db.run(ctx, async (trx) => {
      const r = await this.row(trx, ctx, id);
      const e = await businessEntity(trx, ctx, r.entity_id);
      return this.dto(trx, ctx, r, todayOf(e));
    });
  }

  private async row(trx: Trx, ctx: Ctx, id: string): Promise<InvoiceRow> {
    const r = await trx
      .selectFrom('app.invoice')
      .selectAll()
      .where('workspace_id', '=', ctx.workspaceId)
      .where('id', '=', id)
      .executeTakeFirst();
    if (!r) throw notFound('Invoice');
    return r;
  }

  private async linesOf(trx: Trx, ctx: Ctx, id: string): Promise<InvoiceLineRow[]> {
    return trx
      .selectFrom('app.invoice_line')
      .selectAll()
      .where('workspace_id', '=', ctx.workspaceId)
      .where('invoice_id', '=', id)
      .orderBy('line_no')
      .execute();
  }

  private async paymentsOf(trx: Trx, ctx: Ctx, id: string) {
    return trx
      .selectFrom('app.invoice_payment as p')
      .innerJoin('app.transaction as t', (j) =>
        j.onRef('t.workspace_id', '=', 'p.workspace_id').onRef('t.id', '=', 'p.transaction_id'),
      )
      .select(['p.id', 'p.transaction_id', 'p.amount_minor', 'p.source', 'p.deposit_spec', 't.txn_date'])
      .where('p.workspace_id', '=', ctx.workspaceId)
      .where('p.invoice_id', '=', id)
      .orderBy('t.txn_date')
      .orderBy('p.created_at')
      .execute();
  }

  private async dto(trx: Trx, ctx: Ctx, r: InvoiceRow, today: CalendarDate): Promise<InvoiceDto> {
    const [lines, payments, party] = await Promise.all([
      this.linesOf(trx, ctx, r.id),
      this.paymentsOf(trx, ctx, r.id),
      this.business.partyRow(trx, ctx, r.party_id),
    ]);
    const total = BigInt(r.total_minor);
    const paid = payments.reduce((t, p) => t + BigInt(p.amount_minor), 0n);
    return {
      id: r.id,
      entityId: r.entity_id,
      partyId: r.party_id,
      partyName: party?.name ?? '',
      number: r.number,
      status: invoiceStatus(r.status, total, paid, dateOf(r.due_date), today),
      issueDate: dateOf(r.issue_date),
      dueDate: dateOf(r.due_date),
      currency: asCurrencyCode(r.currency),
      subtotal: String(r.subtotal_minor),
      tax: String(r.tax_minor),
      total: String(total),
      paid: String(paid),
      open: String(total - paid),
      notes: r.notes,
      sentAt: r.sent_at ? r.sent_at.toISOString() : null,
      sentTo: r.sent_to,
      lines: lines.map((l) => ({
        id: l.id,
        lineNo: l.line_no,
        description: l.description,
        quantity: formatScaled(BigInt(l.quantity_milli), 3),
        unitPrice: String(l.unit_price_minor),
        taxRateBps: l.tax_rate_bps,
        amount: String(l.amount_minor),
        tax: String(l.tax_minor),
        incomeAccountId: l.income_account_id,
      })),
      payments: payments.map((p) => ({
        id: p.id,
        transactionId: p.transaction_id,
        date: dateOf(p.txn_date),
        amount: String(p.amount_minor),
        source: p.source,
      })),
      version: Number(r.version),
    };
  }

  // ----- Writing -------------------------------------------------------------------------------------------

  async create(ctx: Ctx, req: CreateInvoiceRequest): Promise<InvoiceDto> {
    return this.db.run(ctx, async (trx) => {
      const e = await businessEntity(trx, ctx, req.entityId);
      const party = await this.business.partyRow(trx, ctx, req.partyId);
      if (!party || party.entity_id !== e.id || party.kind !== 'customer') {
        throw unprocessable('invoice.party', 'Choose a customer of this business');
      }
      await this.business.ensureProfile(trx, ctx, e.id);
      // Numbers come from the profile row, locked by the update, so two invoices can't get the same one.
      const counter = await trx
        .updateTable('app.business_profile')
        .set((eb) => ({ next_invoice_number: eb('next_invoice_number', '+', 1) }))
        .where('workspace_id', '=', ctx.workspaceId)
        .where('entity_id', '=', e.id)
        .returning(['next_invoice_number', 'invoice_prefix', 'default_terms_days'])
        .executeTakeFirstOrThrow();
      const number = `${counter.invoice_prefix}${String(counter.next_invoice_number - 1).padStart(4, '0')}`;
      const due = req.dueDate ?? addDays(req.issueDate, party.terms_days ?? counter.default_terms_days);
      const id = newId();
      await trx
        .insertInto('app.invoice')
        .values({
          workspace_id: ctx.workspaceId,
          id,
          entity_id: e.id,
          party_id: party.id,
          number,
          issue_date: req.issueDate,
          due_date: due,
          currency: e.currency,
          notes: req.notes ?? null,
          created_by: ctx.userId,
        })
        .execute();
      await this.writeLines(trx, ctx, id, e.id, req.lines);
      return this.dto(trx, ctx, await this.row(trx, ctx, id), todayOf(e));
    });
  }

  async update(ctx: Ctx, id: string, req: UpdateInvoiceRequest): Promise<InvoiceDto> {
    return this.db.run(ctx, async (trx) => {
      const r = await this.row(trx, ctx, id);
      if (r.status !== 'draft') {
        throw unprocessable(
          'invoice.not_draft',
          'What has been sent stays as sent: void it and issue another',
        );
      }
      if (BigInt(r.version) !== BigInt(req.version)) throw conflict();
      const e = await businessEntity(trx, ctx, r.entity_id);
      if (req.partyId) {
        const party = await this.business.partyRow(trx, ctx, req.partyId);
        if (!party || party.entity_id !== e.id || party.kind !== 'customer') {
          throw unprocessable('invoice.party', 'Choose a customer of this business');
        }
      }
      await trx
        .updateTable('app.invoice')
        .set({
          ...(req.partyId !== undefined ? { party_id: req.partyId } : {}),
          ...(req.issueDate !== undefined ? { issue_date: req.issueDate } : {}),
          ...(req.dueDate !== undefined ? { due_date: req.dueDate } : {}),
          ...(req.notes !== undefined ? { notes: req.notes } : {}),
        })
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', id)
        .execute();
      if (req.lines) await this.writeLines(trx, ctx, id, e.id, req.lines);
      return this.dto(trx, ctx, await this.row(trx, ctx, id), todayOf(e));
    });
  }

  private async writeLines(
    trx: Trx,
    ctx: Ctx,
    invoiceId: string,
    entityId: string,
    lines: InvoiceLineInput[],
  ): Promise<void> {
    const income = await trx
      .selectFrom('app.ledger_account')
      .select('id')
      .where('workspace_id', '=', ctx.workspaceId)
      .where('entity_id', '=', entityId)
      .where('type', '=', 'income')
      .where('is_category', '=', true)
      .where('archived_at', 'is', null)
      .where('system_role', 'is', null)
      .orderBy('name', 'desc') // "Sales & services" before "Other business income"
      .execute();
    const valid = new Set(income.map((a) => a.id));
    const fallback = income[0]?.id;
    const inputs = lines.map((l) => ({
      quantityMilli: parseScaled(l.quantity, 3),
      unitPrice: BigInt(l.unitPrice),
      taxRateBps: l.taxRateBps,
    }));
    if (inputs.some((l) => l.quantityMilli <= 0n)) {
      throw unprocessable('invoice.quantity', 'Enter a quantity above zero');
    }
    const totals = invoiceTotals(inputs);
    await trx
      .deleteFrom('app.invoice_line')
      .where('workspace_id', '=', ctx.workspaceId)
      .where('invoice_id', '=', invoiceId)
      .execute();
    await trx
      .insertInto('app.invoice_line')
      .values(
        lines.map((l, i) => {
          const account = l.incomeAccountId ?? fallback;
          if (!account || !valid.has(account)) {
            throw unprocessable('invoice.income_category', 'Choose an income category of this business');
          }
          const a = invoiceLineAmounts(inputs[i]!);
          return {
            workspace_id: ctx.workspaceId,
            id: newId(),
            invoice_id: invoiceId,
            line_no: i + 1,
            description: l.description,
            quantity_milli: inputs[i]!.quantityMilli,
            unit_price_minor: inputs[i]!.unitPrice,
            tax_rate_bps: l.taxRateBps,
            amount_minor: a.amount,
            tax_minor: a.tax,
            income_account_id: account,
          };
        }),
      )
      .execute();
    await trx
      .updateTable('app.invoice')
      .set({ subtotal_minor: totals.subtotal, tax_minor: totals.tax, total_minor: totals.total })
      .where('workspace_id', '=', ctx.workspaceId)
      .where('id', '=', invoiceId)
      .execute();
  }

  /** Only a draft goes away entirely: once sent, an invoice is a record, and voiding keeps it. */
  async remove(ctx: Ctx, id: string): Promise<void> {
    await this.db.run(ctx, async (trx) => {
      const r = await this.row(trx, ctx, id);
      if (r.status !== 'draft') throw unprocessable('invoice.not_draft', 'Void a sent invoice instead');
      await trx
        .deleteFrom('app.invoice')
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', id)
        .execute();
    });
  }

  async voidInvoice(ctx: Ctx, id: string, version: number): Promise<InvoiceDto> {
    return this.db.run(ctx, async (trx) => {
      const r = await this.row(trx, ctx, id);
      if (BigInt(r.version) !== BigInt(version)) throw conflict();
      if ((await this.paymentsOf(trx, ctx, id)).length) {
        throw unprocessable('invoice.has_payments', 'Remove its payments before voiding it');
      }
      const row = await trx
        .updateTable('app.invoice')
        .set({ status: 'void' })
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirstOrThrow();
      return this.dto(trx, ctx, row, todayOf(await businessEntity(trx, ctx, r.entity_id)));
    });
  }

  // ----- Sending -------------------------------------------------------------------------------------------

  /** The PDF as sent, or as it would be for a draft. */
  async pdf(ctx: Ctx, id: string): Promise<{ bytes: Uint8Array; fileName: string }> {
    return this.db.run(ctx, async (trx) => {
      const r = await this.row(trx, ctx, id);
      if (r.pdf_file_id) {
        const f = await this.business.fileBytes(trx, ctx, r.pdf_file_id);
        return { bytes: f.bytes, fileName: `${r.number}.pdf` };
      }
      return { bytes: await this.render(trx, ctx, r), fileName: `${r.number}.pdf` };
    });
  }

  private async render(trx: Trx, ctx: Ctx, r: InvoiceRow): Promise<Uint8Array> {
    const e = await businessEntity(trx, ctx, r.entity_id);
    const profile = await this.business.readProfile(trx, ctx, r.entity_id);
    const party = await this.business.partyRow(trx, ctx, r.party_id);
    const lines = await this.linesOf(trx, ctx, r.id);
    const fmt = (m: bigint | string) =>
      formatMoney(money(BigInt(m), asCurrencyCode(r.currency)), { locale: 'en-US' });
    const dates = (d: unknown) => {
      const [y, m, day] = String(dateOf(d)).split('-');
      return `${m}/${day}/${y}`;
    };
    return renderInvoicePdf({
      business: {
        name: e.name,
        legalName: profile.legal_name,
        address: profile.address,
        email: profile.email,
        domain: profile.domain,
        logo: await this.business.logoIn(trx, ctx, r.entity_id),
      },
      customer: { name: party?.name ?? '', address: party?.address ?? null, email: party?.email ?? null },
      number: r.number,
      issueDate: dates(r.issue_date),
      dueDate: dates(r.due_date),
      notes: r.notes,
      lines: lines.map((l) => ({
        description: l.description,
        quantity: formatScaled(BigInt(l.quantity_milli), 3),
        unitPrice: fmt(l.unit_price_minor),
        taxRate: l.tax_rate_bps ? `Tax ${formatScaled(l.tax_rate_bps, 2)}%` : null,
        amount: fmt(l.amount_minor),
      })),
      subtotal: fmt(r.subtotal_minor),
      tax: fmt(r.tax_minor),
      total: fmt(r.total_minor),
      paid: null,
      open: null,
      labels: {
        invoice: 'Invoice',
        billTo: 'Bill to',
        issued: 'Issued',
        due: 'Due',
        description: 'Description',
        quantity: 'Qty',
        price: 'Price',
        amount: 'Amount',
        subtotal: 'Subtotal',
        tax: 'Tax',
        total: 'Total',
        paid: 'Paid',
        open: 'Balance due',
      },
    });
  }

  /**
   * Keeps the PDF, marks it sent and emails it. The email is last and inside the transaction: if it fails nothing is
   * marked sent, so the user sees the failure and can retry, rather than believing a customer has it.
   */
  async send(ctx: Ctx, id: string, req: SendInvoiceRequest): Promise<InvoiceDto> {
    return this.db.run(ctx, async (trx) => {
      const r = await this.row(trx, ctx, id);
      if (r.status === 'void') throw unprocessable('invoice.void', 'This invoice was voided');
      if (BigInt(r.version) !== BigInt(req.version)) throw conflict();
      if (BigInt(r.total_minor) <= 0n)
        throw unprocessable('invoice.empty', 'This invoice has nothing to pay');
      const e = await businessEntity(trx, ctx, r.entity_id);
      const party = await this.business.partyRow(trx, ctx, r.party_id);
      const to = req.email ? (req.to ?? party?.email ?? null) : null;
      if (req.email && !to) {
        throw unprocessable(
          'invoice.no_email',
          'Add an email address for this customer, or enter one to send to',
        );
      }
      let fileId = r.pdf_file_id;
      let bytes: Uint8Array;
      if (fileId) {
        bytes = (await this.business.fileBytes(trx, ctx, fileId)).bytes;
      } else {
        bytes = await this.render(trx, ctx, r);
        fileId = await this.business.storeFile(ctx, bytes, `${r.number}.pdf`, 'application/pdf', trx);
      }
      const row = await trx
        .updateTable('app.invoice')
        .set({
          status: 'sent',
          pdf_file_id: fileId,
          sent_at: new Date(),
          sent_to: to ?? r.sent_to,
        })
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirstOrThrow();
      if (to) {
        const profile = await this.business.readProfile(trx, ctx, r.entity_id);
        const from = profile.legal_name ?? e.name;
        const total = formatMoney(money(BigInt(r.total_minor), asCurrencyCode(r.currency)), {
          locale: 'en-US',
        });
        const lines = [
          ...(req.message ? [req.message, ''] : []),
          `Invoice ${r.number} from ${from} is attached.`,
          `Total ${total}, due ${String(dateOf(r.due_date))}.`,
        ];
        await this.mail.send({
          to,
          subject: `Invoice ${r.number} from ${from}`,
          text: lines.join('\n'),
          category: 'invoice',
          ...(profile.email ? { replyTo: profile.email } : {}),
          attachments: [{ filename: `${r.number}.pdf`, content: bytes, contentType: 'application/pdf' }],
        });
      }
      return this.dto(trx, ctx, row, todayOf(e));
    });
  }

  // ----- Payments ------------------------------------------------------------------------------------------

  async candidates(ctx: Ctx, id: string): Promise<PaymentCandidateDto[]> {
    return this.db.run(ctx, async (trx) => {
      const r = await this.row(trx, ctx, id);
      const paid = (await this.paymentsOf(trx, ctx, id)).reduce((t, p) => t + BigInt(p.amount_minor), 0n);
      const issue = dateOf(r.issue_date);
      return this.links.candidates(trx, ctx, {
        sign: 1,
        currency: r.currency,
        max: BigInt(r.total_minor) - paid,
        from: issue,
        to: addDays(issue, INVOICE_MATCH_DAYS_AFTER),
        near: dateOf(r.due_date),
      });
    });
  }

  async recordPayment(ctx: Ctx, id: string, req: RecordPaymentRequest, source: 'auto' | 'manual' = 'manual') {
    return this.db.run(ctx, (trx) => this.recordPaymentIn(trx, ctx, id, req, source));
  }

  async recordPaymentIn(
    trx: Trx,
    ctx: Ctx,
    id: string,
    req: RecordPaymentRequest,
    source: 'auto' | 'manual',
  ): Promise<InvoiceDto> {
    const r = await trx
      .selectFrom('app.invoice')
      .selectAll()
      .where('workspace_id', '=', ctx.workspaceId)
      .where('id', '=', id)
      .forUpdate()
      .executeTakeFirst();
    if (!r) throw notFound('Invoice');
    if (r.status !== 'sent')
      throw unprocessable('invoice.not_sent', 'Send this invoice before recording a payment');
    const e = await businessEntity(trx, ctx, r.entity_id);
    const before = await this.paymentsOf(trx, ctx, id);
    const paid = before.reduce((t, p) => t + BigInt(p.amount_minor), 0n);
    const open = BigInt(r.total_minor) - paid;
    const owner = { invoiceId: id };

    const splitsFor = async (amount: bigint): Promise<SplitSpec[]> => {
      if (amount > open)
        throw unprocessable('invoice.overpaid', 'This is more than is still owed on the invoice');
      const lines = await this.linesOf(trx, ctx, id);
      const parts = lines.map((l) => ({ key: l.income_account_id, weight: BigInt(l.amount_minor) }));
      if (BigInt(r.tax_minor) > 0n) {
        parts.push({
          key: await this.salesTaxAccount(trx, ctx, e.id, r.currency),
          weight: BigInt(r.tax_minor),
        });
      }
      const merged = new Map<string, bigint>();
      for (const s of allocatePayment(parts, paid, amount)) {
        merged.set(s.key, (merged.get(s.key) ?? 0n) + s.amount);
      }
      return [...merged].map(([accountId, a]) => ({ accountId, amount: String(a), memberId: null }));
    };

    let transactionId: string;
    let amount: bigint;
    let depositSpec: unknown = null;
    if ('transactionId' in req) {
      const t = await trx
        .selectFrom('app.transaction')
        .select('spec')
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', req.transactionId)
        .executeTakeFirst();
      if (!t) throw notFound('Transaction');
      const size = BigInt((t.spec as { amount?: string } | null)?.amount ?? '0');
      const taken = await this.links.takeOver(trx, ctx, req.transactionId, owner, await splitsFor(size), {
        sign: 1,
        currency: r.currency,
      });
      transactionId = req.transactionId;
      amount = taken.amount;
      depositSpec = taken.previous;
    } else {
      amount = BigInt(req.amount);
      const party = await this.business.partyRow(trx, ctx, r.party_id);
      transactionId = await this.links.create(trx, ctx, {
        entityId: e.id,
        accountId: req.accountId,
        date: req.date,
        amount,
        currency: r.currency,
        payee: party?.name ?? r.number,
        payeeKey: party?.payee_key ?? null,
        description: `Payment for ${r.number}`,
        source: 'invoice',
        owner,
        splits: await splitsFor(amount),
      });
    }
    await trx
      .insertInto('app.invoice_payment')
      .values({
        workspace_id: ctx.workspaceId,
        id: newId(),
        invoice_id: id,
        entity_id: e.id,
        transaction_id: transactionId,
        amount_minor: amount,
        source,
        deposit_spec: depositSpec ? JSON.stringify(depositSpec) : null,
        created_by: ctx.userId,
      })
      .execute();
    return this.dto(trx, ctx, await this.row(trx, ctx, id), todayOf(e));
  }

  /** Later payments were split from what came before, so they go first: only the latest can be removed. */
  async removePayment(ctx: Ctx, id: string, paymentId: string): Promise<InvoiceDto> {
    return this.db.run(ctx, async (trx) => {
      const r = await this.row(trx, ctx, id);
      const payments = await this.paymentsOf(trx, ctx, id);
      const p = payments.find((x) => x.id === paymentId);
      if (!p) throw notFound('Payment');
      if (payments[payments.length - 1]!.id !== paymentId) {
        throw unprocessable('invoice.later_payment', 'Remove the later payment first');
      }
      await trx
        .deleteFrom('app.invoice_payment')
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', paymentId)
        .execute();
      await this.links.release(trx, ctx, p.transaction_id, p.deposit_spec);
      return this.dto(trx, ctx, r, todayOf(await businessEntity(trx, ctx, r.entity_id)));
    });
  }

  /** Sales tax collected isn't income: it's owed on. Created the first time a business collects any. */
  private async salesTaxAccount(trx: Trx, ctx: Ctx, entityId: string, currency: string): Promise<string> {
    const existing = await trx
      .selectFrom('app.ledger_account')
      .select('id')
      .where('workspace_id', '=', ctx.workspaceId)
      .where('entity_id', '=', entityId)
      .where('system_role', '=', 'sales_tax_payable')
      .executeTakeFirst();
    if (existing) return existing.id;
    const id = newId();
    await trx
      .insertInto('app.ledger_account')
      .values({
        workspace_id: ctx.workspaceId,
        id,
        entity_id: entityId,
        name: 'Sales tax payable',
        type: 'liability',
        currency,
        is_category: false,
        system_role: 'sales_tax_payable',
      })
      .execute();
    return id;
  }

  /** Open balances, for matching and the forecast. */
  async openInvoices(trx: Trx, ctx: Ctx, entityId?: string) {
    const { rows } = await sql<{
      id: string;
      entity_id: string;
      number: string;
      issue_date: string;
      due_date: string;
      currency: string;
      party_name: string;
      open: string;
    }>`
      select i.id, i.entity_id, i.number, i.issue_date::text, i.due_date::text, i.currency, py.name as party_name,
             (i.total_minor - coalesce((select sum(p.amount_minor) from app.invoice_payment p
                where p.workspace_id = i.workspace_id and p.invoice_id = i.id), 0))::text as open
        from app.invoice i
        join app.business_party py on py.workspace_id = i.workspace_id and py.id = i.party_id
       where i.workspace_id = ${ctx.workspaceId} and i.status = 'sent'
         ${entityId ? sql`and i.entity_id = ${entityId}` : sql``}`.execute(trx);
    return rows
      .map((r) => ({
        id: r.id,
        entityId: r.entity_id,
        number: r.number,
        issueDate: calendarDate(r.issue_date),
        dueDate: calendarDate(r.due_date),
        currency: r.currency,
        partyName: r.party_name,
        open: BigInt(r.open),
      }))
      .filter((r) => r.open > 0n);
  }
}
