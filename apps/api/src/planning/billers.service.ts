/**
 * Billers (ADR-0048 §4): the providers that send a budget category's bills, named on the budget ("SDG&E" on
 * Utilities). Each one's next bill is estimated from its recent payments (`nextBill`), and comes into upcoming, the
 * calendar, bill-due alerts and the forecast, unless a recurring item for the same payee already shows it.
 */
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import type { BillerRow, Trx } from '@montra/db';
import {
  addDays,
  asCurrencyCode,
  calendarDate,
  nextBill,
  type BillPayment,
  type CalendarDate,
  type NextBill,
} from '@montra/domain';
import { normalizeDescription, similarity } from '@montra/importers';
import type { BillerDto, CreateBillerRequest, UpdateBillerRequest } from '@montra/schemas';
import { AppError, notFound, unprocessable } from '../common/errors.js';
import { Db } from '../db/database.js';
import { PlanningData, type Ctx } from './data.js';

/** How far back payments are read for the estimate: a year and a bit covers a yearly bill. */
const LOOKBACK_DAYS = 400;
/** A payee this close to the biller's name is the biller (payee keys are normalized the same way). */
const SAME_PAYEE = 0.6;

/** The key a biller's payments and bills are matched by: its name normalized like a payee. */
export const billerKey = (name: string): string => normalizeDescription(name) || name.trim().toUpperCase();

/** Whether a transaction's payee key is this biller's. */
export const isBillerPayee = (billerKeyValue: string, payeeKey: string): boolean =>
  payeeKey.startsWith(billerKeyValue) || similarity(payeeKey, billerKeyValue) >= SAME_PAYEE;

export interface BillerExpected {
  biller: BillerRow;
  next: NextBill;
  currency: string;
  /** A recurring item already shows this payee's payments: the estimate isn't added again. */
  coveredByRecurring: boolean;
}

@Injectable()
export class BillersService {
  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(PlanningData) private readonly data: PlanningData,
  ) {}

  async list(ctx: Ctx, entityId?: string): Promise<BillerDto[]> {
    return this.db.run(ctx, async (trx) => {
      const rows = await this.rows(trx, ctx, entityId, true);
      const expected = await this.expectedFor(
        trx,
        ctx,
        rows.filter((r) => !r.archived_at),
      );
      return rows.map((r) => toDto(r, expected.get(r.id) ?? null));
    });
  }

  async create(ctx: Ctx, req: CreateBillerRequest): Promise<BillerDto> {
    return this.db.run(ctx, async (trx) => {
      const category = await this.category(trx, ctx, req.categoryId);
      const row = await trx
        .insertInto('app.biller')
        .values({
          workspace_id: ctx.workspaceId,
          entity_id: category.entity_id,
          category_id: category.id,
          name: req.name,
          match_key: billerKey(req.name),
          member_id: req.memberId ?? null,
          account_last4: req.accountLast4 ?? null,
          due_day: req.dueDay ?? null,
          cadence: req.cadence,
          created_by: ctx.userId,
        })
        .returningAll()
        .executeTakeFirst()
        .catch((err: { code?: string }) => {
          if (err.code === '23505')
            throw unprocessable('biller.exists', 'There is already a biller of that name');
          throw err;
        });
      const expected = await this.expectedFor(trx, ctx, [row!]);
      return toDto(row!, expected.get(row!.id) ?? null);
    });
  }

  async update(ctx: Ctx, id: string, req: UpdateBillerRequest): Promise<BillerDto> {
    return this.db.run(ctx, async (trx) => {
      const current = await trx
        .selectFrom('app.biller')
        .selectAll()
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', id)
        .executeTakeFirst();
      if (!current) throw notFound('Biller');
      const category = req.categoryId ? await this.category(trx, ctx, req.categoryId) : null;
      if (category && category.entity_id !== current.entity_id)
        throw unprocessable(
          'biller.books',
          'A biller stays in its books: choose a category in the same books',
        );
      const row = await trx
        .updateTable('app.biller')
        .set({
          ...(req.name !== undefined ? { name: req.name, match_key: billerKey(req.name) } : {}),
          ...(category ? { category_id: category.id } : {}),
          ...(req.memberId !== undefined ? { member_id: req.memberId } : {}),
          ...(req.accountLast4 !== undefined ? { account_last4: req.accountLast4 } : {}),
          ...(req.dueDay !== undefined ? { due_day: req.dueDay } : {}),
          ...(req.cadence !== undefined ? { cadence: req.cadence } : {}),
          ...(req.archived !== undefined ? { archived_at: req.archived ? new Date() : null } : {}),
        })
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', id)
        .where('version', '=', BigInt(req.version))
        .returningAll()
        .executeTakeFirst();
      if (!row)
        throw new AppError(
          409,
          'version.conflict',
          'This biller was changed by someone else; reload and try again',
        );
      const expected = row.archived_at ? new Map() : await this.expectedFor(trx, ctx, [row]);
      return toDto(row, expected.get(row.id) ?? null);
    });
  }

  /** Active billers' next bills up to `to` (calendar, upcoming, forecast), for the given books or all. */
  async expectedUntil(
    trx: Trx,
    ctx: Ctx,
    to: CalendarDate,
    entityId?: string | null,
  ): Promise<BillerExpected[]> {
    const rows = await this.rows(trx, ctx, entityId ?? undefined, false);
    const expected = await this.expectedFor(trx, ctx, rows);
    return [...expected.values()].filter((e) => e.next.date <= to);
  }

  private async rows(trx: Trx, ctx: Ctx, entityId: string | undefined, archived: boolean) {
    return trx
      .selectFrom('app.biller')
      .selectAll()
      .where('workspace_id', '=', ctx.workspaceId)
      .$if(!!entityId, (q) => q.where('entity_id', '=', entityId!))
      .$if(!archived, (q) => q.where('archived_at', 'is', null))
      .orderBy('name')
      .execute();
  }

  private async category(trx: Trx, ctx: Ctx, id: string) {
    const c = await trx
      .selectFrom('app.ledger_account')
      .select(['id', 'entity_id', 'type', 'is_category'])
      .where('workspace_id', '=', ctx.workspaceId)
      .where('id', '=', id)
      .executeTakeFirst();
    if (!c || !c.is_category || c.type !== 'expense')
      throw unprocessable('biller.category', 'A biller belongs to a spending category');
    return c;
  }

  /** Each biller's next bill from its payments in its books, in the books' currency. */
  private async expectedFor(trx: Trx, ctx: Ctx, billers: BillerRow[]): Promise<Map<string, BillerExpected>> {
    const out = new Map<string, BillerExpected>();
    if (billers.length === 0) return out;
    const today = await this.data.today(trx, ctx);
    const entityIds = [...new Set(billers.map((b) => b.entity_id))];
    const entities = await trx
      .selectFrom('app.entity')
      .select(['id', 'functional_currency'])
      .where('workspace_id', '=', ctx.workspaceId)
      .where('id', 'in', entityIds)
      .execute();
    const currency = new Map(entities.map((e) => [e.id, e.functional_currency]));
    const txns = await trx
      .selectFrom('app.transaction')
      .select([
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
      .where('primary_entity_id', 'in', entityIds)
      .where('txn_date', '>=', addDays(today, -LOOKBACK_DAYS))
      .where(sql<boolean>`spec->>'type' = 'standard'`)
      .execute();
    const recurring = await trx
      .selectFrom('app.recurring_item')
      .select(['primary_entity_id as entityId', 'name', sql<string | null>`spec->>'payee'`.as('payee')])
      .where('workspace_id', '=', ctx.workspaceId)
      .where('status', '=', 'active')
      .where('primary_entity_id', 'in', entityIds)
      .execute();
    for (const b of billers) {
      const cur = currency.get(b.entity_id)!;
      const payments: BillPayment[] = txns
        .filter(
          (t) =>
            t.entityId === b.entity_id &&
            t.currency === cur &&
            t.amount !== null &&
            BigInt(t.amount) < 0n &&
            isBillerPayee(b.match_key, t.payeeKey!),
        )
        .map((t) => ({ date: calendarDate(t.date), amount: -BigInt(t.amount!) }));
      const next = nextBill({ today, cadence: b.cadence, dueDay: b.due_day, payments });
      if (!next) continue;
      const coveredByRecurring = recurring.some(
        (r) =>
          r.entityId === b.entity_id &&
          [r.payee, r.name].some((n) => n && isBillerPayee(b.match_key, billerKey(n))),
      );
      out.set(b.id, { biller: b, next, currency: cur, coveredByRecurring });
    }
    return out;
  }
}

function toDto(r: BillerRow, e: BillerExpected | null): BillerDto {
  return {
    id: r.id,
    entityId: r.entity_id,
    categoryId: r.category_id,
    name: r.name,
    memberId: r.member_id,
    accountLast4: r.account_last4,
    dueDay: r.due_day,
    cadence: r.cadence,
    archived: r.archived_at !== null,
    next: e
      ? {
          date: e.next.date,
          amount: e.next.amount.toString(),
          currency: asCurrencyCode(e.currency),
          estimated: true,
          basedOn: e.next.basedOn,
        }
      : null,
    version: Number(r.version),
  };
}
