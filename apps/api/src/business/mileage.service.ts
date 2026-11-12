/**
 * Mileage log (BIZ-07, ADR-0017 §5). A deduction, not a cash movement: it reaches Schedule C and never the ledger. Each
 * trip keeps the rate in force on its date, and a later correction to the table can't rewrite a past year.
 *
 * Each trip has a driver (BIZ-19, ADR-0035 §8). Only the owner's trips are the deduction. A payroll person's trip is
 * worth the same at the rate, and reimbursing it makes an approved payroll reimbursement instead, so it isn't counted
 * twice.
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
import { personName } from '../payroll/shared.js';
import { ReimbursementsService } from '../payroll/reimbursements.service.js';
import { assetAccount } from './asset-accounts.js';
import {
  businessEntity,
  dateOf,
  formatScaled,
  parseScaled,
  TAX_COUNTRY,
  todayOf,
  type Ctx,
} from './shared.js';

type ReimbursementState = MileageTripDto['reimbursementStatus'];

@Injectable()
export class MileageService {
  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(ReimbursementsService) private readonly reimbursements: ReimbursementsService,
  ) {}

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
      const states = await this.reimbursementStates(trx, ctx, rows);
      const trips = rows.map((r) => toDto(r, states.get(r.id) ?? null));
      const owner = rows.filter((r) => r.driver === 'owner');
      const drivers = new Map<
        string,
        MileageSummaryDto['byDriver'][number] & { tenths: bigint; total: bigint }
      >();
      for (const r of rows) {
        const key = r.driver === 'owner' ? 'owner' : `person:${r.driver_person_id ?? r.driver_name}`;
        const cur = drivers.get(key) ?? {
          driver: r.driver,
          personId: r.driver === 'owner' ? null : r.driver_person_id,
          name: r.driver === 'owner' ? null : r.driver_name,
          trips: 0,
          miles: '0',
          amount: '0',
          reimbursed: '0',
          tenths: 0n,
          total: 0n,
        };
        cur.trips += 1;
        cur.tenths += BigInt(r.miles_tenths);
        cur.total += BigInt(r.deduction_minor);
        const state = states.get(r.id);
        if (state && state !== 'declined')
          cur.reimbursed = String(BigInt(cur.reimbursed) + BigInt(r.deduction_minor));
        drivers.set(key, cur);
      }
      const byDriver = [...drivers.values()]
        .sort((a, b) =>
          a.driver !== b.driver
            ? a.driver === 'owner'
              ? -1
              : 1
            : (a.name ?? '').localeCompare(b.name ?? ''),
        )
        .map(({ tenths, total, ...d }) => ({ ...d, miles: formatScaled(tenths, 1), amount: String(total) }));
      return {
        year: y,
        trips,
        miles: formatScaled(
          owner.reduce((t, r) => t + BigInt(r.miles_tenths), 0n),
          1,
        ),
        deduction: String(owner.reduce((t, r) => t + BigInt(r.deduction_minor), 0n)),
        currency: asCurrencyCode(e.currency),
        byDriver,
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

  /** The driver's columns: the owner, or a payroll person of this business. */
  private async driver(
    trx: Trx,
    ctx: Ctx,
    entityId: string,
    personId: string | null,
  ): Promise<Pick<MileageTripRow, 'driver' | 'driver_person_id' | 'driver_name'>> {
    if (!personId) return { driver: 'owner', driver_person_id: null, driver_name: null };
    const p = await trx
      .selectFrom('app.payroll_person')
      .select(['id', 'first_name', 'middle_name', 'last_name'])
      .where('workspace_id', '=', ctx.workspaceId)
      .where('entity_id', '=', entityId)
      .where('id', '=', personId)
      .executeTakeFirst();
    if (!p) throw notFound('Person');
    return { driver: 'person', driver_person_id: p.id, driver_name: personName(p) };
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
          ...(await this.driver(trx, ctx, req.entityId, req.driverPersonId ?? null)),
          created_by: ctx.userId,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      return toDto(row, null);
    });
  }

  async update(ctx: Ctx, id: string, req: UpdateTripRequest): Promise<MileageTripDto> {
    return this.db.run(ctx, async (trx) => {
      const r = await this.row(trx, ctx, id);
      if (BigInt(r.version) !== BigInt(req.version)) {
        throw new AppError(409, 'version.conflict', 'Someone else changed this; reload and try again');
      }
      const state = (await this.reimbursementStates(trx, ctx, [r])).get(r.id) ?? null;
      const fixed = req.date !== undefined || req.miles !== undefined || req.driverPersonId !== undefined;
      if (fixed && state && state !== 'declined') {
        throw unprocessable(
          'mileage.reimbursed',
          "This trip has a reimbursement, so its date, miles and driver can't change",
        );
      }
      const tenths = req.miles !== undefined ? Number(parseScaled(req.miles, 1)) : r.miles_tenths;
      if (tenths <= 0) throw unprocessable('mileage.miles', 'Enter the miles driven');
      // A new date can mean a new rate; otherwise the trip keeps the one it has.
      const rate = req.date !== undefined ? await this.rateOn(trx, req.date) : r.tenths_of_cent;
      const driver =
        req.driverPersonId !== undefined ? await this.driver(trx, ctx, r.entity_id, req.driverPersonId) : {};
      const row = await trx
        .updateTable('app.mileage_trip')
        .set({
          ...(req.date !== undefined ? { trip_date: req.date } : {}),
          ...(req.origin !== undefined ? { origin: req.origin } : {}),
          ...(req.destination !== undefined ? { destination: req.destination } : {}),
          ...(req.purpose !== undefined ? { purpose: req.purpose } : {}),
          ...(req.vehicle !== undefined ? { vehicle: req.vehicle } : {}),
          ...driver,
          // A declined reimbursement no longer holds the trip.
          ...(fixed && state === 'declined' ? { reimbursement_id: null } : {}),
          miles_tenths: tenths,
          tenths_of_cent: rate,
          deduction_minor: mileageDeduction(tenths, rate),
        })
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirstOrThrow();
      return toDto(row, (await this.reimbursementStates(trx, ctx, [row])).get(row.id) ?? null);
    });
  }

  async remove(ctx: Ctx, id: string): Promise<void> {
    await this.db.run(ctx, async (trx) => {
      const r = await this.row(trx, ctx, id);
      const state = (await this.reimbursementStates(trx, ctx, [r])).get(r.id);
      if (state && state !== 'declined') {
        throw unprocessable('mileage.reimbursed', "This trip has a reimbursement, so it can't be deleted");
      }
      await trx
        .deleteFrom('app.mileage_trip')
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', id)
        .execute();
    });
  }

  /**
   * "Reimburse this trip" (BIZ-19): an approved payroll reimbursement for the trip's value at the IRS rate on its
   * date, to the Mileage reimbursements category. An employee's is paid untaxed on the next pay run; a contractor's
   * becomes a bill (ADR-0034 §8).
   */
  async reimburse(ctx: Ctx, id: string): Promise<MileageTripDto> {
    return this.db.run(ctx, async (trx) => {
      const r = await this.row(trx, ctx, id);
      if (r.driver !== 'person' || !r.driver_person_id) {
        throw unprocessable(
          'mileage.owner_trip',
          "The owner's trips are the mileage deduction; only someone else's can be reimbursed",
        );
      }
      const state = (await this.reimbursementStates(trx, ctx, [r])).get(r.id);
      if (state && state !== 'declined') {
        throw unprocessable('mileage.reimbursed', 'This trip is already reimbursed');
      }
      const e = await businessEntity(trx, ctx, r.entity_id);
      const category = await assetAccount(trx, ctx, e.id, e.currency, 'mileage_reimbursements');
      const miles = formatScaled(r.miles_tenths, 1);
      const cents = formatScaled(r.tenths_of_cent, 1);
      const created = await this.reimbursements.createIn(trx, ctx, {
        entityId: e.id,
        personId: r.driver_person_id,
        spentOn: dateOf(r.trip_date),
        description: `Mileage: ${r.purpose} (${miles} mi at ${cents}¢)`.slice(0, 500),
        amount: String(r.deduction_minor),
        expenseAccountId: category,
        fileIds: [],
      });
      await this.reimbursements.decideIn(trx, ctx, created.id, {
        decision: 'approve',
        version: created.version,
      });
      const row = await trx
        .updateTable('app.mileage_trip')
        .set({ reimbursement_id: created.id })
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirstOrThrow();
      return toDto(row, (await this.reimbursementStates(trx, ctx, [row])).get(row.id) ?? null);
    });
  }

  private async row(trx: Trx, ctx: Ctx, id: string): Promise<MileageTripRow> {
    const r = await trx
      .selectFrom('app.mileage_trip')
      .selectAll()
      .where('workspace_id', '=', ctx.workspaceId)
      .where('id', '=', id)
      .executeTakeFirst();
    if (!r) throw notFound('Trip');
    return r;
  }

  /** Each reimbursed trip's reimbursement state: paid once its pay run is approved or its bill is paid. */
  private async reimbursementStates(
    trx: Trx,
    ctx: Ctx,
    rows: MileageTripRow[],
  ): Promise<Map<string, NonNullable<ReimbursementState>>> {
    const out = new Map<string, NonNullable<ReimbursementState>>();
    const ids = rows.filter((r) => r.reimbursement_id).map((r) => r.reimbursement_id!);
    if (ids.length === 0) return out;
    const found = await trx
      .selectFrom('app.reimbursement as r')
      .leftJoin('app.paycheck as p', (j) =>
        j.onRef('p.workspace_id', '=', 'r.workspace_id').onRef('p.id', '=', 'r.paycheck_id'),
      )
      .leftJoin('app.pay_run as run', (j) =>
        j.onRef('run.workspace_id', '=', 'p.workspace_id').onRef('run.id', '=', 'p.pay_run_id'),
      )
      .leftJoin('app.bill as b', (j) =>
        j.onRef('b.workspace_id', '=', 'r.workspace_id').onRef('b.id', '=', 'r.bill_id'),
      )
      .select(['r.id', 'r.status', 'run.status as run_status', 'b.status as bill_status'])
      .where('r.workspace_id', '=', ctx.workspaceId)
      .where('r.id', 'in', ids)
      .execute();
    for (const t of rows) {
      const f = found.find((x) => x.id === t.reimbursement_id);
      if (!f) continue;
      const paid = f.run_status === 'approved' || f.bill_status === 'paid';
      out.set(t.id, paid ? 'paid' : f.status);
    }
    return out;
  }
}

function toDto(r: MileageTripRow, reimbursement: ReimbursementState): MileageTripDto {
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
    driver: r.driver,
    driverPersonId: r.driver_person_id,
    driverName: r.driver_name,
    reimbursementId: r.reimbursement_id,
    reimbursementStatus: reimbursement,
    version: Number(r.version),
  };
}
