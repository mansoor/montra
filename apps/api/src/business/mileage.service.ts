/**
 * Mileage log (BIZ-07, ADR-0017 §5). A deduction, not a cash movement: it reaches Schedule C and never the ledger. Each
 * trip keeps the rate in force on its date, and a later correction to the table can't rewrite a past year.
 */
import { Inject, Injectable } from '@nestjs/common';
import { newId, type MileageTripRow, type Trx } from '@montra/db';
import { asCurrencyCode, mileageDeduction, mileageRateOn, type CalendarDate } from '@montra/domain';
import type {
  CreateTripRequest,
  MileageSummaryDto,
  MileageTripDto,
  UpdateTripRequest,
} from '@montra/schemas';
import { AppError, notFound, unprocessable } from '../common/errors.js';
import { Db } from '../db/database.js';
import {
  businessEntity,
  dateOf,
  formatScaled,
  parseScaled,
  TAX_COUNTRY,
  todayOf,
  type Ctx,
} from './shared.js';

@Injectable()
export class MileageService {
  constructor(@Inject(Db) private readonly db: Db) {}

  async summary(ctx: Ctx, entityId: string, year?: number): Promise<MileageSummaryDto> {
    return this.db.run(ctx, async (trx) => {
      const e = await businessEntity(trx, ctx, entityId);
      const y = year ?? Number(todayOf(e).slice(0, 4));
      const rows = await trx
        .selectFrom('app.mileage_trip')
        .selectAll()
        .where('workspace_id', '=', ctx.workspaceId)
        .where('entity_id', '=', entityId)
        .where('trip_date', '>=', `${y}-01-01`)
        .where('trip_date', '<=', `${y}-12-31`)
        .orderBy('trip_date', 'desc')
        .orderBy('created_at', 'desc')
        .execute();
      return {
        year: y,
        trips: rows.map(toDto),
        miles: formatScaled(
          rows.reduce((t, r) => t + BigInt(r.miles_tenths), 0n),
          1,
        ),
        deduction: String(rows.reduce((t, r) => t + BigInt(r.deduction_minor), 0n)),
        currency: asCurrencyCode(e.currency),
      };
    });
  }

  private async rateOn(trx: Trx, date: CalendarDate): Promise<number> {
    const rates = await trx
      .selectFrom('ref.mileage_rate')
      .select(['effective_from', 'tenths_of_cent'])
      .where('country', '=', TAX_COUNTRY)
      .execute();
    const rate = mileageRateOn(
      rates.map((r) => ({ effectiveFrom: dateOf(r.effective_from), tenths: r.tenths_of_cent })),
      date,
    );
    if (!rate) throw unprocessable('mileage.no_rate', 'There is no standard mileage rate for that date');
    return rate.tenths;
  }

  async create(ctx: Ctx, req: CreateTripRequest): Promise<MileageTripDto> {
    return this.db.run(ctx, async (trx) => {
      await businessEntity(trx, ctx, req.entityId);
      const tenths = Number(parseScaled(req.miles, 1));
      if (tenths <= 0) throw unprocessable('mileage.miles', 'Enter the miles driven');
      const rate = await this.rateOn(trx, req.date);
      const row = await trx
        .insertInto('app.mileage_trip')
        .values({
          workspace_id: ctx.workspaceId,
          id: newId(),
          entity_id: req.entityId,
          trip_date: req.date,
          origin: req.origin ?? null,
          destination: req.destination ?? null,
          purpose: req.purpose,
          vehicle: req.vehicle ?? null,
          miles_tenths: tenths,
          tenths_of_cent: rate,
          deduction_minor: mileageDeduction(tenths, rate),
          created_by: ctx.userId,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      return toDto(row);
    });
  }

  async update(ctx: Ctx, id: string, req: UpdateTripRequest): Promise<MileageTripDto> {
    return this.db.run(ctx, async (trx) => {
      const r = await trx
        .selectFrom('app.mileage_trip')
        .selectAll()
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', id)
        .executeTakeFirst();
      if (!r) throw notFound('Trip');
      if (BigInt(r.version) !== BigInt(req.version)) {
        throw new AppError(409, 'version.conflict', 'Someone else changed this; reload and try again');
      }
      const tenths = req.miles !== undefined ? Number(parseScaled(req.miles, 1)) : r.miles_tenths;
      if (tenths <= 0) throw unprocessable('mileage.miles', 'Enter the miles driven');
      // A new date can mean a new rate; otherwise the trip keeps the one it has.
      const rate = req.date !== undefined ? await this.rateOn(trx, req.date) : r.tenths_of_cent;
      const row = await trx
        .updateTable('app.mileage_trip')
        .set({
          ...(req.date !== undefined ? { trip_date: req.date } : {}),
          ...(req.origin !== undefined ? { origin: req.origin } : {}),
          ...(req.destination !== undefined ? { destination: req.destination } : {}),
          ...(req.purpose !== undefined ? { purpose: req.purpose } : {}),
          ...(req.vehicle !== undefined ? { vehicle: req.vehicle } : {}),
          miles_tenths: tenths,
          tenths_of_cent: rate,
          deduction_minor: mileageDeduction(tenths, rate),
        })
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirstOrThrow();
      return toDto(row);
    });
  }

  async remove(ctx: Ctx, id: string): Promise<void> {
    await this.db.run(ctx, async (trx) => {
      const res = await trx
        .deleteFrom('app.mileage_trip')
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', id)
        .executeTakeFirst();
      if (!res.numDeletedRows) throw notFound('Trip');
    });
  }
}

function toDto(r: MileageTripRow): MileageTripDto {
  return {
    id: r.id,
    entityId: r.entity_id,
    date: dateOf(r.trip_date),
    origin: r.origin,
    destination: r.destination,
    purpose: r.purpose,
    vehicle: r.vehicle,
    miles: formatScaled(r.miles_tenths, 1),
    centsPerMile: formatScaled(r.tenths_of_cent, 1),
    deduction: String(r.deduction_minor),
    version: Number(r.version),
  };
}
