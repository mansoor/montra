/**
 * Vacation and sick leave (PRL-23..26; ADR-0036). Policies per business, balances as a ledger of hours, and each
 * paycheck's plan: shown on a draft, written when its run is approved, removed when it's reopened. Accrued leave is never
 * posted to the books.
 */
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { newId, type LeaveEntryRow, type LeavePolicyRow, type Trx } from '@montra/db';
import {
  caSickDefaultPolicy,
  caSickLeaveRule,
  calendarDate,
  planLeave,
  sickPolicyShortfalls,
  sickUsableFrom,
  todayIn,
  type CalendarDate,
  type CaSickLeaveRule,
  type LeaveKind,
  type LeavePlan,
  type LeavePolicy,
} from '@montra/domain';
import type {
  CreateLeaveEntryRequest,
  LeaveBalanceDto,
  LeaveBalancesRowDto,
  LeaveEntryDto,
  LeavePolicyDto,
  LeavePolicyInput,
  LeaveSettingsDto,
  PaycheckLeaveDto,
  PersonLeaveDto,
  UpdateLeaveSettingsRequest,
} from '@montra/schemas';
import { AppError, notFound, unprocessable } from '../common/errors.js';
import { Db } from '../db/database.js';
import { businessEntity } from '../business/shared.js';
import { payrollEntity, personName, type Ctx } from './shared.js';

export const CA_SICK_SOURCE =
  'California Labor Commissioner, "California Paid Sick Leave: Frequently Asked Questions" (https://www.dir.ca.gov/dlse/paid_sick_leave.htm, updated 2025-12-31); Labor Code §§245–249';

const KINDS: readonly LeaveKind[] = ['vacation', 'sick'];
const dateOf = (v: unknown): CalendarDate => calendarDate(String(v).slice(0, 10));
const big = (v: bigint | string | number | null | undefined) =>
  v === null || v === undefined ? null : BigInt(v);
const str = (v: bigint | null) => (v === null ? null : String(v));

export const NO_POLICY: LeavePolicy = {
  method: 'none',
  accrueMilli: null,
  perHoursMilli: null,
  grantMilli: null,
  maxBalanceMilli: null,
  carryoverMaxMilli: null,
  useCapMilli: null,
};

const toPolicy = (r: LeavePolicyRow): LeavePolicy => ({
  method: r.method,
  accrueMilli: big(r.accrue_milli),
  perHoursMilli: big(r.per_hours_milli),
  grantMilli: big(r.grant_milli),
  maxBalanceMilli: big(r.max_balance_milli),
  carryoverMaxMilli: big(r.carryover_max_milli),
  useCapMilli: big(r.use_cap_milli),
});

const fromInput = (p: LeavePolicyInput): LeavePolicy => ({
  method: p.method,
  accrueMilli: p.method === 'accrual' ? big(p.accrueMilli) : null,
  perHoursMilli: p.method === 'accrual' ? big(p.perHoursMilli) : null,
  grantMilli: p.method === 'grant' ? big(p.grantMilli) : null,
  maxBalanceMilli: big(p.maxBalanceMilli),
  carryoverMaxMilli: big(p.carryoverMaxMilli),
  useCapMilli: big(p.useCapMilli),
});

/** Who a paycheck's leave is planned for. */
export interface LeavePerson {
  id: string;
  entityId: string;
  workState: string | null;
  hireDate: CalendarDate | null;
}

export interface PaycheckLeaveInput {
  paycheckId: string;
  payDate: CalendarDate;
  periodStart: CalendarDate;
  workedMilli: bigint;
  vacationMilli: bigint;
  sickMilli: bigint;
  payoutMilli: bigint;
}

export type LeavePlans = Partial<Record<LeaveKind, LeavePlan>>;

@Injectable()
export class LeaveService {
  constructor(@Inject(Db) private readonly db: Db) {}

  // ----- Policies (PRL-23, PRL-24) --------------------------------------------------------------------------------

  async settings(ctx: Ctx, entityId: string): Promise<LeaveSettingsDto> {
    return this.db.run(ctx, async (trx) => {
      const e = await businessEntity(trx, ctx, entityId);
      return this.settingsDto(trx, ctx, entityId, todayIn(e.timeZone));
    });
  }

  async updateSettings(
    ctx: Ctx,
    entityId: string,
    req: UpdateLeaveSettingsRequest,
  ): Promise<LeaveSettingsDto> {
    return this.db.run(ctx, async (trx) => {
      const e = await payrollEntity(trx, ctx, entityId);
      const today = todayIn(e.timeZone);
      if (req.sick) {
        const policy = fromInput(req.sick);
        const short = sickPolicyShortfalls(policy, caSickLeaveRule(today));
        if (short.length) {
          throw new AppError(
            422,
            'payroll.sick_below_minimum',
            `This sick leave policy gives less than California's minimum (${short.join(', ')})`,
          );
        }
      }
      for (const kind of KINDS) {
        const input = req[kind];
        if (!input) continue;
        const p = fromInput(input);
        const values = {
          method: p.method,
          accrue_milli: p.accrueMilli,
          per_hours_milli: p.perHoursMilli,
          grant_milli: p.grantMilli,
          max_balance_milli: p.maxBalanceMilli,
          carryover_max_milli: p.carryoverMaxMilli,
          use_cap_milli: p.useCapMilli,
        };
        await trx
          .insertInto('app.leave_policy')
          .values({ workspace_id: ctx.workspaceId, entity_id: entityId, kind, ...values })
          .onConflict((oc) => oc.columns(['workspace_id', 'entity_id', 'kind']).doUpdateSet(values))
          .execute();
      }
      if (req.workweekStarts !== undefined) {
        await trx
          .insertInto('app.payroll_settings')
          .values({ workspace_id: ctx.workspaceId, entity_id: entityId, workweek_starts: req.workweekStarts })
          .onConflict((oc) =>
            oc.columns(['workspace_id', 'entity_id']).doUpdateSet({ workweek_starts: req.workweekStarts! }),
          )
          .execute();
      }
      return this.settingsDto(trx, ctx, entityId, today);
    });
  }

  /** The day workweeks start (ISO weekday), Sunday when nothing was chosen. */
  async workweekStarts(trx: Trx, ctx: Ctx, entityId: string): Promise<number> {
    const r = await trx
      .selectFrom('app.payroll_settings')
      .select('workweek_starts')
      .where('workspace_id', '=', ctx.workspaceId)
      .where('entity_id', '=', entityId)
      .executeTakeFirst();
    return r?.workweek_starts ?? 6;
  }

  // ----- Balances (PRL-25) ----------------------------------------------------------------------------------------

  /** Current employees' balances today. */
  async balances(ctx: Ctx, entityId: string): Promise<LeaveBalancesRowDto[]> {
    return this.db.run(ctx, async (trx) => {
      const e = await payrollEntity(trx, ctx, entityId);
      const today = todayIn(e.timeZone);
      const people = await trx
        .selectFrom('app.payroll_person')
        .selectAll()
        .where('workspace_id', '=', ctx.workspaceId)
        .where('entity_id', '=', entityId)
        .where('kind', '=', 'employee')
        .where((w) => w.or([w('end_date', 'is', null), w('end_date', '>=', today)]))
        .orderBy('last_name')
        .orderBy('first_name')
        .execute();
      const policies = await this.policies(trx, ctx, entityId);
      const entries = await this.entries(
        trx,
        ctx,
        people.map((p) => p.id),
      );
      return people.map((p) => ({
        personId: p.id,
        personName: personName(p),
        balances: this.balanceDtos(
          policies,
          { id: p.id, entityId, workState: p.work_state, hireDate: p.hire_date ? dateOf(p.hire_date) : null },
          entries.filter((x) => x.person_id === p.id),
          today,
        ),
      }));
    });
  }

  async personLeave(ctx: Ctx, personId: string): Promise<PersonLeaveDto> {
    return this.db.run(ctx, async (trx) => this.personLeaveIn(trx, ctx, personId));
  }

  /** PRL-25: an opening balance (one per kind) or an adjustment. */
  async addEntry(ctx: Ctx, personId: string, req: CreateLeaveEntryRequest): Promise<PersonLeaveDto> {
    return this.db.run(ctx, async (trx) => {
      const p = await this.employee(trx, ctx, personId);
      if (req.source === 'opening') {
        const existing = await trx
          .selectFrom('app.leave_entry')
          .select('id')
          .where('workspace_id', '=', ctx.workspaceId)
          .where('person_id', '=', personId)
          .where('kind', '=', req.kind)
          .where('source', '=', 'opening')
          .executeTakeFirst();
        if (existing) {
          throw new AppError(
            409,
            'payroll.leave_opening_exists',
            'There is already an opening balance; adjust it instead',
          );
        }
      }
      await trx
        .insertInto('app.leave_entry')
        .values({
          workspace_id: ctx.workspaceId,
          id: newId(),
          entity_id: p.entity_id,
          person_id: personId,
          kind: req.kind,
          entry_date: req.date,
          source: req.source,
          hours_milli: BigInt(req.hoursMilli),
          note: req.note || null,
          created_by: ctx.userId,
        })
        .execute();
      return this.personLeaveIn(trx, ctx, personId);
    });
  }

  async removeEntry(ctx: Ctx, personId: string, entryId: string): Promise<PersonLeaveDto> {
    return this.db.run(ctx, async (trx) => {
      await this.employee(trx, ctx, personId);
      const removed = await trx
        .deleteFrom('app.leave_entry')
        .where('workspace_id', '=', ctx.workspaceId)
        .where('person_id', '=', personId)
        .where('id', '=', entryId)
        .where('source', 'in', ['opening', 'adjustment'])
        .returning('id')
        .executeTakeFirst();
      if (!removed) throw notFound('Leave entry');
      return this.personLeaveIn(trx, ctx, personId);
    });
  }

  // ----- Paychecks (PRL-26) ---------------------------------------------------------------------------------------

  /** The policies that apply to a person on a date; a kind left out isn't tracked for them. */
  async policiesFor(
    trx: Trx,
    ctx: Ctx,
    person: LeavePerson,
    date: CalendarDate,
  ): Promise<Partial<Record<LeaveKind, LeavePolicy>>> {
    return this.applicable(await this.policies(trx, ctx, person.entityId), person, date);
  }

  /** What approving would do to each tracked balance; nothing is written. */
  async plan(trx: Trx, ctx: Ctx, person: LeavePerson, input: PaycheckLeaveInput): Promise<LeavePlans> {
    const policies = await this.policiesFor(trx, ctx, person, input.payDate);
    const year = Number(input.payDate.slice(0, 4));
    const yearStart = `${year}-01-01`;
    const rule = caSickLeaveRule(input.payDate);
    const { rows } = await sql<{
      kind: LeaveKind;
      balance: string;
      at_year_start: string;
      used_this_year: string;
      grant_done: boolean;
      carryover_done: boolean;
      n: string;
    }>`
      select kind,
             coalesce(sum(hours_milli) filter (where entry_date <= ${input.payDate}::date), 0) as balance,
             coalesce(sum(hours_milli) filter (where entry_date < ${yearStart}::date), 0) as at_year_start,
             coalesce(-sum(hours_milli) filter (where source = 'used' and entry_date >= ${yearStart}::date
                                                  and entry_date <= ${input.payDate}::date), 0) as used_this_year,
             bool_or(source = 'grant' and leave_year = ${year}) as grant_done,
             bool_or(source = 'carryover' and leave_year = ${year}) as carryover_done,
             count(*) as n
        from app.leave_entry
       where workspace_id = ${ctx.workspaceId} and person_id = ${person.id}
         and paycheck_id is distinct from ${input.paycheckId}::uuid
       group by kind`.execute(trx);
    const out: LeavePlans = {};
    for (const kind of KINDS) {
      const r = rows.find((x) => x.kind === kind);
      const policy = policies[kind] ?? (r && Number(r.n) > 0 ? NO_POLICY : null);
      const used = kind === 'vacation' ? input.vacationMilli : input.sickMilli;
      // Leave can't be taken from a balance nobody tracks: a policy of none still counts what's used.
      if (!policy && used === 0n && (kind === 'sick' || input.payoutMilli === 0n)) continue;
      const ca = person.workState === 'CA';
      out[kind] = planLeave(
        policy ?? NO_POLICY,
        {
          balance: BigInt(r?.balance ?? 0),
          balanceAtYearStart: BigInt(r?.at_year_start ?? 0),
          usedThisYear: BigInt(r?.used_this_year ?? 0),
          grantDone: r?.grant_done ?? false,
          carryoverDone: r?.carryover_done ?? false,
        },
        {
          year,
          workedMilli: input.workedMilli,
          usedMilli: used,
          payoutMilli: kind === 'vacation' ? input.payoutMilli : 0n,
          vested: kind === 'vacation' && ca,
          usableFrom: kind === 'sick' && ca ? sickUsableFrom(person.hireDate, rule) : null,
          periodStart: input.periodStart,
        },
      );
    }
    return out;
  }

  /** Writes a paycheck's plan when its run is approved. Year-start entries are dated 1 January. */
  async write(trx: Trx, ctx: Ctx, person: LeavePerson, input: PaycheckLeaveInput, plans: LeavePlans) {
    for (const kind of KINDS) {
      const plan = plans[kind];
      if (!plan) continue;
      for (const e of plan.entries) {
        await trx
          .insertInto('app.leave_entry')
          .values({
            workspace_id: ctx.workspaceId,
            id: newId(),
            entity_id: person.entityId,
            person_id: person.id,
            kind,
            entry_date: e.leaveYear !== null ? `${e.leaveYear}-01-01` : input.payDate,
            source: e.source,
            hours_milli: e.hoursMilli,
            leave_year: e.leaveYear,
            paycheck_id: input.paycheckId,
            created_by: ctx.userId,
          })
          .execute();
      }
    }
  }

  /** Reopening a run takes its paychecks' leave back out. */
  async reverse(trx: Trx, ctx: Ctx, paycheckIds: string[]): Promise<void> {
    if (!paycheckIds.length) return;
    await trx
      .deleteFrom('app.leave_entry')
      .where('workspace_id', '=', ctx.workspaceId)
      .where('paycheck_id', 'in', paycheckIds)
      .execute();
  }

  /** An approved paycheck's leave as written, against the balance before it. */
  async written(trx: Trx, ctx: Ctx, personId: string, paycheckId: string, payDate: CalendarDate) {
    const { rows } = await sql<{
      kind: LeaveKind;
      before: string;
      used: string;
      accrued: string;
      paid_out: string;
      mine: string;
    }>`
      select kind,
             coalesce(sum(hours_milli) filter (where paycheck_id is distinct from ${paycheckId}::uuid
                                                 and entry_date <= ${payDate}::date), 0) as before,
             coalesce(-sum(hours_milli) filter (where paycheck_id = ${paycheckId}::uuid and source = 'used'), 0) as used,
             coalesce(sum(hours_milli) filter (where paycheck_id = ${paycheckId}::uuid
                                                 and source in ('accrual', 'grant', 'carryover')), 0) as accrued,
             coalesce(-sum(hours_milli) filter (where paycheck_id = ${paycheckId}::uuid and source = 'payout'), 0) as paid_out,
             count(*) filter (where paycheck_id = ${paycheckId}::uuid) as mine
        from app.leave_entry
       where workspace_id = ${ctx.workspaceId} and person_id = ${personId}
       group by kind`.execute(trx);
    return rows.map((r): PaycheckLeaveDto => ({
      kind: r.kind,
      beforeMilli: String(r.before),
      usedMilli: String(r.used),
      accruedMilli: String(r.accrued),
      paidOutMilli: String(r.paid_out),
      afterMilli: String(BigInt(r.before) - BigInt(r.used) + BigInt(r.accrued) - BigInt(r.paid_out)),
      warnings: [],
    }));
  }

  // ----- Internals ------------------------------------------------------------------------------------------------

  private async policies(trx: Trx, ctx: Ctx, entityId: string) {
    const rows = await trx
      .selectFrom('app.leave_policy')
      .selectAll()
      .where('workspace_id', '=', ctx.workspaceId)
      .where('entity_id', '=', entityId)
      .execute();
    return { vacation: rows.find((r) => r.kind === 'vacation'), sick: rows.find((r) => r.kind === 'sick') };
  }

  /**
   * Vacation follows the business's policy. Sick leave follows the business's policy for everyone, and with none saved,
   * California's minimum for California employees (ADR-0036 §2).
   */
  private applicable(
    p: { vacation?: LeavePolicyRow; sick?: LeavePolicyRow },
    person: LeavePerson,
    date: CalendarDate,
  ): Partial<Record<LeaveKind, LeavePolicy>> {
    const out: Partial<Record<LeaveKind, LeavePolicy>> = {};
    if (p.vacation && p.vacation.method !== 'none') out.vacation = toPolicy(p.vacation);
    if (p.sick) out.sick = toPolicy(p.sick);
    else if (person.workState === 'CA') out.sick = caSickDefaultPolicy(caSickLeaveRule(date));
    return out;
  }

  private async entries(trx: Trx, ctx: Ctx, personIds: string[]): Promise<LeaveEntryRow[]> {
    if (!personIds.length) return [];
    return trx
      .selectFrom('app.leave_entry')
      .selectAll()
      .where('workspace_id', '=', ctx.workspaceId)
      .where('person_id', 'in', personIds)
      .orderBy('entry_date', 'desc')
      .orderBy('created_at', 'desc')
      .execute();
  }

  private balanceDtos(
    policies: { vacation?: LeavePolicyRow; sick?: LeavePolicyRow },
    person: LeavePerson,
    entries: LeaveEntryRow[],
    today: CalendarDate,
  ): LeaveBalanceDto[] {
    const applicable = this.applicable(policies, person, today);
    const yearStart = `${today.slice(0, 4)}-01-01`;
    return KINDS.map((kind) => {
      const mine = entries.filter((e) => e.kind === kind);
      const thisYear = mine.filter((e) => dateOf(e.entry_date) >= yearStart && dateOf(e.entry_date) <= today);
      const sum = (list: LeaveEntryRow[]) => list.reduce((t, e) => t + BigInt(e.hours_milli), 0n);
      return {
        kind,
        tracked: !!applicable[kind] || mine.length > 0,
        method: applicable[kind]?.method ?? 'none',
        balanceMilli: String(sum(mine.filter((e) => dateOf(e.entry_date) <= today))),
        usedThisYearMilli: String(-sum(thisYear.filter((e) => e.source === 'used'))),
        accruedThisYearMilli: String(
          sum(thisYear.filter((e) => ['accrual', 'grant', 'carryover'].includes(e.source))),
        ),
      };
    });
  }

  private async personLeaveIn(trx: Trx, ctx: Ctx, personId: string): Promise<PersonLeaveDto> {
    const p = await this.employee(trx, ctx, personId);
    const e = await businessEntity(trx, ctx, p.entity_id);
    const entries = await this.entries(trx, ctx, [personId]);
    const paychecks = entries.filter((x) => x.paycheck_id).map((x) => x.paycheck_id!);
    const runs = paychecks.length
      ? await trx
          .selectFrom('app.paycheck')
          .select(['id', 'pay_run_id'])
          .where('workspace_id', '=', ctx.workspaceId)
          .where('id', 'in', paychecks)
          .execute()
      : [];
    const person: LeavePerson = {
      id: p.id,
      entityId: p.entity_id,
      workState: p.work_state,
      hireDate: p.hire_date ? dateOf(p.hire_date) : null,
    };
    return {
      personId,
      balances: this.balanceDtos(
        await this.policies(trx, ctx, p.entity_id),
        person,
        entries,
        todayIn(e.timeZone),
      ),
      entries: entries.map((x): LeaveEntryDto => ({
        id: x.id,
        kind: x.kind,
        date: dateOf(x.entry_date),
        source: x.source,
        hoursMilli: String(x.hours_milli),
        payRunId: runs.find((r) => r.id === x.paycheck_id)?.pay_run_id ?? null,
        note: x.note,
        canDelete: x.source === 'opening' || x.source === 'adjustment',
      })),
    };
  }

  private async employee(trx: Trx, ctx: Ctx, personId: string) {
    const p = await trx
      .selectFrom('app.payroll_person')
      .selectAll()
      .where('workspace_id', '=', ctx.workspaceId)
      .where('id', '=', personId)
      .executeTakeFirst();
    if (!p) throw notFound('Person');
    await payrollEntity(trx, ctx, p.entity_id);
    if (p.kind !== 'employee')
      throw unprocessable('payroll.leave_employee', 'Only employees have leave balances');
    return p;
  }

  private async settingsDto(
    trx: Trx,
    ctx: Ctx,
    entityId: string,
    today: CalendarDate,
  ): Promise<LeaveSettingsDto> {
    const p = await this.policies(trx, ctx, entityId);
    const rule = caSickLeaveRule(today);
    const policyDto = (kind: LeaveKind, row: LeavePolicyRow | undefined): LeavePolicyDto => {
      const policy = row ? toPolicy(row) : kind === 'sick' ? caSickDefaultPolicy(rule) : NO_POLICY;
      return {
        kind,
        method: policy.method,
        accrueMilli: str(policy.accrueMilli),
        perHoursMilli: str(policy.perHoursMilli),
        grantMilli: str(policy.grantMilli),
        maxBalanceMilli: str(policy.maxBalanceMilli),
        carryoverMaxMilli: str(policy.carryoverMaxMilli),
        useCapMilli: str(policy.useCapMilli),
        isDefault: !row,
        shortfalls: kind === 'sick' ? sickPolicyShortfalls(policy, rule) : [],
      };
    };
    return {
      entityId,
      vacation: policyDto('vacation', p.vacation),
      sick: policyDto('sick', p.sick),
      workweekStarts: await this.workweekStarts(trx, ctx, entityId),
      caSickRule: ruleDto(rule),
    };
  }
}

const ruleDto = (r: CaSickLeaveRule) => ({
  from: r.from,
  minHoursMilli: String(r.minHoursMilli),
  minDays: r.minDays,
  accrueMilli: String(r.accrueMilli),
  perHoursMilli: String(r.perHoursMilli),
  accrualCapHoursMilli: String(r.accrualCapHoursMilli),
  accrualCapDays: r.accrualCapDays,
  useCapHoursMilli: String(r.useCapHoursMilli),
  useCapDays: r.useCapDays,
  usableFromDay: r.usableFromDay,
  source: CA_SICK_SOURCE,
});
