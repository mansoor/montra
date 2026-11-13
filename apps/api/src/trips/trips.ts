/**
 * Travel mode (CUR-09): a trip has dates and a currency. Transactions dated inside the window are tagged with
 * the trip (existing ones when the trip is saved, new ones as they are recorded), and receipts captured
 * during a trip expect its currency.
 */
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Injectable,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { sql } from 'kysely';
import { newId, type Trx, type TripRow } from '@montra/db';
import { TripInput, type TripDto } from '@montra/schemas';
import { z } from 'zod';
import { AuthGuard, Ctx, dbCtx, WorkspaceGuard, type RequestContext } from '../auth/auth.js';
import { AppError, notFound } from '../common/errors.js';
import { requireRole } from '../common/roles.js';
import { parse } from '../common/zod.js';
import { Db } from '../db/database.js';

type Ctx = { workspaceId: string; userId: string };

@Injectable()
export class TripsService {
  constructor(@Inject(Db) private readonly db: Db) {}

  async list(ctx: Ctx): Promise<TripDto[]> {
    return this.db.run(ctx, async (trx) => {
      const rows = await trx
        .selectFrom('app.trip')
        .selectAll()
        .where('workspace_id', '=', ctx.workspaceId)
        .where('deleted_at', 'is', null)
        .orderBy('start_date', 'desc')
        .execute();
      return Promise.all(rows.map((r) => this.dto(trx, ctx, r)));
    });
  }

  async create(ctx: Ctx, req: TripInput): Promise<TripDto> {
    return this.db.run(ctx, async (trx) => {
      const id = newId();
      await trx
        .insertInto('app.trip')
        .values({
          workspace_id: ctx.workspaceId,
          id,
          name: req.name,
          start_date: req.startDate,
          end_date: req.endDate,
          currency: req.currency,
          time_zone: req.timeZone ?? null,
          created_by: ctx.userId,
        })
        .execute();
      await this.retag(trx, ctx, id, req.startDate, req.endDate);
      return this.dto(trx, ctx, await this.row(trx, ctx, id));
    });
  }

  async update(ctx: Ctx, id: string, req: TripInput & { version: string }): Promise<TripDto> {
    return this.db.run(ctx, async (trx) => {
      const r = await this.row(trx, ctx, id);
      if (r.version.toString() !== req.version) {
        throw new AppError(409, 'version_mismatch', 'The trip changed since you opened it; reload it');
      }
      await trx
        .updateTable('app.trip')
        .set({
          name: req.name,
          start_date: req.startDate,
          end_date: req.endDate,
          currency: req.currency,
          time_zone: req.timeZone ?? null,
        })
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', id)
        .execute();
      await this.retag(trx, ctx, id, req.startDate, req.endDate);
      return this.dto(trx, ctx, await this.row(trx, ctx, id));
    });
  }

  async remove(ctx: Ctx, id: string): Promise<void> {
    await this.db.run(ctx, async (trx) => {
      await this.row(trx, ctx, id);
      await trx
        .updateTable('app.transaction')
        .set({ trip_id: null })
        .where('workspace_id', '=', ctx.workspaceId)
        .where('trip_id', '=', id)
        .execute();
      await trx
        .updateTable('app.trip')
        .set({ deleted_at: new Date() })
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', id)
        .execute();
    });
  }

  /** Tags untagged transactions inside the window and untags this trip's transactions outside it. */
  private async retag(trx: Trx, ctx: Ctx, id: string, start: string, end: string): Promise<void> {
    await trx
      .updateTable('app.transaction')
      .set({ trip_id: null })
      .where('workspace_id', '=', ctx.workspaceId)
      .where('trip_id', '=', id)
      .where((eb) => eb.or([eb('txn_date', '<', start), eb('txn_date', '>', end)]))
      .execute();
    await trx
      .updateTable('app.transaction')
      .set({ trip_id: id })
      .where('workspace_id', '=', ctx.workspaceId)
      .where('trip_id', 'is', null)
      .where('deleted_at', 'is', null)
      .where('txn_date', '>=', start)
      .where('txn_date', '<=', end)
      .execute();
  }

  private async row(trx: Trx, ctx: Ctx, id: string): Promise<TripRow> {
    const r = await trx
      .selectFrom('app.trip')
      .selectAll()
      .where('workspace_id', '=', ctx.workspaceId)
      .where('id', '=', id)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    if (!r) throw notFound('Trip');
    return r;
  }

  private async dto(trx: Trx, ctx: Ctx, r: TripRow): Promise<TripDto> {
    const { rows } = await sql<{ n: number }>`select count(*)::int as n from app.transaction
       where workspace_id = ${ctx.workspaceId} and trip_id = ${r.id} and deleted_at is null`.execute(trx);
    return {
      id: r.id,
      name: r.name,
      startDate: r.start_date,
      endDate: r.end_date,
      currency: r.currency,
      timeZone: r.time_zone,
      transactionCount: rows[0]?.n ?? 0,
      version: r.version.toString(),
    };
  }
}

/** Trips per database transaction: bulk imports tag thousands of rows without a query each. */
const tripCache = new WeakMap<Trx, Map<string, Array<{ id: string; start: string; end: string }>>>();

/** The trip whose window contains `date` (newest first), for tagging new transactions (CUR-09). */
export async function tripOn(trx: Trx, workspaceId: string, date: string): Promise<string | null> {
  let byWorkspace = tripCache.get(trx);
  if (!byWorkspace) {
    byWorkspace = new Map();
    tripCache.set(trx, byWorkspace);
  }
  let trips = byWorkspace.get(workspaceId);
  if (!trips) {
    const rows = await trx
      .selectFrom('app.trip')
      .select(['id', 'start_date', 'end_date'])
      .where('workspace_id', '=', workspaceId)
      .where('deleted_at', 'is', null)
      .orderBy('start_date', 'desc')
      .execute();
    trips = rows.map((r) => ({ id: r.id, start: r.start_date, end: r.end_date }));
    byWorkspace.set(workspaceId, trips);
  }
  return trips.find((t) => t.start <= date && t.end >= date)?.id ?? null;
}

const UpdateTripRequest = TripInput.and(z.object({ version: z.string() }));

@Controller('v1/workspaces/:workspaceId/trips')
@UseGuards(AuthGuard, WorkspaceGuard)
export class TripsController {
  constructor(@Inject(TripsService) private readonly trips: TripsService) {}

  @Get()
  async list(@Ctx() ctx: RequestContext): Promise<{ data: TripDto[] }> {
    return { data: await this.trips.list(dbCtx(ctx)) };
  }

  @Post()
  create(@Ctx() ctx: RequestContext, @Body() body: unknown): Promise<TripDto> {
    requireRole(ctx, 'owner', 'admin', 'partner', 'member');
    return this.trips.create(dbCtx(ctx), parse(TripInput, body));
  }

  @Patch(':id')
  update(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown): Promise<TripDto> {
    requireRole(ctx, 'owner', 'admin', 'partner', 'member');
    return this.trips.update(dbCtx(ctx), parse(z.uuid(), id), parse(UpdateTripRequest, body));
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@Ctx() ctx: RequestContext, @Param('id') id: string): Promise<void> {
    requireRole(ctx, 'owner', 'admin', 'partner', 'member');
    await this.trips.remove(dbCtx(ctx), parse(z.uuid(), id));
  }
}
