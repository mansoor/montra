/**
 * Bills (BIZ-06, ADR-0017). Cash basis: a bill posts nothing until it's paid. Until then it's in the forecast and the
 * calendar. A payment is the exact amount; partly paying a bill is outside R1.
 */
import { Inject, Injectable } from '@nestjs/common';
import { newId, type BillRow, type Trx } from '@montra/db';
import { addDays, asCurrencyCode, BILL_MATCH_DAYS, type CalendarDate } from '@montra/domain';
import type {
  BillDto,
  BillStatus,
  CreateBillRequest,
  PaymentCandidateDto,
  RecordPaymentRequest,
  UpdateBillRequest,
} from '@montra/schemas';
import { AppError, notFound, unprocessable } from '../common/errors.js';
import { Db } from '../db/database.js';
import { BusinessService } from './business.service.js';
import { PaymentLinks } from './payment-links.service.js';
import { businessEntity, dateOf, todayOf, type Ctx } from './shared.js';

const conflict = () =>
  new AppError(409, 'version.conflict', 'Someone else changed this; reload and try again');

@Injectable()
export class BillsService {
  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(BusinessService) private readonly business: BusinessService,
    @Inject(PaymentLinks) private readonly links: PaymentLinks,
  ) {}

  async list(ctx: Ctx, q: { entityId: string; status?: BillStatus; partyId?: string }): Promise<BillDto[]> {
    return this.db.run(ctx, async (trx) => {
      const e = await businessEntity(trx, ctx, q.entityId);
      const rows = await trx
        .selectFrom('app.bill')
        .selectAll()
        .where('workspace_id', '=', ctx.workspaceId)
        .where('entity_id', '=', q.entityId)
        .$if(!!q.partyId, (x) => x.where('party_id', '=', q.partyId!))
        .orderBy('due_date', 'desc')
        .limit(500)
        .execute();
      const today = todayOf(e);
      const out: BillDto[] = [];
      for (const r of rows) out.push(await this.dto(trx, ctx, r, today));
      return q.status ? out.filter((b) => b.status === q.status) : out;
    });
  }

  async get(ctx: Ctx, id: string): Promise<BillDto> {
    return this.db.run(ctx, async (trx) => {
      const r = await this.row(trx, ctx, id);
      return this.dto(trx, ctx, r, todayOf(await businessEntity(trx, ctx, r.entity_id)));
    });
  }

  private async row(trx: Trx, ctx: Ctx, id: string): Promise<BillRow> {
    const r = await trx
      .selectFrom('app.bill')
      .selectAll()
      .where('workspace_id', '=', ctx.workspaceId)
      .where('id', '=', id)
      .executeTakeFirst();
    if (!r) throw notFound('Bill');
    return r;
  }

  private async dto(trx: Trx, ctx: Ctx, r: BillRow, today: CalendarDate): Promise<BillDto> {
    const party = await this.business.partyRow(trx, ctx, r.party_id);
    const due = dateOf(r.due_date);
    return {
      id: r.id,
      entityId: r.entity_id,
      partyId: r.party_id,
      partyName: party?.name ?? '',
      reference: r.reference,
      status: r.status === 'open' && due < today ? 'overdue' : r.status,
      billDate: dateOf(r.bill_date),
      dueDate: due,
      currency: asCurrencyCode(r.currency),
      amount: String(r.amount_minor),
      expenseAccountId: r.expense_account_id,
      notes: r.notes,
      fileIds: r.attachment_ids,
      transactionId: r.transaction_id,
      version: Number(r.version),
    };
  }

  private async checkLinks(
    trx: Trx,
    ctx: Ctx,
    entityId: string,
    partyId: string | undefined,
    accountId: string | undefined,
    fileIds: string[] | undefined,
  ): Promise<void> {
    if (partyId) {
      const party = await this.business.partyRow(trx, ctx, partyId);
      if (!party || party.entity_id !== entityId || party.kind !== 'vendor') {
        throw unprocessable('bill.party', 'Choose a vendor of this business');
      }
    }
    if (accountId) {
      const a = await trx
        .selectFrom('app.ledger_account')
        .select(['entity_id', 'type', 'is_category'])
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', accountId)
        .executeTakeFirst();
      if (!a || a.entity_id !== entityId || a.type !== 'expense' || !a.is_category) {
        throw unprocessable('bill.expense_category', 'Choose an expense category of this business');
      }
    }
    if (fileIds?.length) {
      const found = await trx
        .selectFrom('app.file')
        .select('id')
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', 'in', fileIds)
        .execute();
      if (found.length !== new Set(fileIds).size) throw notFound('File');
    }
  }

  async create(ctx: Ctx, req: CreateBillRequest): Promise<BillDto> {
    return this.db.run(ctx, async (trx) => {
      const e = await businessEntity(trx, ctx, req.entityId);
      await this.checkLinks(trx, ctx, e.id, req.partyId, req.expenseAccountId, req.fileIds);
      if (req.dueDate < req.billDate)
        throw unprocessable('bill.dates', 'The due date is before the bill date');
      const row = await trx
        .insertInto('app.bill')
        .values({
          workspace_id: ctx.workspaceId,
          id: newId(),
          entity_id: e.id,
          party_id: req.partyId,
          reference: req.reference ?? null,
          bill_date: req.billDate,
          due_date: req.dueDate,
          currency: e.currency,
          amount_minor: req.amount,
          expense_account_id: req.expenseAccountId,
          notes: req.notes ?? null,
          attachment_ids: req.fileIds,
          created_by: ctx.userId,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      return this.dto(trx, ctx, row, todayOf(e));
    });
  }

  async update(ctx: Ctx, id: string, req: UpdateBillRequest): Promise<BillDto> {
    return this.db.run(ctx, async (trx) => {
      const r = await this.row(trx, ctx, id);
      if (BigInt(r.version) !== BigInt(req.version)) throw conflict();
      if (r.status === 'paid') {
        throw unprocessable('bill.paid', 'Remove its payment before changing a paid bill');
      }
      const e = await businessEntity(trx, ctx, r.entity_id);
      await this.checkLinks(trx, ctx, e.id, req.partyId, req.expenseAccountId, req.fileIds);
      const row = await trx
        .updateTable('app.bill')
        .set({
          ...(req.partyId !== undefined ? { party_id: req.partyId } : {}),
          ...(req.reference !== undefined ? { reference: req.reference } : {}),
          ...(req.billDate !== undefined ? { bill_date: req.billDate } : {}),
          ...(req.dueDate !== undefined ? { due_date: req.dueDate } : {}),
          ...(req.amount !== undefined ? { amount_minor: req.amount } : {}),
          ...(req.expenseAccountId !== undefined ? { expense_account_id: req.expenseAccountId } : {}),
          ...(req.notes !== undefined ? { notes: req.notes } : {}),
          ...(req.fileIds !== undefined ? { attachment_ids: req.fileIds } : {}),
          ...(req.void !== undefined ? { status: req.void ? ('void' as const) : ('open' as const) } : {}),
        })
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirstOrThrow();
      return this.dto(trx, ctx, row, todayOf(e));
    });
  }

  async file(ctx: Ctx, id: string, fileId: string) {
    return this.db.run(ctx, async (trx) => {
      const r = await this.row(trx, ctx, id);
      if (!r.attachment_ids.includes(fileId)) throw notFound('File');
      return this.business.fileBytes(trx, ctx, fileId);
    });
  }

  async candidates(ctx: Ctx, id: string): Promise<PaymentCandidateDto[]> {
    return this.db.run(ctx, async (trx) => {
      const r = await this.row(trx, ctx, id);
      const due = dateOf(r.due_date);
      const all = await this.links.candidates(trx, ctx, {
        sign: -1,
        currency: r.currency,
        max: BigInt(r.amount_minor),
        from: addDays(due, -BILL_MATCH_DAYS),
        to: addDays(due, BILL_MATCH_DAYS),
        near: due,
      });
      return all.filter((c) => BigInt(c.amount) === BigInt(r.amount_minor));
    });
  }

  async pay(ctx: Ctx, id: string, req: RecordPaymentRequest, source: 'auto' | 'manual' = 'manual') {
    return this.db.run(ctx, (trx) => this.payIn(trx, ctx, id, req, source));
  }

  async payIn(
    trx: Trx,
    ctx: Ctx,
    id: string,
    req: RecordPaymentRequest,
    source: 'auto' | 'manual',
  ): Promise<BillDto> {
    const r = await trx
      .selectFrom('app.bill')
      .selectAll()
      .where('workspace_id', '=', ctx.workspaceId)
      .where('id', '=', id)
      .forUpdate()
      .executeTakeFirst();
    if (!r) throw notFound('Bill');
    if (r.status !== 'open') throw unprocessable('bill.not_open', `This bill is ${r.status}`);
    const e = await businessEntity(trx, ctx, r.entity_id);
    const amount = BigInt(r.amount_minor);
    const splits = [{ accountId: r.expense_account_id, amount: String(-amount), memberId: null }];
    let transactionId: string;
    let paymentSpec: unknown = null;
    if ('transactionId' in req) {
      const t = await trx
        .selectFrom('app.transaction')
        .select('spec')
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', req.transactionId)
        .executeTakeFirst();
      if (!t) throw notFound('Transaction');
      if (BigInt((t.spec as { amount?: string } | null)?.amount ?? '0') !== -amount) {
        throw unprocessable('bill.amount', 'The payment must be the exact amount of the bill');
      }
      const taken = await this.links.takeOver(trx, ctx, req.transactionId, { billId: id }, splits, {
        sign: -1,
        currency: r.currency,
      });
      transactionId = req.transactionId;
      paymentSpec = taken.previous;
    } else {
      if (BigInt(req.amount) !== amount) {
        throw unprocessable('bill.amount', 'The payment must be the exact amount of the bill');
      }
      const party = await this.business.partyRow(trx, ctx, r.party_id);
      transactionId = await this.links.create(trx, ctx, {
        entityId: e.id,
        accountId: req.accountId,
        date: req.date,
        amount: -amount,
        currency: r.currency,
        payee: party?.name ?? 'Bill',
        payeeKey: party?.payee_key ?? null,
        description: r.reference ? `Bill ${r.reference}` : `Bill from ${party?.name ?? ''}`.trim(),
        source: 'bill',
        owner: { billId: id },
        splits,
      });
    }
    const row = await trx
      .updateTable('app.bill')
      .set({
        status: 'paid',
        transaction_id: transactionId,
        payment_source: source,
        payment_spec: paymentSpec ? JSON.stringify(paymentSpec) : null,
      })
      .where('workspace_id', '=', ctx.workspaceId)
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirstOrThrow();
    return this.dto(trx, ctx, row, todayOf(e));
  }

  async removePayment(ctx: Ctx, id: string): Promise<BillDto> {
    return this.db.run(ctx, async (trx) => {
      const r = await this.row(trx, ctx, id);
      if (r.status !== 'paid' || !r.transaction_id)
        throw unprocessable('bill.not_paid', 'This bill is not paid');
      const row = await trx
        .updateTable('app.bill')
        .set({ status: 'open', transaction_id: null, payment_source: null, payment_spec: null })
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirstOrThrow();
      await this.links.release(trx, ctx, r.transaction_id, r.payment_spec);
      return this.dto(trx, ctx, row, todayOf(await businessEntity(trx, ctx, r.entity_id)));
    });
  }

  /** Open bills, for matching and the forecast. */
  async openBills(trx: Trx, ctx: Ctx, entityId?: string) {
    const rows = await trx
      .selectFrom('app.bill as b')
      .innerJoin('app.business_party as p', (j) =>
        j.onRef('p.workspace_id', '=', 'b.workspace_id').onRef('p.id', '=', 'b.party_id'),
      )
      .select(['b.id', 'b.entity_id', 'b.due_date', 'b.amount_minor', 'b.currency', 'b.reference', 'p.name'])
      .where('b.workspace_id', '=', ctx.workspaceId)
      .where('b.status', '=', 'open')
      .$if(!!entityId, (x) => x.where('b.entity_id', '=', entityId!))
      .execute();
    return rows.map((r) => ({
      id: r.id,
      entityId: r.entity_id,
      dueDate: dateOf(r.due_date),
      amount: BigInt(r.amount_minor),
      currency: r.currency,
      reference: r.reference,
      partyName: r.name,
    }));
  }
}
