/**
 * Bills (ADR-0048 §4). A bill from a biller, usually scanned from the Add wheel, is filed by its biller's books:
 *
 * - On personal books it's a household bill (`app.household_bill`): its exact amount and due date replace the
 *   biller's estimate in upcoming, the calendar, bill-due alerts and the forecast, until a payment to the biller near
 *   the due date for the amount marks it paid (`settle`).
 * - On a business's books it's that business's vendor bill (ADR-0017), from a vendor of the biller's name, so its due
 *   date and payment matching are the business's own.
 */
import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { newId, type HouseholdBillRow, type Trx } from '@montra/db';
import { addDays, asCurrencyCode, calendarDate, diffDays, type CalendarDate } from '@montra/domain';
import type {
  CreateHouseholdBillRequest,
  FiledBillDto,
  HouseholdBillDto,
  UpdateHouseholdBillRequest,
} from '@montra/schemas';
import { AppError, notFound, unprocessable } from '../common/errors.js';
import { Db } from '../db/database.js';
import { BillsService } from '../business/bills.service.js';
import { detectReceiptMedia } from '../receipts/receipts.service.js';
import { STORAGE_PORT, storageKey, type StoragePort } from '../storage/storage.js';
import { billerKey, isBillerPayee } from './billers.service.js';
import { PlanningData, type Ctx } from './data.js';

/** Bills are kept like other documents with money on them. */
const RETENTION_YEARS = 7;
/** A payment counts for a bill from this many days before its due date to this many after. */
const PAID_BEFORE_DAYS = 20;
const PAID_AFTER_DAYS = 15;

@Injectable()
export class HouseholdBillsService {
  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(STORAGE_PORT) private readonly storage: StoragePort,
    @Inject(BillsService) private readonly business: BillsService,
    @Inject(PlanningData) private readonly data: PlanningData,
  ) {}

  /** A page of a bill: a photo (JPEG, PNG, WebP) or a PDF. */
  async uploadFile(ctx: Ctx, bytes: Uint8Array, fileName: string) {
    const mediaType = detectReceiptMedia(bytes);
    if (!mediaType)
      throw new AppError(415, 'bill.unsupported_type', 'Upload a PDF, or a JPEG, PNG or WebP photo');
    const id = newId();
    const key = storageKey(ctx.workspaceId, 'bill', id);
    await this.storage.put(key, bytes, mediaType);
    await this.db.run(ctx, (trx) =>
      trx
        .insertInto('app.file')
        .values({
          workspace_id: ctx.workspaceId,
          id,
          kind: 'invoice',
          storage_key: key,
          file_name: fileName.replace(/[\\/\0]/g, '_').slice(0, 255) || 'bill',
          mime: mediaType,
          bytes: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex'),
          uploaded_by: ctx.userId,
          retain_until: sql<string>`(current_date + make_interval(years => ${RETENTION_YEARS}))::date`,
        })
        .execute(),
    );
    return { fileId: id, mediaType, bytes: bytes.length };
  }

  async list(ctx: Ctx, q: { entityId?: string; status?: string }): Promise<HouseholdBillDto[]> {
    return this.db.run(ctx, async (trx) => {
      await this.settle(trx, ctx);
      const today = await this.data.today(trx, ctx);
      const rows = await this.rows(trx, ctx)
        .$if(!!q.entityId, (b) => b.where('h.entity_id', '=', q.entityId!))
        .$if(q.status === 'open' || q.status === 'overdue', (b) => b.where('h.status', '=', 'open'))
        .$if(q.status === 'paid' || q.status === 'void', (b) => b.where('h.status', '=', q.status as 'paid'))
        .orderBy('h.due_date', 'desc')
        .limit(200)
        .execute();
      return rows.map((r) => toDto(r, today)).filter((b) => q.status !== 'overdue' || b.status === 'overdue');
    });
  }

  async get(ctx: Ctx, id: string): Promise<HouseholdBillDto> {
    return this.db.run(ctx, async (trx) => {
      const row = await this.rows(trx, ctx).where('h.id', '=', id).executeTakeFirst();
      if (!row) throw notFound('Bill');
      return toDto(row, await this.data.today(trx, ctx));
    });
  }

  /** Files a bill for its biller: a household bill, or a business's vendor bill (ADR-0017). */
  async create(ctx: Ctx, req: CreateHouseholdBillRequest): Promise<FiledBillDto> {
    const prepared = await this.db.run(ctx, async (trx) => {
      const biller = await trx
        .selectFrom('app.biller as b')
        .innerJoin('app.entity as e', (j) =>
          j.onRef('e.workspace_id', '=', 'b.workspace_id').onRef('e.id', '=', 'b.entity_id'),
        )
        .select([
          'b.id',
          'b.name',
          'b.entity_id',
          'b.category_id',
          'b.member_id',
          'e.type',
          'e.functional_currency',
        ])
        .where('b.workspace_id', '=', ctx.workspaceId)
        .where('b.id', '=', req.billerId)
        .where('b.archived_at', 'is', null)
        .executeTakeFirst();
      if (!biller) throw notFound('Biller');
      const scan = req.scanId ? await this.usableScan(trx, ctx, req.scanId) : null;
      if (req.billDate && req.dueDate < req.billDate)
        throw unprocessable('bill.dates', 'The due date is before the bill date');
      return { biller, scan };
    });
    const { biller, scan } = prepared;
    const fileIds = scan?.file_ids ?? [];
    const extraction = scan ? scanExtraction(scan.result) : null;

    if (biller.type === 'business') {
      // A business's bill is its vendor bill: from a vendor of the biller's name, to the biller's category.
      const partyId = await this.db.run(ctx, (trx) => this.vendor(trx, ctx, biller.entity_id, biller.name));
      const today = await this.db.run(ctx, (trx) => this.data.today(trx, ctx));
      const bill = await this.business.create(ctx, {
        entityId: biller.entity_id,
        partyId,
        reference: null,
        billDate: req.billDate ?? (req.dueDate < today ? req.dueDate : today),
        dueDate: req.dueDate,
        amount: req.amount,
        expenseAccountId: biller.category_id,
        notes: null,
        fileIds,
      });
      if (scan) await this.db.run(ctx, (trx) => this.useScan(trx, ctx, scan.id, bill.id));
      return { kind: 'business', id: bill.id, entityId: biller.entity_id };
    }

    return this.db.run(ctx, async (trx) => {
      const row = await trx
        .insertInto('app.household_bill')
        .values({
          workspace_id: ctx.workspaceId,
          entity_id: biller.entity_id,
          biller_id: biller.id,
          member_id: req.memberId !== undefined ? req.memberId : biller.member_id,
          amount_minor: BigInt(req.amount),
          currency: biller.functional_currency,
          due_date: req.dueDate,
          bill_date: req.billDate ?? null,
          period_start: req.periodStart ?? null,
          period_end: req.periodEnd ?? null,
          attachment_ids: fileIds,
          extraction: extraction ? JSON.stringify(extraction) : null,
          created_by: ctx.userId,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      if (scan) await this.useScan(trx, ctx, scan.id, row.id);
      await this.settle(trx, ctx);
      return { kind: 'household', id: row.id, entityId: biller.entity_id };
    });
  }

  async update(ctx: Ctx, id: string, req: UpdateHouseholdBillRequest): Promise<HouseholdBillDto> {
    return this.db.run(ctx, async (trx) => {
      const row = await trx
        .updateTable('app.household_bill')
        .set({
          ...(req.amount !== undefined ? { amount_minor: BigInt(req.amount) } : {}),
          ...(req.dueDate !== undefined ? { due_date: req.dueDate } : {}),
          ...(req.void ? { status: 'void' as const, transaction_id: null, paid_at: null } : {}),
        })
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', id)
        .where('version', '=', BigInt(req.version))
        .returning('id')
        .executeTakeFirst();
      if (!row) {
        const exists = await trx
          .selectFrom('app.household_bill')
          .select('id')
          .where('workspace_id', '=', ctx.workspaceId)
          .where('id', '=', id)
          .executeTakeFirst();
        if (!exists) throw notFound('Bill');
        throw new AppError(
          409,
          'version.conflict',
          'This bill was changed by someone else; reload and try again',
        );
      }
      const out = await this.rows(trx, ctx).where('h.id', '=', id).executeTakeFirstOrThrow();
      return toDto(out, await this.data.today(trx, ctx));
    });
  }

  async file(ctx: Ctx, billId: string, fileId: string): Promise<{ bytes: Uint8Array; mime: string }> {
    const f = await this.db.run(ctx, async (trx) => {
      const b = await trx
        .selectFrom('app.household_bill')
        .select('attachment_ids')
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', billId)
        .executeTakeFirst();
      if (!b || !b.attachment_ids.includes(fileId)) throw notFound('File');
      return trx
        .selectFrom('app.file')
        .select(['storage_key', 'mime'])
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', fileId)
        .executeTakeFirstOrThrow();
    });
    return { bytes: await this.storage.get(f.storage_key), mime: f.mime };
  }

  /** Open bills by biller, earliest first: they replace the billers' estimates (calendar, forecast). */
  async openByBiller(trx: Trx, ctx: Ctx, billerIds: string[]): Promise<Map<string, HouseholdBillRow[]>> {
    const out = new Map<string, HouseholdBillRow[]>();
    if (billerIds.length === 0) return out;
    await this.settle(trx, ctx);
    const rows = await trx
      .selectFrom('app.household_bill')
      .selectAll()
      .where('workspace_id', '=', ctx.workspaceId)
      .where('status', '=', 'open')
      .where('biller_id', 'in', billerIds)
      .orderBy('due_date')
      .execute();
    for (const r of rows) out.set(r.biller_id, [...(out.get(r.biller_id) ?? []), r]);
    return out;
  }

  /**
   * Marks open bills paid by their payments: a posted payment in the bill's books to the biller's payee, for the
   * bill's amount, from 20 days before the due date to 15 after. The nearest to the due date wins, and a payment
   * settles one bill.
   */
  async settle(trx: Trx, ctx: Ctx): Promise<number> {
    const open = await trx
      .selectFrom('app.household_bill as h')
      .innerJoin('app.biller as b', (j) =>
        j.onRef('b.workspace_id', '=', 'h.workspace_id').onRef('b.id', '=', 'h.biller_id'),
      )
      .select(['h.id', 'h.entity_id', 'h.amount_minor', 'h.currency', 'h.due_date', 'b.match_key'])
      .where('h.workspace_id', '=', ctx.workspaceId)
      .where('h.status', '=', 'open')
      .execute();
    if (open.length === 0) return 0;
    const dues = open.map((o) => calendarDate(String(o.due_date)));
    const from = dues.reduce((a, b) => (a < b ? a : b));
    const to = dues.reduce((a, b) => (a > b ? a : b));
    const payments = await trx
      .selectFrom('app.transaction')
      .select([
        'id',
        'primary_entity_id as entityId',
        'payee_key as payeeKey',
        sql<string>`txn_date::text`.as('date'),
        sql<string | null>`spec->>'amount'`.as('amount'),
        sql<string | null>`spec->>'currency'`.as('currency'),
      ])
      .where('workspace_id', '=', ctx.workspaceId)
      .where('status', '=', 'posted')
      .where('deleted_at', 'is', null)
      .where('payee_key', 'is not', null)
      .where('txn_date', '>=', addDays(from, -PAID_BEFORE_DAYS))
      .where('txn_date', '<=', addDays(to, PAID_AFTER_DAYS))
      .where(
        'id',
        'not in',
        trx
          .selectFrom('app.household_bill')
          .select(sql<string>`transaction_id`.as('t'))
          .where('workspace_id', '=', ctx.workspaceId)
          .where('transaction_id', 'is not', null),
      )
      .execute();
    const used = new Set<string>();
    let settled = 0;
    for (const bill of [...open].sort((a, b) => (String(a.due_date) < String(b.due_date) ? -1 : 1))) {
      const due = calendarDate(String(bill.due_date));
      const match = payments
        .filter(
          (p) =>
            !used.has(p.id) &&
            p.entityId === bill.entity_id &&
            p.currency === bill.currency &&
            p.amount !== null &&
            -BigInt(p.amount) === BigInt(bill.amount_minor) &&
            diffDays(calendarDate(p.date), due) >= -PAID_BEFORE_DAYS &&
            diffDays(calendarDate(p.date), due) <= PAID_AFTER_DAYS &&
            isBillerPayee(bill.match_key, p.payeeKey!),
        )
        .sort(
          (a, b) =>
            Math.abs(diffDays(calendarDate(a.date), due)) - Math.abs(diffDays(calendarDate(b.date), due)),
        )[0];
      if (!match) continue;
      used.add(match.id);
      await trx
        .updateTable('app.household_bill')
        .set({ status: 'paid', transaction_id: match.id, paid_at: new Date() })
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', bill.id)
        .execute();
      settled += 1;
    }
    return settled;
  }

  private rows(trx: Trx, ctx: Ctx) {
    return trx
      .selectFrom('app.household_bill as h')
      .innerJoin('app.biller as b', (j) =>
        j.onRef('b.workspace_id', '=', 'h.workspace_id').onRef('b.id', '=', 'h.biller_id'),
      )
      .selectAll('h')
      .select(['b.name as biller_name', 'b.category_id'])
      .where('h.workspace_id', '=', ctx.workspaceId);
  }

  private async usableScan(trx: Trx, ctx: Ctx, id: string) {
    const scan = await trx
      .selectFrom('app.document_scan')
      .selectAll()
      .where('workspace_id', '=', ctx.workspaceId)
      .where('id', '=', id)
      .executeTakeFirst();
    if (!scan || scan.kind !== 'bill') throw notFound('Scan');
    if (scan.status !== 'ready')
      throw unprocessable('scan.not_ready', 'This scan is still being read, or was filed');
    return scan;
  }

  private async useScan(trx: Trx, ctx: Ctx, scanId: string, usedId: string) {
    await trx
      .updateTable('app.document_scan')
      .set({ status: 'used', used_id: usedId, result: null, updated_at: new Date() })
      .where('workspace_id', '=', ctx.workspaceId)
      .where('id', '=', scanId)
      .execute();
  }

  /** The business's vendor of this name, made when it has none. */
  private async vendor(trx: Trx, ctx: Ctx, entityId: string, name: string): Promise<string> {
    const found = await trx
      .selectFrom('app.business_party')
      .select('id')
      .where('workspace_id', '=', ctx.workspaceId)
      .where('entity_id', '=', entityId)
      .where('kind', '=', 'vendor')
      .where('archived_at', 'is', null)
      .where(sql<boolean>`lower(name) = lower(${name})`)
      .executeTakeFirst();
    if (found) return found.id;
    const made = await trx
      .insertInto('app.business_party')
      .values({
        workspace_id: ctx.workspaceId,
        entity_id: entityId,
        kind: 'vendor',
        name,
        payee_key: billerKey(name),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return made.id;
  }
}

/** What a scan's reading leaves on the bill: the model, its confidence and what to check. */
function scanExtraction(result: unknown): Record<string, unknown> | null {
  const r = result as {
    res?: { ok?: boolean; value?: { confidence?: number }; meta?: { model?: string } };
    base?: object;
  };
  if (!r?.res?.ok) return null;
  const confidence = r.res.value?.confidence ?? null;
  return {
    ...(r.base ?? {}),
    model: r.res.meta?.model ?? null,
    confidence,
    warnings:
      confidence !== null && confidence < 0.8
        ? ['Low confidence reading: check the amount and due date']
        : [],
  };
}

type Row = HouseholdBillRow & { biller_name: string; category_id: string };

function toDto(r: Row, today: CalendarDate): HouseholdBillDto {
  const due = calendarDate(String(r.due_date));
  const ex = (r.extraction ?? null) as { warnings?: string[] } | null;
  return {
    id: r.id,
    entityId: r.entity_id,
    billerId: r.biller_id,
    billerName: r.biller_name,
    categoryId: r.category_id,
    memberId: r.member_id,
    status: r.status === 'open' && due < today ? 'overdue' : r.status,
    amount: r.amount_minor.toString(),
    currency: asCurrencyCode(r.currency),
    dueDate: due,
    billDate: r.bill_date ? calendarDate(String(r.bill_date)) : null,
    periodStart: r.period_start ? calendarDate(String(r.period_start)) : null,
    periodEnd: r.period_end ? calendarDate(String(r.period_end)) : null,
    fileIds: r.attachment_ids,
    transactionId: r.transaction_id,
    warnings: ex?.warnings ?? [],
    version: Number(r.version),
  };
}
