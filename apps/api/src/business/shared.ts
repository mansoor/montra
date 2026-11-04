/** Helpers shared by the business services (ADR-0017). */
import { sql } from 'kysely';
import type { Trx } from '@montra/db';
import { calendarDate, todayIn, type CalendarDate } from '@montra/domain';
import { notFound, unprocessable } from '../common/errors.js';

export type Ctx = { workspaceId: string; userId: string };

/** Reference data is keyed by country; R1 ships US tax lines and rates (design 10, assumption 1). */
export const TAX_COUNTRY = 'US';

export interface BusinessEntity {
  id: string;
  type: 'business' | 'rental';
  name: string;
  currency: string;
  businessType: string | null;
  fiscalYearStartMonth: number;
  timeZone: string;
}

/** The business, under RLS: without access to it, it doesn't exist. */
export async function businessEntity(trx: Trx, ctx: Ctx, entityId: string): Promise<BusinessEntity> {
  return readEntity(trx, ctx, entityId, ['business']);
}

/** A business or a rental portfolio: both have a tax rate, a set-aside and tax lines (REC-09, AI-10). */
export async function taxedEntity(trx: Trx, ctx: Ctx, entityId: string): Promise<BusinessEntity> {
  return readEntity(trx, ctx, entityId, ['business', 'rental']);
}

async function readEntity(
  trx: Trx,
  ctx: Ctx,
  entityId: string,
  types: readonly string[],
): Promise<BusinessEntity> {
  const e = await trx
    .selectFrom('app.entity as e')
    .innerJoin('app.workspace as w', 'w.id', 'e.workspace_id')
    .select([
      'e.id',
      'e.name',
      'e.type',
      'e.functional_currency',
      'e.business_type',
      'e.fiscal_year_start_month',
      'w.time_zone',
    ])
    .where('e.workspace_id', '=', ctx.workspaceId)
    .where('e.id', '=', entityId)
    .executeTakeFirst();
  if (!e) throw notFound('Business');
  if (!types.includes(e.type)) throw unprocessable('business.not_a_business', 'This is not a business');
  return {
    id: e.id,
    type: e.type as BusinessEntity['type'],
    name: e.name,
    currency: e.functional_currency,
    businessType: e.business_type,
    fiscalYearStartMonth: e.fiscal_year_start_month,
    timeZone: e.time_zone,
  };
}

/** Every business this login can read. */
export async function businessEntities(trx: Trx, ctx: Ctx): Promise<BusinessEntity[]> {
  const rows = await trx
    .selectFrom('app.entity')
    .select('id')
    .where('workspace_id', '=', ctx.workspaceId)
    .where('type', '=', 'business')
    .where('archived_at', 'is', null)
    .orderBy('name')
    .execute();
  return Promise.all(rows.map((r) => businessEntity(trx, ctx, r.id)));
}

export const todayOf = (e: Pick<BusinessEntity, 'timeZone'>): CalendarDate => todayIn(e.timeZone);

/** "1.5" at 3 places = 1500n. No floats: the text is already validated digits. */
export function parseScaled(text: string, places: number): bigint {
  const [whole = '0', frac = ''] = text.split('.');
  return BigInt(whole + frac.padEnd(places, '0').slice(0, places));
}

/** 1500n at 3 places = "1.5"; trailing zeros go. */
export function formatScaled(n: bigint | number, places: number): string {
  const digits = String(n).padStart(places + 1, '0');
  const whole = digits.slice(0, digits.length - places);
  const frac = digits.slice(digits.length - places).replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole;
}

/** What the business earned and spent in a date range, in its own currency. Cash basis: the ledger already is. */
export async function profitBetween(
  trx: Trx,
  ctx: Ctx,
  entityId: string,
  from: CalendarDate,
  to: CalendarDate,
): Promise<{ revenue: bigint; expenses: bigint; profit: bigint }> {
  const { rows } = await sql<{ revenue: string; expenses: string }>`
    select coalesce(sum(-p.functional_amount_minor) filter (where a.type = 'income'), 0)::text as revenue,
           coalesce(sum(p.functional_amount_minor) filter (where a.type = 'expense'), 0)::text as expenses
      from app.posting p
      join app.ledger_account a on a.workspace_id = p.workspace_id and a.id = p.ledger_account_id
     where p.workspace_id = ${ctx.workspaceId} and p.entity_id = ${entityId}
       and p.entry_date between ${from} and ${to}`.execute(trx);
  const revenue = BigInt(rows[0]?.revenue ?? '0');
  const expenses = BigInt(rows[0]?.expenses ?? '0');
  return { revenue, expenses, profit: revenue - expenses };
}

export const dateOf = (v: unknown): CalendarDate => calendarDate(String(v).slice(0, 10));

/** Everything that gets tax notes. */
export async function taxedEntities(trx: Trx, ctx: Ctx): Promise<BusinessEntity[]> {
  const rows = await trx
    .selectFrom('app.entity')
    .select('id')
    .where('workspace_id', '=', ctx.workspaceId)
    .where('type', 'in', ['business', 'rental'])
    .where('archived_at', 'is', null)
    .orderBy('name')
    .execute();
  return Promise.all(rows.map((r) => taxedEntity(trx, ctx, r.id)));
}
