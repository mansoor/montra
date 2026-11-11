/**
 * Pay schedules and pay runs (PRL-06..09; ADR-0034 §6–7). A run is a draft of one paycheck per employee on the schedule:
 * regular pay is worked out from hours or salary, approved reimbursements are added untaxed, and the tax engine fills in
 * the taxes (the built-in federal and California engine; a tax typed in overrides its line). Approving posts each paycheck as its own transaction; reopening
 * takes them back out while nothing is reconciled or closed.
 */
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import {
  newId,
  type PaycheckLineRow,
  type PaycheckRow,
  type PayRunRow,
  type PayScheduleRow,
  type Trx,
} from '@montra/db';
import {
  addDays,
  asCurrencyCode,
  calendarDate,
  hoursPay,
  nextPayPeriod,
  overtimeRate,
  paycheckTotals,
  payPeriodContaining,
  PERIODS_PER_YEAR,
  PRE_TAX_CODES,
  salaryPerPeriod,
  todayIn,
  type CalendarDate,
  type JournalEntryDraft,
  type PaycheckTotals,
  type PostingDraft,
  type PreTaxCode,
  type WageParts,
} from '@montra/domain';
import type {
  ApprovePayRunRequest,
  CreatePayRunRequest,
  CreatePayScheduleRequest,
  PaycheckDto,
  PayRunDto,
  PayScheduleDto,
  UpdatePaycheckRequest,
  UpdatePayRunRequest,
  UpdatePayScheduleRequest,
} from '@montra/schemas';
import { AppError, notFound, unprocessable } from '../common/errors.js';
import { Db } from '../db/database.js';
import { TransactionPoster, type TransactionSpec } from '../transactions/poster.js';
import { businessEntity, type BusinessEntity } from '../business/shared.js';
import { formatScaled } from '../business/shared.js';
import { usd, usDate } from './form-pdf.js';
import { liabilityFor, payrollAccount } from './payroll-accounts.js';
import { renderPayslipPdf } from './payslip-pdf.js';
import { conflict, formatAddress, payrollEntity, personName, type Ctx } from './shared.js';
import {
  EMPLOYEE_TAX_CODES,
  EMPLOYER_TAX_CODES,
  PAYROLL_TAX_ENGINE,
  TAX_LABELS,
  type PayrollTaxEngine,
} from './tax-engine.js';

const dateOf = (v: unknown): CalendarDate => calendarDate(String(v).slice(0, 10));
const ZERO: PaycheckTotals = {
  gross: 0n,
  preTax: 0n,
  employeeTaxes: 0n,
  postTax: 0n,
  reimbursements: 0n,
  net: 0n,
  employerTaxes: 0n,
};
const totalsDto = (t: PaycheckTotals) => ({
  gross: String(t.gross),
  preTax: String(t.preTax),
  employeeTaxes: String(t.employeeTaxes),
  postTax: String(t.postTax),
  reimbursements: String(t.reimbursements),
  net: String(t.net),
  employerTaxes: String(t.employerTaxes),
});
const add = (a: PaycheckTotals, b: PaycheckTotals): PaycheckTotals => ({
  gross: a.gross + b.gross,
  preTax: a.preTax + b.preTax,
  employeeTaxes: a.employeeTaxes + b.employeeTaxes,
  postTax: a.postTax + b.postTax,
  reimbursements: a.reimbursements + b.reimbursements,
  net: a.net + b.net,
  employerTaxes: a.employerTaxes + b.employerTaxes,
});
const rowTotals = (p: PaycheckRow): PaycheckTotals => ({
  gross: BigInt(p.gross_minor),
  preTax: BigInt(p.pre_tax_minor),
  employeeTaxes: BigInt(p.employee_taxes_minor),
  postTax: BigInt(p.post_tax_minor),
  reimbursements: BigInt(p.reimbursements_minor),
  net: BigInt(p.net_minor),
  employerTaxes: BigInt(p.employer_taxes_minor),
});

/** Earnings worked out from hours or salary; everything else on a paycheck is entered, a reimbursement, or a tax. */
const COMPUTED_EARNINGS = new Set(['regular', 'overtime', 'salary']);

@Injectable()
export class PayRunsService {
  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(TransactionPoster) private readonly poster: TransactionPoster,
    @Inject(PAYROLL_TAX_ENGINE) private readonly engine: PayrollTaxEngine,
  ) {}

  // ----- Schedules (PRL-06) ---------------------------------------------------------------------------------------

  async listSchedules(ctx: Ctx, entityId: string): Promise<PayScheduleDto[]> {
    return this.db.run(ctx, async (trx) => {
      const e = await businessEntity(trx, ctx, entityId);
      const rows = await trx
        .selectFrom('app.pay_schedule')
        .selectAll()
        .where('workspace_id', '=', ctx.workspaceId)
        .where('entity_id', '=', entityId)
        .orderBy('archived_at', 'desc')
        .orderBy('name')
        .execute();
      return Promise.all(rows.map((r) => this.scheduleDto(trx, ctx, r, e)));
    });
  }

  async createSchedule(ctx: Ctx, req: CreatePayScheduleRequest): Promise<PayScheduleDto> {
    return this.db.run(ctx, async (trx) => {
      const e = await payrollEntity(trx, ctx, req.entityId);
      if (req.payFromAccountId) await this.bankAccount(trx, ctx, req.entityId, req.payFromAccountId);
      const row = await trx
        .insertInto('app.pay_schedule')
        .values({
          workspace_id: ctx.workspaceId,
          id: newId(),
          entity_id: req.entityId,
          name: req.name,
          frequency: req.frequency,
          anchor_date: req.anchorDate,
          pay_lag_days: req.payLagDays,
          pay_from_account_id: req.payFromAccountId ?? null,
          created_by: ctx.userId,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      return this.scheduleDto(trx, ctx, row, e);
    });
  }

  async updateSchedule(ctx: Ctx, id: string, req: UpdatePayScheduleRequest): Promise<PayScheduleDto> {
    return this.db.run(ctx, async (trx) => {
      const s = await this.schedule(trx, ctx, id);
      const e = await payrollEntity(trx, ctx, s.entity_id);
      if (req.payFromAccountId) await this.bankAccount(trx, ctx, s.entity_id, req.payFromAccountId);
      const row = await trx
        .updateTable('app.pay_schedule')
        .set({
          ...(req.name !== undefined ? { name: req.name } : {}),
          ...(req.payLagDays !== undefined ? { pay_lag_days: req.payLagDays } : {}),
          ...(req.payFromAccountId !== undefined ? { pay_from_account_id: req.payFromAccountId } : {}),
          ...(req.archived !== undefined ? { archived_at: req.archived ? new Date() : null } : {}),
        })
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', id)
        .where('version', '=', BigInt(req.version))
        .returningAll()
        .executeTakeFirst();
      if (!row) throw conflict();
      return this.scheduleDto(trx, ctx, row, e);
    });
  }

  // ----- Runs (PRL-07) --------------------------------------------------------------------------------------------

  async list(ctx: Ctx, entityId: string): Promise<PayRunDto[]> {
    return this.db.run(ctx, async (trx) => {
      await businessEntity(trx, ctx, entityId);
      const rows = await trx
        .selectFrom('app.pay_run')
        .selectAll()
        .where('workspace_id', '=', ctx.workspaceId)
        .where('entity_id', '=', entityId)
        .orderBy('pay_date', 'desc')
        .orderBy('created_at', 'desc')
        .limit(200)
        .execute();
      return Promise.all(rows.map((r) => this.runDto(trx, ctx, r, false)));
    });
  }

  async get(ctx: Ctx, id: string): Promise<PayRunDto> {
    return this.db.run(ctx, async (trx) => this.runDto(trx, ctx, await this.run(trx, ctx, id), true));
  }

  /** The next unpaid period when no date is given; one run per schedule and period. */
  async create(ctx: Ctx, req: CreatePayRunRequest): Promise<PayRunDto> {
    return this.db.run(ctx, async (trx) => {
      const e = await payrollEntity(trx, ctx, req.entityId);
      const s = await this.schedule(trx, ctx, req.scheduleId);
      if (s.entity_id !== req.entityId) throw notFound('Pay schedule');
      if (s.archived_at) throw unprocessable('payroll.schedule_archived', 'This pay schedule is archived');
      const period = req.periodDate
        ? payPeriodContaining(s.frequency, dateOf(s.anchor_date), req.periodDate)
        : await this.nextUnpaid(trx, ctx, s, e);
      const taken = await trx
        .selectFrom('app.pay_run')
        .select('id')
        .where('workspace_id', '=', ctx.workspaceId)
        .where('schedule_id', '=', s.id)
        .where('period_start', '=', period.start)
        .executeTakeFirst();
      if (taken) {
        throw new AppError(
          409,
          'payroll.run_exists',
          `There is already a pay run for ${period.start} to ${period.end}`,
        );
      }
      const id = newId();
      await trx
        .insertInto('app.pay_run')
        .values({
          workspace_id: ctx.workspaceId,
          id,
          entity_id: s.entity_id,
          schedule_id: s.id,
          period_start: period.start,
          period_end: period.end,
          pay_date: addDays(period.end, s.pay_lag_days),
          pay_from_account_id: s.pay_from_account_id,
          engine: this.engine.name,
          created_by: ctx.userId,
        })
        .execute();
      const people = await trx
        .selectFrom('app.payroll_person')
        .selectAll()
        .where('workspace_id', '=', ctx.workspaceId)
        .where('entity_id', '=', s.entity_id)
        .where('kind', '=', 'employee')
        .where('pay_schedule_id', '=', s.id)
        .where((w) => w.or([w('hire_date', 'is', null), w('hire_date', '<=', period.end)]))
        .where((w) => w.or([w('end_date', 'is', null), w('end_date', '>=', period.start)]))
        .orderBy('last_name')
        .orderBy('first_name')
        .execute();
      for (const p of people) {
        const paycheckId = newId();
        await trx
          .insertInto('app.paycheck')
          .values({
            workspace_id: ctx.workspaceId,
            id: paycheckId,
            entity_id: s.entity_id,
            pay_run_id: id,
            person_id: p.id,
            person_name: personName(p),
          })
          .execute();
        await this.recompute(trx, ctx, paycheckId, { hours: p.default_hours_milli, overtime: null });
      }
      return this.runDto(trx, ctx, await this.run(trx, ctx, id), true);
    });
  }

  async update(ctx: Ctx, id: string, req: UpdatePayRunRequest): Promise<PayRunDto> {
    return this.db.run(ctx, async (trx) => {
      const r = await this.draft(trx, ctx, id, req.version);
      if (req.payFromAccountId) await this.bankAccount(trx, ctx, r.entity_id, req.payFromAccountId);
      if (req.payDate && req.payDate < dateOf(r.period_start)) {
        throw unprocessable('payroll.pay_date', 'Payday cannot be before the period starts');
      }
      await trx
        .updateTable('app.pay_run')
        .set({
          ...(req.payDate ? { pay_date: req.payDate } : {}),
          ...(req.payFromAccountId !== undefined ? { pay_from_account_id: req.payFromAccountId } : {}),
          ...(req.notes !== undefined ? { notes: req.notes || null } : {}),
        })
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', id)
        .execute();
      // The pay date decides the year to date and the W-4 in force.
      if (req.payDate) await this.recomputeAll(trx, ctx, id);
      return this.runDto(trx, ctx, await this.run(trx, ctx, id), true);
    });
  }

  async remove(ctx: Ctx, id: string): Promise<void> {
    await this.db.run(ctx, async (trx) => {
      const r = await this.run(trx, ctx, id);
      await payrollEntity(trx, ctx, r.entity_id);
      if (r.status !== 'draft')
        throw new AppError(409, 'payroll.run_approved', 'Reopen the pay run before deleting it');
      // Reimbursements on it go back to waiting for the next run.
      await sql`update app.reimbursement set paycheck_id = null
                 where workspace_id = ${ctx.workspaceId}
                   and paycheck_id in (select id from app.paycheck where workspace_id = ${ctx.workspaceId} and pay_run_id = ${id})`.execute(
        trx,
      );
      await trx
        .deleteFrom('app.pay_run')
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', id)
        .execute();
    });
  }

  async updatePaycheck(
    ctx: Ctx,
    runId: string,
    paycheckId: string,
    req: UpdatePaycheckRequest,
  ): Promise<PayRunDto> {
    return this.db.run(ctx, async (trx) => {
      const r = await this.run(trx, ctx, runId);
      await payrollEntity(trx, ctx, r.entity_id);
      if (r.status !== 'draft')
        throw new AppError(409, 'payroll.run_approved', 'This pay run is approved; reopen it to change it');
      const pc = await trx
        .selectFrom('app.paycheck')
        .selectAll()
        .where('workspace_id', '=', ctx.workspaceId)
        .where('pay_run_id', '=', runId)
        .where('id', '=', paycheckId)
        .executeTakeFirst();
      if (!pc) throw notFound('Paycheck');
      if (BigInt(pc.version) !== BigInt(req.version)) throw conflict();
      const lines = await this.lines(trx, ctx, [paycheckId]);
      const hoursOf = (code: string) =>
        lines.find((l) => l.code === code && l.kind === 'earning')?.hours_milli ?? null;
      const replace = async (
        kind: 'earning' | 'pre_tax_deduction' | 'employee_tax' | 'post_tax_deduction' | 'employer_tax',
        given: { code: string; label: string; amount: string }[] | undefined,
      ) => {
        if (!given) return;
        if (kind === 'earning' && given.some((g) => COMPUTED_EARNINGS.has(g.code))) {
          throw unprocessable('payroll.computed_earning', 'Regular pay comes from the hours or salary');
        }
        if (
          kind === 'pre_tax_deduction' &&
          given.some((g) => !PRE_TAX_CODES.includes(g.code as PreTaxCode))
        ) {
          throw unprocessable(
            'payroll.pre_tax_code',
            `A before-tax deduction must be one of: ${PRE_TAX_CODES.join(', ')}`,
          );
        }
        const allowed: readonly string[] | null =
          kind === 'employee_tax' ? EMPLOYEE_TAX_CODES : kind === 'employer_tax' ? EMPLOYER_TAX_CODES : null;
        if (allowed && given.some((g) => !allowed.includes(g.code))) {
          throw unprocessable('payroll.tax_code', `A tax must be one of: ${allowed.join(', ')}`);
        }
        await trx
          .deleteFrom('app.paycheck_line')
          .where('workspace_id', '=', ctx.workspaceId)
          .where('paycheck_id', '=', paycheckId)
          .where('kind', '=', kind)
          .where('source', '=', 'manual')
          .$if(kind === 'earning', (q) => q.where('code', 'not in', [...COMPUTED_EARNINGS]))
          .execute();
        let n = 100;
        for (const g of given) {
          if (BigInt(g.amount) === 0n) continue;
          await trx
            .insertInto('app.paycheck_line')
            .values({
              workspace_id: ctx.workspaceId,
              id: newId(),
              entity_id: pc.entity_id,
              paycheck_id: paycheckId,
              kind,
              code: g.code,
              label: g.label,
              amount_minor: BigInt(g.amount),
              source: 'manual',
              sort_order: n++,
            })
            .execute();
        }
      };
      await replace('earning', req.earnings);
      await replace('pre_tax_deduction', req.preTaxDeductions);
      await replace('employee_tax', req.employeeTaxes);
      await replace('post_tax_deduction', req.postTaxDeductions);
      await replace('employer_tax', req.employerTaxes);
      await this.recompute(trx, ctx, paycheckId, {
        hours: req.hoursMilli !== undefined ? req.hoursMilli : hoursOf('regular'),
        overtime: req.overtimeHoursMilli !== undefined ? req.overtimeHoursMilli : hoursOf('overtime'),
      });
      await trx
        .updateTable('app.paycheck')
        .set({ version: sql`version + 1` })
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', paycheckId)
        .execute();
      return this.runDto(trx, ctx, r, true);
    });
  }

  /** PRL-09: posts each paycheck. The person approving confirms the amounts; no money moves. */
  async approve(ctx: Ctx, id: string, req: ApprovePayRunRequest): Promise<PayRunDto> {
    return this.db.run(ctx, async (trx) => {
      const r = await this.draft(trx, ctx, id, req.version);
      const e = await payrollEntity(trx, ctx, r.entity_id);
      if (!r.pay_from_account_id) {
        throw unprocessable('payroll.pay_from_required', 'Choose the account the pay comes from');
      }
      await this.bankAccount(trx, ctx, r.entity_id, r.pay_from_account_id);
      // Recompute first: the year to date may have moved since the draft was made.
      await this.recomputeAll(trx, ctx, id);
      const paychecks = await this.paychecks(trx, ctx, id);
      const empty = paychecks.filter(
        (p) => BigInt(p.gross_minor) === 0n && BigInt(p.reimbursements_minor) === 0n,
      );
      if (empty.length) {
        await trx
          .deleteFrom('app.paycheck')
          .where('workspace_id', '=', ctx.workspaceId)
          .where(
            'id',
            'in',
            empty.map((p) => p.id),
          )
          .execute();
      }
      const live = paychecks.filter((p) => !empty.includes(p));
      if (!live.length) throw unprocessable('payroll.run_empty', 'Nobody is paid on this run');
      const negative = live.find((p) => BigInt(p.net_minor) < 0n);
      if (negative) {
        throw unprocessable(
          'payroll.negative_net',
          `Deductions and taxes are more than ${negative.person_name}'s pay`,
        );
      }
      const lines = await this.lines(
        trx,
        ctx,
        live.map((p) => p.id),
      );
      const reimbursementAccounts = await this.reimbursementAccounts(trx, ctx, lines);
      for (const p of live) {
        await this.post(
          trx,
          ctx,
          e,
          r,
          p,
          lines.filter((l) => l.paycheck_id === p.id),
          reimbursementAccounts,
        );
      }
      await trx
        .updateTable('app.pay_run')
        .set({ status: 'approved', approved_at: new Date(), approved_by: ctx.userId })
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', id)
        .execute();
      return this.runDto(trx, ctx, await this.run(trx, ctx, id), true);
    });
  }

  /** Back to a draft, taking each paycheck's transaction out, while none is reconciled or in a closed period. */
  async reopen(ctx: Ctx, id: string, version: number): Promise<PayRunDto> {
    return this.db.run(ctx, async (trx) => {
      const r = await this.run(trx, ctx, id);
      await payrollEntity(trx, ctx, r.entity_id);
      if (r.status !== 'approved')
        throw new AppError(409, 'payroll.run_draft', 'This pay run is still a draft');
      if (BigInt(r.version) !== BigInt(version)) throw conflict();
      const paychecks = await this.paychecks(trx, ctx, id);
      for (const p of paychecks) {
        if (p.transaction_id && (await this.poster.protection(trx, ctx, p.transaction_id)) !== 'none') {
          throw new AppError(
            409,
            'payroll.run_locked',
            `${p.person_name}'s pay is reconciled or in a closed period, so this pay run can't be reopened`,
          );
        }
      }
      for (const p of paychecks) {
        if (!p.transaction_id) continue;
        await trx
          .updateTable('app.paycheck')
          .set({ transaction_id: null })
          .where('workspace_id', '=', ctx.workspaceId)
          .where('id', '=', p.id)
          .execute();
        await this.poster.unpost(trx, ctx, p.transaction_id);
        await trx
          .updateTable('app.transaction')
          .set({ status: 'void', deleted_at: new Date() })
          .where('workspace_id', '=', ctx.workspaceId)
          .where('id', '=', p.transaction_id)
          .execute();
      }
      await trx
        .updateTable('app.pay_run')
        .set({ status: 'draft', approved_at: null, approved_by: null })
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', id)
        .execute();
      return this.runDto(trx, ctx, await this.run(trx, ctx, id), true);
    });
  }

  /** PRL-08: the payslip for one paycheck, with each line's year to date. */
  async payslipPdf(ctx: Ctx, paycheckId: string): Promise<{ bytes: Uint8Array; fileName: string }> {
    const { paycheck: p, run, entity, profile, person } = await this.paycheckFor(ctx, paycheckId);
    const prior = await this.db.run(ctx, (trx) =>
      trx
        .selectFrom('app.paycheck_line as l')
        .innerJoin('app.paycheck as p', (j) =>
          j.onRef('p.workspace_id', '=', 'l.workspace_id').onRef('p.id', '=', 'l.paycheck_id'),
        )
        .innerJoin('app.pay_run as r', (j) =>
          j.onRef('r.workspace_id', '=', 'p.workspace_id').onRef('r.id', '=', 'p.pay_run_id'),
        )
        .select(['l.kind', 'l.code', 'l.label', (x) => x.fn.sum<string>('l.amount_minor').as('amount')])
        .where('l.workspace_id', '=', ctx.workspaceId)
        .where('p.person_id', '=', p.personId)
        .where('r.status', '=', 'approved')
        .where('r.id', '!=', run.id)
        .where('r.pay_date', '>=', `${run.payDate.slice(0, 4)}-01-01`)
        .where('r.pay_date', '<=', run.payDate)
        .groupBy(['l.kind', 'l.code', 'l.label'])
        .execute(),
    );
    const money = (minor: bigint | string) => usd(minor);
    const hours = (milli: string | null) => (milli === null ? null : formatScaled(BigInt(milli), 3));
    const priorOf = (kind: string, code: string, label: string) =>
      prior
        .filter(
          (x) => x.kind === kind && x.code === code && (kind !== 'reimbursement' ? true : x.label === label),
        )
        .reduce((t, x) => t + BigInt(x.amount), 0n);
    const rows = (kind: PaycheckDto['lines'][number]['kind']) => {
      const current = p.lines.filter((l) => l.kind === kind);
      const seen = new Set(current.map((l) => `${l.code}|${l.label}`));
      // Lines paid earlier in the year but not this time still show their year to date.
      const earlier = prior.filter(
        (x) =>
          x.kind === kind && kind !== 'reimbursement' && ![...seen].some((k) => k.startsWith(`${x.code}|`)),
      );
      return [
        ...current.map((l) => ({
          label: l.label,
          hours: hours(l.hoursMilli),
          rate: l.rate ? money(l.rate) : null,
          current: money(l.amount),
          ytd: money(BigInt(l.amount) + priorOf(kind, l.code, l.label)),
        })),
        ...earlier.map((x) => ({
          label: x.label,
          hours: null,
          rate: null,
          current: money(0n),
          ytd: money(x.amount),
        })),
      ];
    };
    const bytes = await renderPayslipPdf({
      employer: { name: profile?.legal_name || entity.name, address: profile?.address ?? null },
      employee: {
        name: p.personName,
        address: person ? formatAddress(person) : null,
        ssnLast4: person?.tin_type !== 'ein' ? (person?.tin_last4 ?? null) : null,
      },
      periodStart: usDate(run.periodStart)!,
      periodEnd: usDate(run.periodEnd)!,
      payDate: usDate(run.payDate)!,
      sections: [
        { title: 'Earnings', rows: rows('earning') },
        { title: 'Before-tax deductions', rows: rows('pre_tax_deduction') },
        { title: 'Taxes withheld', rows: rows('employee_tax') },
        { title: 'After-tax deductions', rows: rows('post_tax_deduction') },
        { title: 'Reimbursements (not taxed)', rows: rows('reimbursement') },
      ],
      gross: { current: money(p.gross), ytd: money(p.ytd.gross) },
      net: { current: money(p.net), ytd: money(p.ytd.net) },
      employerTaxes: rows('employer_tax'),
      draft: run.status === 'draft',
    });
    return { bytes, fileName: `Payslip ${p.personName} ${run.payDate}.pdf` };
  }

  /** One paycheck with its run, for the payslip. */
  private async paycheckFor(ctx: Ctx, paycheckId: string) {
    return this.db.run(ctx, async (trx) => {
      const p = await trx
        .selectFrom('app.paycheck')
        .selectAll()
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', paycheckId)
        .executeTakeFirst();
      if (!p) throw notFound('Paycheck');
      const run = await this.run(trx, ctx, p.pay_run_id);
      const e = await businessEntity(trx, ctx, p.entity_id);
      const dto = (await this.paycheckDtos(trx, ctx, run, [p]))[0]!;
      const profile = await trx
        .selectFrom('app.business_profile')
        .select(['legal_name', 'address'])
        .where('workspace_id', '=', ctx.workspaceId)
        .where('entity_id', '=', p.entity_id)
        .executeTakeFirst();
      // The person's address and masked SSN only for someone who can see payroll records.
      const person = await trx
        .selectFrom('app.payroll_person')
        .selectAll()
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', p.person_id)
        .executeTakeFirst();
      return { paycheck: dto, run: await this.runDto(trx, ctx, run, false), entity: e, profile, person };
    });
  }

  /** Recomputes this person's paychecks on draft runs, so a newly approved reimbursement shows there. */
  async refreshDraftsFor(trx: Trx, ctx: Ctx, personId: string): Promise<void> {
    const drafts = await trx
      .selectFrom('app.paycheck as p')
      .innerJoin('app.pay_run as r', (j) =>
        j.onRef('r.workspace_id', '=', 'p.workspace_id').onRef('r.id', '=', 'p.pay_run_id'),
      )
      .select(['p.id', 'r.id as run_id'])
      .where('p.workspace_id', '=', ctx.workspaceId)
      .where('p.person_id', '=', personId)
      .where('r.status', '=', 'draft')
      .orderBy('r.pay_date')
      .limit(1)
      .execute();
    for (const d of drafts) {
      const lines = await this.lines(trx, ctx, [d.id]);
      const hours = (code: string) =>
        lines.find((l) => l.kind === 'earning' && l.code === code)?.hours_milli ?? null;
      await this.recompute(trx, ctx, d.id, { hours: hours('regular'), overtime: hours('overtime') });
    }
  }

  // ----- Internals ------------------------------------------------------------------------------------------------

  private async schedule(trx: Trx, ctx: Ctx, id: string): Promise<PayScheduleRow> {
    const s = await trx
      .selectFrom('app.pay_schedule')
      .selectAll()
      .where('workspace_id', '=', ctx.workspaceId)
      .where('id', '=', id)
      .executeTakeFirst();
    if (!s) throw notFound('Pay schedule');
    return s;
  }

  private async run(trx: Trx, ctx: Ctx, id: string): Promise<PayRunRow> {
    const r = await trx
      .selectFrom('app.pay_run')
      .selectAll()
      .where('workspace_id', '=', ctx.workspaceId)
      .where('id', '=', id)
      .executeTakeFirst();
    if (!r) throw notFound('Pay run');
    return r;
  }

  private async draft(trx: Trx, ctx: Ctx, id: string, version: number): Promise<PayRunRow> {
    const r = await this.run(trx, ctx, id);
    await payrollEntity(trx, ctx, r.entity_id);
    if (r.status !== 'draft')
      throw new AppError(409, 'payroll.run_approved', 'This pay run is approved; reopen it to change it');
    if (BigInt(r.version) !== BigInt(version)) throw conflict();
    return r;
  }

  /** A bank or cash account of this business: pay comes out of real money. */
  private async bankAccount(trx: Trx, ctx: Ctx, entityId: string, accountId: string): Promise<void> {
    const a = await trx
      .selectFrom('app.ledger_account as a')
      .innerJoin('app.bank_account as b', (j) =>
        j.onRef('b.workspace_id', '=', 'a.workspace_id').onRef('b.ledger_account_id', '=', 'a.id'),
      )
      .select(['a.id', 'a.entity_id', 'b.kind'])
      .where('a.workspace_id', '=', ctx.workspaceId)
      .where('a.id', '=', accountId)
      .executeTakeFirst();
    if (!a || a.entity_id !== entityId || !['checking', 'savings', 'cash'].includes(a.kind)) {
      throw unprocessable(
        'payroll.pay_from_account',
        'Pay comes from a checking, savings or cash account of this business',
      );
    }
  }

  private async nextUnpaid(trx: Trx, ctx: Ctx, s: PayScheduleRow, e: BusinessEntity) {
    const last = await trx
      .selectFrom('app.pay_run')
      .select(['period_start', 'period_end'])
      .where('workspace_id', '=', ctx.workspaceId)
      .where('schedule_id', '=', s.id)
      .orderBy('period_start', 'desc')
      .executeTakeFirst();
    const anchor = dateOf(s.anchor_date);
    return last
      ? nextPayPeriod(s.frequency, anchor, { start: dateOf(last.period_start), end: dateOf(last.period_end) })
      : payPeriodContaining(s.frequency, anchor, todayIn(e.timeZone));
  }

  private async paychecks(trx: Trx, ctx: Ctx, runId: string): Promise<PaycheckRow[]> {
    return trx
      .selectFrom('app.paycheck')
      .selectAll()
      .where('workspace_id', '=', ctx.workspaceId)
      .where('pay_run_id', '=', runId)
      .orderBy('person_name')
      .execute();
  }

  private async lines(trx: Trx, ctx: Ctx, paycheckIds: string[]): Promise<PaycheckLineRow[]> {
    if (!paycheckIds.length) return [];
    return trx
      .selectFrom('app.paycheck_line')
      .selectAll()
      .where('workspace_id', '=', ctx.workspaceId)
      .where('paycheck_id', 'in', paycheckIds)
      .orderBy('sort_order')
      .orderBy('label')
      .execute();
  }

  private async recomputeAll(trx: Trx, ctx: Ctx, runId: string): Promise<void> {
    const paychecks = await this.paychecks(trx, ctx, runId);
    const lines = await this.lines(
      trx,
      ctx,
      paychecks.map((p) => p.id),
    );
    for (const p of paychecks) {
      const hours = (code: string) =>
        lines.find((l) => l.paycheck_id === p.id && l.kind === 'earning' && l.code === code)?.hours_milli ??
        null;
      await this.recompute(trx, ctx, p.id, { hours: hours('regular'), overtime: hours('overtime') });
    }
  }

  /**
   * Rebuilds a draft paycheck's computed lines (regular pay, reimbursements, the engine's taxes) around its manual ones,
   * then its totals. A tax entered by hand wins over the engine's line with the same code.
   */
  private async recompute(
    trx: Trx,
    ctx: Ctx,
    paycheckId: string,
    hours: { hours: bigint | string | null; overtime: bigint | string | null },
  ): Promise<void> {
    const pc = await trx
      .selectFrom('app.paycheck')
      .selectAll()
      .where('workspace_id', '=', ctx.workspaceId)
      .where('id', '=', paycheckId)
      .executeTakeFirstOrThrow();
    const run = await this.run(trx, ctx, pc.pay_run_id);
    const schedule = run.schedule_id ? await this.schedule(trx, ctx, run.schedule_id) : null;
    const person = await trx
      .selectFrom('app.payroll_person')
      .selectAll()
      .where('workspace_id', '=', ctx.workspaceId)
      .where('id', '=', pc.person_id)
      .executeTakeFirstOrThrow();
    await trx
      .deleteFrom('app.paycheck_line')
      .where('workspace_id', '=', ctx.workspaceId)
      .where('paycheck_id', '=', paycheckId)
      .where('source', '=', 'computed')
      .execute();
    const insert = (l: {
      kind: PaycheckLineRow['kind'];
      code: string;
      label: string;
      amount: bigint;
      hours?: bigint | null;
      rate?: bigint | null;
      taxable?: bigint | null;
      reimbursementId?: string | null;
      sort: number;
    }) =>
      trx
        .insertInto('app.paycheck_line')
        .values({
          workspace_id: ctx.workspaceId,
          id: newId(),
          entity_id: pc.entity_id,
          paycheck_id: paycheckId,
          kind: l.kind,
          code: l.code,
          label: l.label,
          amount_minor: l.amount,
          hours_milli: l.hours ?? null,
          rate_minor: l.rate ?? null,
          taxable_minor: l.taxable ?? null,
          reimbursement_id: l.reimbursementId ?? null,
          source: 'computed',
          sort_order: l.sort,
        })
        .execute();

    // Regular pay.
    const rate = person.rate_minor !== null ? BigInt(person.rate_minor) : null;
    if (person.pay_type === 'salary' && rate !== null && schedule) {
      await insert({
        kind: 'earning',
        code: 'salary',
        label: 'Salary',
        amount: salaryPerPeriod(rate, schedule.frequency),
        sort: 1,
      });
    } else if (person.pay_type === 'hourly' && rate !== null) {
      const regular = hours.hours !== null ? BigInt(hours.hours) : 0n;
      await insert({
        kind: 'earning',
        code: 'regular',
        label: 'Regular hours',
        amount: hoursPay(regular, rate),
        hours: regular,
        rate,
        sort: 1,
      });
      const ot = hours.overtime !== null ? BigInt(hours.overtime) : 0n;
      if (ot > 0n) {
        const otRate = overtimeRate(rate);
        await insert({
          kind: 'earning',
          code: 'overtime',
          label: 'Overtime',
          amount: hoursPay(ot, otRate),
          hours: ot,
          rate: otRate,
          sort: 2,
        });
      }
    }

    // PRL-11: approved reimbursements waiting for a pay run, untaxed.
    await sql`update app.reimbursement set paycheck_id = ${paycheckId}
               where workspace_id = ${ctx.workspaceId} and person_id = ${pc.person_id} and status = 'approved'
                 and pay_via = 'pay_run' and paycheck_id is null`.execute(trx);
    const reimbursements = await trx
      .selectFrom('app.reimbursement')
      .select(['id', 'description', 'amount_minor'])
      .where('workspace_id', '=', ctx.workspaceId)
      .where('paycheck_id', '=', paycheckId)
      .orderBy('spent_on')
      .execute();
    let sort = 300;
    for (const r of reimbursements) {
      await insert({
        kind: 'reimbursement',
        code: 'reimbursement',
        label: `Reimbursement: ${r.description}`.slice(0, 100),
        amount: BigInt(r.amount_minor),
        reimbursementId: r.id,
        sort: sort++,
      });
    }

    // Taxes, from the engine (ADR-0034 §7).
    let lines = await this.lines(trx, ctx, [paycheckId]);
    const now = paycheckTotals(lines.map((l) => ({ kind: l.kind, amount: BigInt(l.amount_minor) })));
    const payDate = dateOf(run.pay_date);
    const ytd = await this.ytdWages(trx, ctx, pc.person_id, payDate, run.id);
    const w4 = await trx
      .selectFrom('app.payroll_w4')
      .selectAll()
      .where('workspace_id', '=', ctx.workspaceId)
      .where('person_id', '=', pc.person_id)
      .where('effective_date', '<=', payDate)
      .orderBy('effective_date', 'desc')
      .executeTakeFirst();
    const de4 = await trx
      .selectFrom('app.payroll_de4')
      .selectAll()
      .where('workspace_id', '=', ctx.workspaceId)
      .where('person_id', '=', pc.person_id)
      .where('effective_date', '<=', payDate)
      .orderBy('effective_date', 'desc')
      .executeTakeFirst();
    const settings = await trx
      .selectFrom('app.payroll_settings')
      .select(['ca_ui_rate_ppm', 'ca_ett_rate_ppm'])
      .where('workspace_id', '=', ctx.workspaceId)
      .where('entity_id', '=', pc.entity_id)
      .executeTakeFirst();
    const preTax = (code: PreTaxCode) =>
      lines
        .filter((l) => l.kind === 'pre_tax_deduction' && l.code === code)
        .reduce((t, l) => t + BigInt(l.amount_minor), 0n);
    const frequency = schedule?.frequency ?? 'monthly';
    const { lines: taxes, notes } = await this.engine.compute({
      entityId: pc.entity_id,
      payDate,
      frequency,
      periodsPerYear: schedule ? PERIODS_PER_YEAR[schedule.frequency] : 12,
      wages: { gross: now.gross, retirement: preTax('retirement'), section125: preTax('section125') },
      ytd,
      workState: person.work_state,
      w4: w4
        ? {
            filingStatus: w4.filing_status,
            multipleJobs: w4.multiple_jobs,
            dependents: BigInt(w4.dependents_minor),
            otherIncome: BigInt(w4.other_income_minor),
            deductions: BigInt(w4.deductions_minor),
            extraWithholding: BigInt(w4.extra_withholding_minor),
            exempt: w4.exempt,
          }
        : null,
      de4: de4
        ? {
            filingStatus: de4.filing_status,
            allowances: de4.allowances,
            estimatedDeductionAllowances: de4.estimated_deduction_allowances,
            extraWithholding: BigInt(de4.extra_withholding_minor),
            exempt: de4.exempt,
          }
        : null,
      caUiRate: settings?.ca_ui_rate_ppm != null ? BigInt(settings.ca_ui_rate_ppm) : null,
      caEttRate: BigInt(settings?.ca_ett_rate_ppm ?? 1000),
    });
    const manual = new Set(lines.filter((l) => l.source === 'manual').map((l) => `${l.kind}:${l.code}`));
    sort = 200;
    for (const t of taxes) {
      if (manual.has(`${t.kind}:${t.code}`) || t.amount === 0n) continue;
      await insert({
        kind: t.kind,
        code: t.code,
        label: t.label || TAX_LABELS[t.code],
        amount: t.amount,
        taxable: t.taxable,
        sort: sort++,
      });
    }

    lines = await this.lines(trx, ctx, [paycheckId]);
    const totals = paycheckTotals(lines.map((l) => ({ kind: l.kind, amount: BigInt(l.amount_minor) })));
    await trx
      .updateTable('app.paycheck')
      .set({
        w4_id: w4?.id ?? null,
        de4_id: de4?.id ?? null,
        tax_notes: notes,
        gross_minor: totals.gross,
        pre_tax_minor: totals.preTax,
        employee_taxes_minor: totals.employeeTaxes,
        post_tax_minor: totals.postTax,
        reimbursements_minor: totals.reimbursements,
        net_minor: totals.net,
        employer_taxes_minor: totals.employerTaxes,
      })
      .where('workspace_id', '=', ctx.workspaceId)
      .where('id', '=', paycheckId)
      .execute();
  }

  /** Gross pay and before-tax deductions by kind, from approved runs earlier in the pay date's year (this run left out). */
  private async ytdWages(
    trx: Trx,
    ctx: Ctx,
    personId: string,
    payDate: CalendarDate,
    excludeRunId: string,
  ): Promise<WageParts> {
    const { rows } = await sql<{
      gross: string | null;
      retirement: string | null;
      section125: string | null;
    }>`
      select (select coalesce(sum(p.gross_minor), 0) from app.paycheck p
                join app.pay_run r on r.workspace_id = p.workspace_id and r.id = p.pay_run_id
               where p.workspace_id = ${ctx.workspaceId} and p.person_id = ${personId} and r.status = 'approved'
                 and r.id <> ${excludeRunId} and r.pay_date between ${`${payDate.slice(0, 4)}-01-01`}::date and ${payDate}::date) as gross,
             coalesce(sum(l.amount_minor) filter (where l.code = 'retirement'), 0) as retirement,
             coalesce(sum(l.amount_minor) filter (where l.code = 'section125'), 0) as section125
        from app.paycheck_line l
        join app.paycheck p on p.workspace_id = l.workspace_id and p.id = l.paycheck_id
        join app.pay_run r on r.workspace_id = p.workspace_id and r.id = p.pay_run_id
       where l.workspace_id = ${ctx.workspaceId} and p.person_id = ${personId} and r.status = 'approved'
         and r.id <> ${excludeRunId} and l.kind = 'pre_tax_deduction'
         and r.pay_date between ${`${payDate.slice(0, 4)}-01-01`}::date and ${payDate}::date`.execute(trx);
    const r = rows[0];
    return {
      gross: BigInt(r?.gross ?? 0),
      retirement: BigInt(r?.retirement ?? 0),
      section125: BigInt(r?.section125 ?? 0),
    };
  }

  /** Approved paychecks for this person earlier in the pay date's calendar year, leaving out this run. */
  private async yearToDate(
    trx: Trx,
    ctx: Ctx,
    personId: string,
    payDate: CalendarDate,
    excludeRunId: string,
  ): Promise<PaycheckTotals> {
    const rows = await trx
      .selectFrom('app.paycheck as p')
      .innerJoin('app.pay_run as r', (j) =>
        j.onRef('r.workspace_id', '=', 'p.workspace_id').onRef('r.id', '=', 'p.pay_run_id'),
      )
      .selectAll('p')
      .where('p.workspace_id', '=', ctx.workspaceId)
      .where('p.person_id', '=', personId)
      .where('r.status', '=', 'approved')
      .where('r.id', '!=', excludeRunId)
      .where('r.pay_date', '>=', `${payDate.slice(0, 4)}-01-01`)
      .where('r.pay_date', '<=', payDate)
      .execute();
    return rows.reduce((t, p) => add(t, rowTotals(p)), ZERO);
  }

  private async reimbursementAccounts(trx: Trx, ctx: Ctx, lines: PaycheckLineRow[]) {
    const ids = lines.filter((l) => l.reimbursement_id).map((l) => l.reimbursement_id!);
    if (!ids.length) return new Map<string, string>();
    const rows = await trx
      .selectFrom('app.reimbursement')
      .select(['id', 'expense_account_id'])
      .where('workspace_id', '=', ctx.workspaceId)
      .where('id', 'in', ids)
      .execute();
    return new Map(rows.map((r) => [r.id, r.expense_account_id]));
  }

  /**
   * One paycheck, one transaction (ADR-0034 §6): debit wages and reimbursed expenses, credit what was withheld to its
   * liability and net pay to the bank. Employer taxes aren't posted here; they're expensed when deposited.
   */
  private async post(
    trx: Trx,
    ctx: Ctx,
    e: BusinessEntity,
    run: PayRunRow,
    p: PaycheckRow,
    lines: PaycheckLineRow[],
    reimbursementAccounts: Map<string, string>,
  ): Promise<void> {
    const currency = asCurrencyCode(e.currency);
    const amounts = new Map<string, { amount: bigint; memo: string }>();
    const put = (accountId: string, amount: bigint, memo: string) => {
      const was = amounts.get(accountId);
      amounts.set(accountId, { amount: (was?.amount ?? 0n) + amount, memo: was?.memo ?? memo });
    };
    const wages = await payrollAccount(trx, ctx, e.id, e.currency, 'wages');
    put(wages, BigInt(p.gross_minor), 'Gross pay');
    for (const l of lines) {
      const amount = BigInt(l.amount_minor);
      if (l.kind === 'reimbursement') {
        put(reimbursementAccounts.get(l.reimbursement_id ?? '') ?? wages, amount, l.label);
      } else if (
        l.kind === 'pre_tax_deduction' ||
        l.kind === 'employee_tax' ||
        l.kind === 'post_tax_deduction'
      ) {
        const role = liabilityFor(l.kind, l.code);
        put(await payrollAccount(trx, ctx, e.id, e.currency, role), -amount, l.label);
      }
    }
    const net = BigInt(p.net_minor);
    const payFrom = run.pay_from_account_id!;
    const description = `Pay: ${p.person_name}`;
    const postings: PostingDraft[] = [];
    const line = (accountId: string, amount: bigint, memo: string) =>
      postings.push({
        lineNo: postings.length + 1,
        accountId,
        accountEntityId: e.id,
        currency,
        amount,
        functionalAmount: amount,
        fxRate: null,
        memo,
      });
    if (net !== 0n) line(payFrom, -net, description);
    for (const [accountId, v] of amounts) if (v.amount !== 0n) line(accountId, v.amount, v.memo);
    const date = dateOf(run.pay_date);
    const entry: JournalEntryDraft = {
      entityId: e.id,
      functionalCurrency: currency,
      entryDate: date,
      kind: 'standard',
      description,
      postings,
    };
    const spec: TransactionSpec = {
      type: 'standard',
      accountId: payFrom,
      amount: String(-net),
      currency: e.currency,
      description,
      memberId: null,
      uncategorized: false,
      splits: [{ accountId: wages, amount: String(-net), memberId: null }],
      paycheckId: p.id,
    };
    const transactionId = newId();
    await trx
      .insertInto('app.transaction')
      .values({
        workspace_id: ctx.workspaceId,
        id: transactionId,
        primary_entity_id: e.id,
        txn_date: date,
        payee_raw: p.person_name,
        description,
        status: 'posted',
        source: 'payroll',
        review_state: 'reviewed',
        spec: JSON.stringify(spec),
        posted_at: new Date(),
        created_by: ctx.userId,
      })
      .execute();
    await this.poster.repost(trx, ctx, transactionId, [entry], { fresh: true });
    await trx
      .updateTable('app.paycheck')
      .set({ transaction_id: transactionId })
      .where('workspace_id', '=', ctx.workspaceId)
      .where('id', '=', p.id)
      .execute();
  }

  private async scheduleDto(
    trx: Trx,
    ctx: Ctx,
    s: PayScheduleRow,
    e: BusinessEntity,
  ): Promise<PayScheduleDto> {
    const next = await this.nextUnpaid(trx, ctx, s, e);
    return {
      id: s.id,
      entityId: s.entity_id,
      name: s.name,
      frequency: s.frequency,
      anchorDate: dateOf(s.anchor_date),
      payLagDays: s.pay_lag_days,
      payFromAccountId: s.pay_from_account_id,
      nextPeriod: { start: next.start, end: next.end, payDate: addDays(next.end, s.pay_lag_days) },
      people: await this.peopleOn(trx, ctx, s.id),
      archived: s.archived_at !== null,
      version: Number(s.version),
    };
  }

  /** Employees on a schedule; zero for a reader who can't see payroll records. */
  private async peopleOn(trx: Trx, ctx: Ctx, scheduleId: string): Promise<number> {
    const r = await trx
      .selectFrom('app.payroll_person')
      .select((x) => x.fn.countAll<string>().as('n'))
      .where('workspace_id', '=', ctx.workspaceId)
      .where('pay_schedule_id', '=', scheduleId)
      .where('kind', '=', 'employee')
      .executeTakeFirst();
    return Number(r?.n ?? 0);
  }

  private async runDto(trx: Trx, ctx: Ctx, r: PayRunRow, withPaychecks: boolean): Promise<PayRunDto> {
    const paychecks = await this.paychecks(trx, ctx, r.id);
    const totals = paychecks.reduce((t, p) => add(t, rowTotals(p)), ZERO);
    const schedule = r.schedule_id
      ? await trx
          .selectFrom('app.pay_schedule')
          .select('name')
          .where('workspace_id', '=', ctx.workspaceId)
          .where('id', '=', r.schedule_id)
          .executeTakeFirst()
      : undefined;
    return {
      id: r.id,
      entityId: r.entity_id,
      scheduleId: r.schedule_id,
      scheduleName: schedule?.name ?? null,
      periodStart: dateOf(r.period_start),
      periodEnd: dateOf(r.period_end),
      payDate: dateOf(r.pay_date),
      status: r.status,
      payFromAccountId: r.pay_from_account_id,
      engine: r.engine,
      notes: r.notes,
      approvedAt: r.approved_at ? r.approved_at.toISOString() : null,
      totals: { ...totalsDto(totals), paychecks: paychecks.length },
      ...(withPaychecks ? { paychecks: await this.paycheckDtos(trx, ctx, r, paychecks) } : {}),
      version: Number(r.version),
    };
  }

  private async paycheckDtos(
    trx: Trx,
    ctx: Ctx,
    r: PayRunRow,
    paychecks: PaycheckRow[],
  ): Promise<PaycheckDto[]> {
    const lines = await this.lines(
      trx,
      ctx,
      paychecks.map((p) => p.id),
    );
    const payDate = dateOf(r.pay_date);
    const out: PaycheckDto[] = [];
    for (const p of paychecks) {
      const before = await this.yearToDate(trx, ctx, p.person_id, payDate, r.id);
      const payType = await trx
        .selectFrom('app.payroll_person')
        .select('pay_type')
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', p.person_id)
        .executeTakeFirst();
      out.push({
        id: p.id,
        payRunId: p.pay_run_id,
        personId: p.person_id,
        personName: p.person_name,
        payType: payType?.pay_type ?? null,
        ...totalsDto(rowTotals(p)),
        lines: lines
          .filter((l) => l.paycheck_id === p.id)
          .map((l) => ({
            id: l.id,
            kind: l.kind,
            code: l.code,
            label: l.label,
            hoursMilli: l.hours_milli !== null ? String(l.hours_milli) : null,
            rate: l.rate_minor !== null ? String(l.rate_minor) : null,
            amount: String(l.amount_minor),
            taxable: l.taxable_minor !== null ? String(l.taxable_minor) : null,
            source: l.source,
            reimbursementId: l.reimbursement_id,
          })),
        ytd: totalsDto(add(before, rowTotals(p))),
        taxNotes: p.tax_notes ?? [],
        transactionId: p.transaction_id,
        version: Number(p.version),
      });
    }
    return out;
  }
}
