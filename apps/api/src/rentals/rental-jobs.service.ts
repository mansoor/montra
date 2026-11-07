/**
 * What runs for a portfolio without being asked (ADR-0018): writing charges a month ahead, assessing late fees, linking what's
 * unambiguous, and flagging spending that may need capitalizing (RNT-04, RNT-05, RNT-08, RNT-09).
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'kysely';
import { newId, type Trx } from '@montra/db';
import {
  addDays,
  calendarDate,
  matchRentDeposits,
  type CalendarDate,
  type DepositLine,
  type OpenLease,
} from '@montra/domain';
import { AiService } from '../ai/ai.service.js';
import { Db } from '../db/database.js';
import { NOT_OWNED } from '../transactions/poster.js';
import { LoansService } from './loans.service.js';
import { leaseStatus, PropertiesService } from './properties.service.js';
import { RentService } from './rent.service.js';
import { rentalEntities, todayOf, type Ctx, type RentalEntity } from './shared.js';

const iso = (v: unknown): CalendarDate => calendarDate(String(v).slice(0, 10));

/** Lines this recent are looked at for rent; older ones were already looked at. */
const MATCH_DAYS = 60;
/** The IRS de minimis safe harbor: below this, an item can generally be expensed. Flags, doesn't decide. */
const CAPITAL_FLAG_MINOR = 250000n;
/** AI is asked about smaller items from here. */
const CAPITAL_ASK_MINOR = 50000n;
const CAPITAL_DAYS = 30;
const CAPITAL_MAX = 50;
/** Categories where something capital is likely to have been filed as an expense. */
const REPAIR_LINES = ['US_SCH_E_L7', 'US_SCH_E_L14', 'US_SCH_E_L15', 'US_SCH_E_L19'];

@Injectable()
export class RentalJobs {
  private readonly logger = new Logger('Rentals');

  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(AiService) private readonly ai: AiService,
    @Inject(PropertiesService) private readonly properties: PropertiesService,
    @Inject(RentService) private readonly rent: RentService,
    @Inject(LoansService) private readonly loans: LoansService,
  ) {}

  /** The nightly run for one workspace. A failure in one part doesn't stop the rest. */
  async nightly(
    ctx: Ctx,
  ): Promise<{ charges: number; fees: number; linked: number; recorded: number; flagged: number }> {
    const out = { charges: 0, fees: 0, linked: 0, recorded: 0, flagged: 0 };
    for (const [key, fn] of [
      ['charges', () => this.writeCharges(ctx)],
      ['linked', () => this.matchPayments(ctx)],
      // After matching, so a statement line wins over recording the payment by itself.
      ['recorded', () => this.loans.autoRecord(ctx)],
      ['fees', () => this.assessFees(ctx)],
      ['flagged', () => this.flagCapital(ctx)],
    ] as const) {
      try {
        out[key] = await fn();
      } catch (e) {
        this.logger.warn(`${key} failed for ${ctx.workspaceId}: ${(e as Error).message}`);
      }
    }
    return out;
  }

  async writeCharges(ctx: Ctx): Promise<number> {
    return this.db.run(ctx, async (trx) => {
      let added = 0;
      for (const e of await rentalEntities(trx, ctx)) {
        const leases = await trx
          .selectFrom('app.lease')
          .selectAll()
          .where('workspace_id', '=', ctx.workspaceId)
          .where('entity_id', '=', e.id)
          .execute();
        for (const l of leases) added += await this.properties.ensureCharges(trx, ctx, l, todayOf(e));
      }
      return added;
    });
  }

  async assessFees(ctx: Ctx): Promise<number> {
    return this.db.run(ctx, async (trx) => {
      let added = 0;
      for (const e of await rentalEntities(trx, ctx)) {
        added += await this.rent.assessLateFees(trx, ctx, e.id, todayOf(e));
      }
      return added;
    });
  }

  /** Links rent, deposits and mortgage payments where it's unambiguous. Each in its own transaction, so one failure stays one. */
  async matchPayments(ctx: Ctx): Promise<number> {
    const plan = await this.db.run(ctx, async (trx) => {
      const out: {
        entityId: string;
        leaseId: string;
        depositId: string;
        kind: 'rent' | 'security_deposit';
      }[] = [];
      for (const e of await rentalEntities(trx, ctx)) {
        for (const m of await this.planFor(trx, ctx, e)) out.push({ entityId: e.id, ...m });
      }
      return out;
    });
    let linked = 0;
    for (const p of plan) {
      try {
        await this.db.run(ctx, (trx) =>
          p.kind === 'rent'
            ? this.rent.recordPaymentIn(trx, ctx, p.leaseId, { transactionId: p.depositId }, 'auto')
            : this.rent.addDepositEventIn(
                trx,
                ctx,
                p.leaseId,
                { kind: 'received', transactionId: p.depositId },
                'auto',
              ),
        );
        linked++;
      } catch (e) {
        this.logger.warn(`Could not link ${p.kind} to lease ${p.leaseId}: ${(e as Error).message}`);
      }
    }
    try {
      linked += await this.loans.autoMatch(ctx);
    } catch (err) {
      this.logger.warn(`Could not link loan payments: ${(err as Error).message}`);
    }
    return linked;
  }

  private async planFor(trx: Trx, ctx: Ctx, e: RentalEntity) {
    const today = todayOf(e);
    const leases = await trx
      .selectFrom('app.lease')
      .selectAll()
      .where('workspace_id', '=', ctx.workspaceId)
      .where('entity_id', '=', e.id)
      .execute();
    if (leases.length === 0) return [];
    const states = await this.rent.leaseStates(trx, ctx, leases, today);
    const tenants = await trx
      .selectFrom('app.lease_tenant as lt')
      .innerJoin('app.tenant as t', (j) =>
        j.onRef('t.workspace_id', '=', 'lt.workspace_id').onRef('t.id', '=', 'lt.tenant_id'),
      )
      .select(['lt.lease_id', 't.name', 't.payee_keys'])
      .where('t.workspace_id', '=', ctx.workspaceId)
      .where('t.entity_id', '=', e.id)
      .execute();
    const events = await trx
      .selectFrom('app.security_deposit_event')
      .select('lease_id')
      .where('workspace_id', '=', ctx.workspaceId)
      .where('entity_id', '=', e.id)
      .where('kind', '=', 'received')
      .execute();
    const received = new Set(events.map((ev) => ev.lease_id));
    const open: OpenLease[] = states
      .filter((s) => leaseStatus(s.lease, today) !== 'ended' || s.charges.some((c) => c.open > 0n))
      .map((s) => ({
        id: s.lease.id,
        tenantNames: tenants.filter((t) => t.lease_id === s.lease.id).map((t) => t.name),
        payeeKeys: tenants.filter((t) => t.lease_id === s.lease.id).flatMap((t) => t.payee_keys),
        openCharges: s.charges
          .filter((c) => c.open > 0n && c.kind === 'rent')
          .map((c) => ({ open: c.open, due: c.due })),
        depositOwed: received.has(s.lease.id) ? 0n : BigInt(s.lease.deposit_minor),
        start: iso(s.lease.start_date),
      }));
    if (open.length === 0) return [];
    const { rows } = await sql<{ id: string; d: string; amount: string; payer: string; key: string | null }>`
      select t.id, t.txn_date::text as d, t.spec->>'amount' as amount,
             concat_ws(' ', t.payee_raw, t.description, t.raw_description) as payer, t.payee_key as key
        from app.transaction t
       where t.workspace_id = ${ctx.workspaceId} and t.primary_entity_id = ${e.id}
         and t.status = 'posted' and t.deleted_at is null and t.spec->>'type' = 'standard'
         and (t.spec->>'amount')::bigint > 0
         and t.txn_date between ${addDays(today, -MATCH_DAYS)} and ${addDays(today, 7)}
         and ${NOT_OWNED}
       order by t.txn_date, t.id
       limit 2000`.execute(trx);
    const lines: DepositLine[] = rows.map((r) => ({
      id: r.id,
      date: calendarDate(r.d),
      amount: BigInt(r.amount),
      payer: r.payer,
      payeeKey: r.key,
    }));
    return matchRentDeposits(open, lines);
  }

  /**
   * Large items in repair-like categories. From the de minimis figure up they're flagged in code; AI is asked about smaller ones
   * when it's on. Payee and category go to the provider, never anything about tenants. The owner decides either way.
   */
  async flagCapital(ctx: Ctx): Promise<number> {
    return this.db.run(ctx, async (trx) => {
      let flagged = 0;
      for (const e of await rentalEntities(trx, ctx)) flagged += await this.flagFor(trx, ctx, e);
      return flagged;
    });
  }

  private async flagFor(trx: Trx, ctx: Ctx, e: RentalEntity): Promise<number> {
    const since = addDays(todayOf(e), -CAPITAL_DAYS);
    const { rows: items } = await sql<{
      id: string;
      payee: string;
      payee_key: string | null;
      amount: string;
      category: string;
      property_id: string | null;
    }>`
      select t.id, coalesce(t.payee_raw, t.description) as payee, t.payee_key, t.spec->>'amount' as amount,
             a.name as category, t.spec->'splits'->0->>'propertyId' as property_id
        from app.transaction t
        join lateral (select (t.spec->'splits'->0->>'accountId')::uuid as id) s on true
        join app.ledger_account a on a.workspace_id = t.workspace_id and a.id = s.id
       where t.workspace_id = ${ctx.workspaceId} and t.primary_entity_id = ${e.id}
         and t.status = 'posted' and t.deleted_at is null and t.spec->>'type' = 'standard'
         and jsonb_array_length(t.spec->'splits') = 1
         and (t.spec->>'amount')::bigint <= ${String(-CAPITAL_ASK_MINOR)}::bigint
         and t.txn_date >= ${since}
         and a.tax_line_code = any(${REPAIR_LINES}::text[])
         and ${NOT_OWNED}
         and not exists (select 1 from app.insight i where i.workspace_id = t.workspace_id
                          and i.dedupe_key = 'capital:' || t.id::text)
       order by t.txn_date desc
       limit ${CAPITAL_MAX}`.execute(trx);
    if (items.length === 0) return 0;
    let flagged = 0;
    const store = async (item: (typeof items)[number], reason: string) => {
      const res = await trx
        .insertInto('app.insight')
        .values({
          workspace_id: ctx.workspaceId,
          id: newId(),
          kind: 'capital_improvement',
          entity_id: e.id,
          transaction_id: item.id,
          payee_key: item.payee_key,
          dedupe_key: `capital:${item.id}`,
          data: JSON.stringify({
            payee: item.payee,
            message: reason,
            amount: item.amount,
            currency: e.currency,
            category: item.category,
            propertyId: item.property_id,
          }),
        })
        .onConflict((oc) => oc.columns(['workspace_id', 'dedupe_key']).doNothing())
        .executeTakeFirst();
      if (res.numInsertedOrUpdatedRows) flagged++;
    };
    const smaller: typeof items = [];
    for (const item of items) {
      if (-BigInt(item.amount) >= CAPITAL_FLAG_MINOR) {
        await store(
          item,
          `This is a large amount for ${item.category}. It may be an improvement to capitalize rather than a repair.`,
        );
      } else {
        smaller.push(item);
      }
    }
    const runtime = await this.ai.runtime(trx, ctx, { type: 'rental', id: e.id });
    if (!runtime.available || smaller.length === 0) return flagged;
    const res = await this.ai.gateway.flagCapital(
      {
        items: smaller.map((i) => ({
          id: i.id,
          payee: i.payee,
          amountMinor: BigInt(i.amount),
          currency: e.currency,
          category: i.category,
        })),
      },
      { ...runtime.ctx, parkLocal: false },
    );
    if (!res.ok) return flagged;
    for (const f of res.value) {
      const item = smaller.find((i) => i.id === f.id);
      if (item) await store(item, f.reason);
    }
    return flagged;
  }
}
