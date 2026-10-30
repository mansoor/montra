import { Inject, Injectable } from '@nestjs/common';
import { newId } from '@montra/db';
import {
  addDays,
  calendarDate,
  compareDates,
  nextOccurrenceAfter,
  occurrencesBetween,
  todayIn,
  type CalendarDate,
} from '@montra/domain';
import type { CreateRecurringRequest, RecurringDto, UpdateRecurringRequest } from '@montra/schemas';
import { Db } from '../db/database.js';
import { notFound, unprocessable } from '../common/errors.js';
import { TransactionPoster, type TransactionSpec } from '../transactions/poster.js';
import { TransactionsService } from '../transactions/transactions.service.js';

type Ctx = { workspaceId: string; userId: string };

/** How far ahead scheduled occurrences are created, so upcoming bills show up (FLOW-01: next 14 days). */
export const SCHEDULE_HORIZON_DAYS = 14;

@Injectable()
export class RecurringService {
  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(TransactionsService) private readonly transactions: TransactionsService,
    @Inject(TransactionPoster) private readonly poster: TransactionPoster,
  ) {}

  async create(ctx: Ctx, req: CreateRecurringRequest): Promise<RecurringDto> {
    const id = newId();
    await this.db.run(ctx, async (trx) => {
      const spec = await this.transactions.standardSpec(trx, ctx, {
        accountId: req.accountId,
        amount: req.amount,
        description: req.payee ?? req.name,
        categoryId: req.categoryId,
        splits: req.splits,
      });
      // Validate the template once by building it (no writes besides inter-entity accounts).
      const built = await this.poster.build(trx, ctx, spec, req.startDate);
      await trx
        .insertInto('app.recurring_item')
        .values({
          workspace_id: ctx.workspaceId,
          id,
          primary_entity_id: built.primaryEntityId,
          name: req.name,
          spec: JSON.stringify({ ...spec, payee: req.payee ?? null }),
          cadence: req.cadence,
          start_date: req.startDate,
          end_date: req.endDate ?? null,
          next_date: req.startDate,
          auto_create: req.autoCreate,
        })
        .execute();
    });
    await this.materialize(ctx);
    return this.get(ctx, id);
  }

  async update(ctx: Ctx, id: string, req: UpdateRecurringRequest): Promise<RecurringDto> {
    await this.db.run(ctx, async (trx) => {
      const item = await trx
        .selectFrom('app.recurring_item')
        .selectAll()
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst();
      if (!item) throw notFound('Recurring item');
      let spec = item.spec as TransactionSpec & { payee: string | null };
      if (req.amount) {
        if (spec.type !== 'standard' || spec.splits.length !== 1) {
          throw unprocessable(
            'splits.required',
            'Changing the amount of a split template requires new splits',
          );
        }
        spec = {
          ...spec,
          amount: req.amount.amount,
          splits: [{ ...spec.splits[0]!, amount: req.amount.amount }],
        };
      }
      await trx
        .updateTable('app.recurring_item')
        .set({
          spec: JSON.stringify(spec),
          ...(req.name !== undefined ? { name: req.name } : {}),
          ...(req.endDate !== undefined ? { end_date: req.endDate } : {}),
          ...(req.status !== undefined ? { status: req.status } : {}),
          ...(req.autoCreate !== undefined ? { auto_create: req.autoCreate } : {}),
        })
        .where('id', '=', id)
        .execute();
      // Future scheduled (unconfirmed) occurrences follow the template.
      if (req.amount || req.status === 'ended' || req.status === 'paused') {
        const scheduled = () =>
          trx
            .selectFrom('app.transaction')
            .where('workspace_id', '=', ctx.workspaceId)
            .where('recurring_item_id', '=', id)
            .where('status', '=', 'scheduled');
        const first = await scheduled()
          .select((eb) => eb.fn.min('txn_date').as('d'))
          .executeTakeFirst();
        await trx
          .deleteFrom('app.transaction')
          .where('workspace_id', '=', ctx.workspaceId)
          .where('recurring_item_id', '=', id)
          .where('status', '=', 'scheduled')
          .execute();
        // Regenerate from the earliest unconfirmed occurrence.
        if (first?.d)
          await trx
            .updateTable('app.recurring_item')
            .set({ next_date: first.d })
            .where('id', '=', id)
            .execute();
      }
    });
    await this.materialize(ctx);
    return this.get(ctx, id);
  }

  async list(ctx: Ctx): Promise<RecurringDto[]> {
    const rows = await this.db.run(ctx, (trx) =>
      trx
        .selectFrom('app.recurring_item')
        .selectAll()
        .where('workspace_id', '=', ctx.workspaceId)
        .orderBy('next_date')
        .execute(),
    );
    return rows.map(toDto);
  }

  async get(ctx: Ctx, id: string): Promise<RecurringDto> {
    const row = await this.db.run(ctx, (trx) =>
      trx
        .selectFrom('app.recurring_item')
        .selectAll()
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', id)
        .executeTakeFirst(),
    );
    if (!row) throw notFound('Recurring item');
    return toDto(row);
  }

  /**
   * Creates occurrences up to `through` (default: today + 14 days in the workspace time zone). Due items with
   * auto_create = 'posted' are posted; everything else is scheduled for confirmation. Idempotent per date.
   * The Phase 2 scheduler calls this nightly per workspace (TZ-04).
   */
  async materialize(ctx: Ctx, through?: CalendarDate): Promise<{ created: number; posted: number }> {
    return this.db.run(ctx, async (trx) => {
      const ws = await trx
        .selectFrom('app.workspace')
        .select('time_zone')
        .where('id', '=', ctx.workspaceId)
        .executeTakeFirstOrThrow();
      const today = todayIn(ws.time_zone);
      const horizon = through ?? addDays(today, SCHEDULE_HORIZON_DAYS);
      const items = await trx
        .selectFrom('app.recurring_item')
        .selectAll()
        .where('workspace_id', '=', ctx.workspaceId)
        .where('status', '=', 'active')
        .where('next_date', '<=', horizon)
        .forUpdate()
        .execute();
      let created = 0;
      let posted = 0;
      for (const item of items) {
        const start = calendarDate(item.start_date);
        const dates = occurrencesBetween(
          start,
          item.cadence,
          calendarDate(item.next_date),
          horizon,
          item.end_date ? calendarDate(item.end_date) : null,
        );
        const spec = item.spec as TransactionSpec & { payee: string | null };
        for (const date of dates) {
          const id = newId();
          const res = await trx
            .insertInto('app.transaction')
            .values({
              workspace_id: ctx.workspaceId,
              id,
              primary_entity_id: item.primary_entity_id,
              txn_date: date,
              payee_raw: spec.payee,
              description: item.name,
              status: 'scheduled',
              source: 'recurring',
              recurring_item_id: item.id,
              spec: JSON.stringify(spec),
              created_by: ctx.userId,
            })
            .onConflict((oc) => oc.doNothing())
            .executeTakeFirst();
          if (!res.numInsertedOrUpdatedRows) continue;
          created++;
          if (item.auto_create === 'posted' && compareDates(date, today) <= 0) {
            const built = await this.poster.build(trx, ctx, spec, date);
            await this.poster.repost(trx, ctx, id, built.drafts);
            await trx
              .updateTable('app.transaction')
              .set({ status: 'posted', posted_at: new Date() })
              .where('workspace_id', '=', ctx.workspaceId)
              .where('id', '=', id)
              .execute();
            posted++;
          }
        }
        const next = nextOccurrenceAfter(
          start,
          item.cadence,
          horizon,
          item.end_date ? calendarDate(item.end_date) : null,
        );
        await trx
          .updateTable('app.recurring_item')
          .set(next ? { next_date: next } : { status: 'ended' })
          .where('id', '=', item.id)
          .execute();
      }
      return { created, posted };
    });
  }
}

const toDto = (r: {
  id: string;
  name: string;
  cadence: RecurringDto['cadence'];
  start_date: string;
  end_date: string | null;
  next_date: string;
  auto_create: 'scheduled' | 'posted';
  status: RecurringDto['status'];
  spec: unknown;
}): RecurringDto => {
  const spec = r.spec as TransactionSpec & { payee?: string | null };
  return {
    id: r.id,
    name: r.name,
    cadence: r.cadence,
    startDate: r.start_date,
    endDate: r.end_date,
    nextDate: r.next_date,
    autoCreate: r.auto_create,
    status: r.status,
    amount: { amount: spec.amount, currency: spec.currency as RecurringDto['amount']['currency'] },
    accountId: spec.type === 'standard' ? spec.accountId : spec.fromAccountId,
    payee: spec.payee ?? null,
  };
};
