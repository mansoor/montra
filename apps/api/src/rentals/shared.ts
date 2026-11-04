/** Helpers shared by the rental services (ADR-0018). */
import { sql } from 'kysely';
import type { Trx } from '@montra/db';
import { todayIn, type CalendarDate } from '@montra/domain';
import { notFound, unprocessable } from '../common/errors.js';

export type Ctx = { workspaceId: string; userId: string };

export interface RentalEntity {
  id: string;
  name: string;
  currency: string;
  timeZone: string;
}

/** The portfolio, under RLS: without access to it, it doesn't exist. */
export async function rentalEntity(trx: Trx, ctx: Ctx, entityId: string): Promise<RentalEntity> {
  const e = await trx
    .selectFrom('app.entity as e')
    .innerJoin('app.workspace as w', 'w.id', 'e.workspace_id')
    .select(['e.id', 'e.name', 'e.type', 'e.functional_currency', 'w.time_zone'])
    .where('e.workspace_id', '=', ctx.workspaceId)
    .where('e.id', '=', entityId)
    .executeTakeFirst();
  if (!e) throw notFound('Portfolio');
  if (e.type !== 'rental') throw unprocessable('rental.not_a_portfolio', 'This is not a rental portfolio');
  return { id: e.id, name: e.name, currency: e.functional_currency, timeZone: e.time_zone };
}

export async function rentalEntities(trx: Trx, ctx: Ctx): Promise<RentalEntity[]> {
  const rows = await trx
    .selectFrom('app.entity')
    .select('id')
    .where('workspace_id', '=', ctx.workspaceId)
    .where('type', '=', 'rental')
    .where('archived_at', 'is', null)
    .orderBy('name')
    .execute();
  return Promise.all(rows.map((r) => rentalEntity(trx, ctx, r.id)));
}

export const todayOf = (e: Pick<RentalEntity, 'timeZone'>): CalendarDate => todayIn(e.timeZone);

/** The category on a Schedule E line. Found by line, not name: the owner may have renamed it. */
export async function categoryOnLine(trx: Trx, ctx: Ctx, entityId: string, code: string): Promise<string> {
  const c = await trx
    .selectFrom('app.ledger_account')
    .select('id')
    .where('workspace_id', '=', ctx.workspaceId)
    .where('entity_id', '=', entityId)
    .where('tax_line_code', '=', code)
    .where('is_category', '=', true)
    .where('archived_at', 'is', null)
    // Two categories can share a line; "Rents received" comes before "Other rental income".
    .orderBy(sql`name like 'Other%'`)
    .orderBy('name')
    .limit(1)
    .executeTakeFirst();
  if (!c) throw unprocessable('rental.category', 'This portfolio is missing a category it needs');
  return c.id;
}

export const SCH_E = {
  RENTS: 'US_SCH_E_L3',
  INSURANCE: 'US_SCH_E_L9',
  MORTGAGE_INTEREST: 'US_SCH_E_L12',
  OTHER_INTEREST: 'US_SCH_E_L13',
  TAXES: 'US_SCH_E_L16',
  DEPRECIATION: 'US_SCH_E_L18',
} as const;

/** "1.5" baths = 15 tenths. */
export function bathsToTenths(baths: string): number {
  const [whole = '0', frac = '0'] = baths.split('.');
  return Number(whole) * 10 + Number(frac);
}

export const tenthsToBaths = (t: number): string =>
  t % 10 === 0 ? String(t / 10) : `${Math.trunc(t / 10)}.${t % 10}`;
