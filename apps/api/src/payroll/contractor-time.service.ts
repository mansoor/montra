/**
 * Contractor timesheets (PRL-28; ADR-0036 §5). Hours are kept per day; billing chosen unbilled hours makes one bill to the
 * contractor's vendor record for hours × their hourly rate, so the 1099-NEC sees them through the bill as before. Billed
 * hours are locked while their bill stands (a database trigger as well as here); voiding the bill frees them.
 */
import { Inject, Injectable } from '@nestjs/common';
import { newId, type ContractorTimeRow, type PayrollPersonRow, type Trx } from '@montra/db';
import { calendarDate, hoursPay, todayIn, type CalendarDate } from '@montra/domain';
import type {
  BillContractorTimeRequest,
  BillContractorTimeResponse,
  ContractorTimeDto,
  ContractorTimesheetDto,
  CreateContractorTimeRequest,
  UpdateContractorTimeRequest,
} from '@montra/schemas';
import { AppError, notFound, unprocessable } from '../common/errors.js';
import { Db } from '../db/database.js';
import { conflict, payrollEntity, type Ctx } from './shared.js';
import { payrollAccount } from './payroll-accounts.js';

const dateOf = (v: unknown): CalendarDate => calendarDate(String(v).slice(0, 10));
const billed = () =>
  new AppError(409, 'payroll.time_billed', 'These hours are on a bill; void the bill to change them');

@Injectable()
export class ContractorTimeService {
  constructor(@Inject(Db) private readonly db: Db) {}

  async timesheet(ctx: Ctx, personId: string): Promise<ContractorTimesheetDto> {
    return this.db.run(ctx, async (trx) => this.sheet(trx, ctx, await this.contractor(trx, ctx, personId)));
  }

  async add(ctx: Ctx, personId: string, req: CreateContractorTimeRequest): Promise<ContractorTimesheetDto> {
    return this.db.run(ctx, async (trx) => {
      const p = await this.contractor(trx, ctx, personId);
      if (req.customerPartyId) await this.customer(trx, ctx, p.entity_id, req.customerPartyId);
      await trx
        .insertInto('app.contractor_time')
        .values({
          workspace_id: ctx.workspaceId,
          id: newId(),
          entity_id: p.entity_id,
          person_id: p.id,
          work_date: req.workDate,
          hours_milli: BigInt(req.hoursMilli),
          note: req.note || null,
          customer_party_id: req.customerPartyId ?? null,
          created_by: ctx.userId,
        })
        .execute();
      return this.sheet(trx, ctx, p);
    });
  }

  async update(ctx: Ctx, id: string, req: UpdateContractorTimeRequest): Promise<ContractorTimesheetDto> {
    return this.db.run(ctx, async (trx) => {
      const t = await this.entry(trx, ctx, id);
      const p = await this.contractor(trx, ctx, t.person_id);
      if (await this.isBilled(trx, ctx, t)) throw billed();
      if (req.customerPartyId) await this.customer(trx, ctx, p.entity_id, req.customerPartyId);
      const row = await trx
        .updateTable('app.contractor_time')
        .set({
          ...(req.workDate !== undefined ? { work_date: req.workDate } : {}),
          ...(req.hoursMilli !== undefined ? { hours_milli: BigInt(req.hoursMilli) } : {}),
          ...(req.note !== undefined ? { note: req.note || null } : {}),
          ...(req.customerPartyId !== undefined ? { customer_party_id: req.customerPartyId } : {}),
        })
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', id)
        .where('version', '=', BigInt(req.version))
        .returning('id')
        .executeTakeFirst();
      if (!row) throw conflict();
      return this.sheet(trx, ctx, p);
    });
  }

  async remove(ctx: Ctx, id: string): Promise<ContractorTimesheetDto> {
    return this.db.run(ctx, async (trx) => {
      const t = await this.entry(trx, ctx, id);
      const p = await this.contractor(trx, ctx, t.person_id);
      if (await this.isBilled(trx, ctx, t)) throw billed();
      await trx
        .deleteFrom('app.contractor_time')
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', id)
        .execute();
      return this.sheet(trx, ctx, p);
    });
  }

  /** "Bill these hours": one bill to the contractor's vendor record, the hours marked billed at today's rate. */
  async bill(
    ctx: Ctx,
    personId: string,
    req: BillContractorTimeRequest,
  ): Promise<BillContractorTimeResponse> {
    return this.db.run(ctx, async (trx) => {
      const p = await this.contractor(trx, ctx, personId);
      const e = await payrollEntity(trx, ctx, p.entity_id);
      if (!p.vendor_party_id) {
        throw unprocessable('payroll.no_vendor', 'This contractor has no vendor record to bill');
      }
      const rate = this.rate(p);
      if (rate === null || rate === 0n) {
        throw unprocessable('payroll.no_rate', "Set the contractor's hourly rate before billing hours");
      }
      const ids = [...new Set(req.entryIds)];
      const rows = await trx
        .selectFrom('app.contractor_time')
        .selectAll()
        .where('workspace_id', '=', ctx.workspaceId)
        .where('person_id', '=', p.id)
        .where('id', 'in', ids)
        .orderBy('work_date')
        .execute();
      if (rows.length !== ids.length) throw notFound('Time entry');
      for (const t of rows) if (await this.isBilled(trx, ctx, t)) throw billed();
      const hours = rows.reduce((s, t) => s + BigInt(t.hours_milli), 0n);
      const amount = hoursPay(hours, rate);
      if (amount <= 0n) throw unprocessable('payroll.bill_empty', 'These hours come to nothing');
      const expenseAccountId = req.expenseAccountId
        ? await this.expenseAccount(trx, ctx, p.entity_id, req.expenseAccountId)
        : await this.contractLabor(trx, ctx, p.entity_id, e.currency);
      const dueDate = req.dueDate ?? req.billDate;
      if (dueDate < req.billDate)
        throw unprocessable('payroll.bill_due', 'The due date is before the bill date');
      const first = dateOf(rows[0]!.work_date);
      const last = dateOf(rows.at(-1)!.work_date);
      const billId = newId();
      await trx
        .insertInto('app.bill')
        .values({
          workspace_id: ctx.workspaceId,
          id: billId,
          entity_id: p.entity_id,
          party_id: p.vendor_party_id,
          reference: req.reference || 'Hours',
          bill_date: req.billDate,
          due_date: dueDate,
          currency: e.currency,
          amount_minor: amount,
          expense_account_id: expenseAccountId,
          notes: `${formatHours(hours)} hours, ${first === last ? first : `${first} to ${last}`}`,
          created_by: ctx.userId,
        })
        .execute();
      await trx
        .updateTable('app.contractor_time')
        .set({ bill_id: billId, rate_minor: rate })
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', 'in', ids)
        .execute();
      return {
        billId,
        amount: String(amount),
        hoursMilli: String(hours),
        timesheet: await this.sheet(trx, ctx, p),
      };
    });
  }

  // ----- Internals ------------------------------------------------------------------------------------------------

  private async contractor(trx: Trx, ctx: Ctx, personId: string): Promise<PayrollPersonRow> {
    const p = await trx
      .selectFrom('app.payroll_person')
      .selectAll()
      .where('workspace_id', '=', ctx.workspaceId)
      .where('id', '=', personId)
      .executeTakeFirst();
    if (!p) throw notFound('Person');
    await payrollEntity(trx, ctx, p.entity_id);
    if (p.kind !== 'contractor') {
      throw unprocessable(
        'payroll.time_contractor',
        'Timesheets are for contractors; employees are paid on pay runs',
      );
    }
    return p;
  }

  private async entry(trx: Trx, ctx: Ctx, id: string): Promise<ContractorTimeRow> {
    const t = await trx
      .selectFrom('app.contractor_time')
      .selectAll()
      .where('workspace_id', '=', ctx.workspaceId)
      .where('id', '=', id)
      .executeTakeFirst();
    if (!t) throw notFound('Time entry');
    return t;
  }

  /** On a bill that stands: a voided bill frees its hours. */
  private async isBilled(trx: Trx, ctx: Ctx, t: ContractorTimeRow): Promise<boolean> {
    if (!t.bill_id) return false;
    const b = await trx
      .selectFrom('app.bill')
      .select('status')
      .where('workspace_id', '=', ctx.workspaceId)
      .where('id', '=', t.bill_id)
      .executeTakeFirst();
    return !!b && b.status !== 'void';
  }

  private rate(p: PayrollPersonRow): bigint | null {
    return p.pay_type === 'hourly' && p.rate_minor !== null ? BigInt(p.rate_minor) : null;
  }

  private async customer(trx: Trx, ctx: Ctx, entityId: string, partyId: string): Promise<void> {
    const c = await trx
      .selectFrom('app.business_party')
      .select(['entity_id', 'kind'])
      .where('workspace_id', '=', ctx.workspaceId)
      .where('id', '=', partyId)
      .executeTakeFirst();
    if (!c || c.entity_id !== entityId || c.kind !== 'customer') {
      throw unprocessable('payroll.time_customer', 'Choose a customer of this business');
    }
  }

  private async expenseAccount(trx: Trx, ctx: Ctx, entityId: string, accountId: string): Promise<string> {
    const a = await trx
      .selectFrom('app.ledger_account')
      .select(['entity_id', 'type'])
      .where('workspace_id', '=', ctx.workspaceId)
      .where('id', '=', accountId)
      .executeTakeFirst();
    if (!a || a.entity_id !== entityId || a.type !== 'expense') {
      throw unprocessable('payroll.bill_category', 'Choose an expense category of this business');
    }
    return accountId;
  }

  /** The business's Contract labor category (Schedule C line 11), made if it has none. */
  private async contractLabor(trx: Trx, ctx: Ctx, entityId: string, currency: string): Promise<string> {
    const existing = await trx
      .selectFrom('app.ledger_account')
      .select('id')
      .where('workspace_id', '=', ctx.workspaceId)
      .where('entity_id', '=', entityId)
      .where('type', '=', 'expense')
      .where('tax_line_code', '=', 'US_SCH_C_L11')
      .where('archived_at', 'is', null)
      .orderBy('created_at')
      .executeTakeFirst();
    return existing?.id ?? payrollAccount(trx, ctx, entityId, currency, 'contract_labor');
  }

  private async sheet(trx: Trx, ctx: Ctx, p: PayrollPersonRow): Promise<ContractorTimesheetDto> {
    const rows = await trx
      .selectFrom('app.contractor_time as t')
      .leftJoin('app.business_party as c', (j) =>
        j.onRef('c.workspace_id', '=', 't.workspace_id').onRef('c.id', '=', 't.customer_party_id'),
      )
      .leftJoin('app.bill as b', (j) =>
        j.onRef('b.workspace_id', '=', 't.workspace_id').onRef('b.id', '=', 't.bill_id'),
      )
      .selectAll('t')
      .select(['c.name as customer_name', 'b.status as bill_status', 'b.due_date as bill_due'])
      .where('t.workspace_id', '=', ctx.workspaceId)
      .where('t.person_id', '=', p.id)
      .orderBy('t.work_date', 'desc')
      .orderBy('t.created_at', 'desc')
      .limit(1000)
      .execute();
    const rate = this.rate(p);
    const e = await payrollEntity(trx, ctx, p.entity_id);
    const today = todayIn(e.timeZone);
    let unbilledHours = 0n;
    const entries = rows.map((t): ContractorTimeDto => {
      const standing = t.bill_id !== null && t.bill_status !== null && t.bill_status !== 'void';
      const r = standing && t.rate_minor !== null ? BigInt(t.rate_minor) : rate;
      if (!standing) unbilledHours += BigInt(t.hours_milli);
      return {
        id: t.id,
        personId: t.person_id,
        workDate: dateOf(t.work_date),
        hoursMilli: String(t.hours_milli),
        note: t.note,
        customerPartyId: t.customer_party_id,
        customerName: t.customer_name ?? null,
        billId: standing ? t.bill_id : null,
        billStatus: standing
          ? t.bill_status === 'open' && t.bill_due && dateOf(t.bill_due) < today
            ? 'overdue'
            : (t.bill_status as 'open' | 'paid')
          : null,
        rate: r !== null ? String(r) : null,
        amount: r !== null ? String(hoursPay(BigInt(t.hours_milli), r)) : null,
        version: Number(t.version),
      };
    });
    return {
      personId: p.id,
      rate: rate !== null ? String(rate) : null,
      vendorPartyId: p.vendor_party_id,
      entries,
      unbilledHoursMilli: String(unbilledHours),
      unbilledAmount: rate !== null ? String(hoursPay(unbilledHours, rate)) : null,
    };
  }
}

/** "12.5" from 12500 thousandths. */
function formatHours(milli: bigint): string {
  const whole = milli / 1000n;
  const frac = milli % 1000n;
  return frac === 0n ? String(whole) : `${whole}.${String(frac).padStart(3, '0').replace(/0+$/, '')}`;
}
