/**
 * Employer tax (PRL-12..16; ADR-0034 §7): the business's payroll tax settings, what to deposit and when, recorded deposits
 * and their posting, and the 941, 940, DE 9 and DE 9C worksheets. Montra works these out; the owner pays and files.
 *
 * What's owed comes from approved paychecks only. The wage bases on the worksheets are worked out again from each
 * person's paychecks in pay-date order, so a tax typed in by hand doesn't change what wages are reported.
 */
import { Inject, Injectable } from '@nestjs/common';
import {
  applyRate,
  asCurrencyCode,
  depositPeriod,
  diffDays,
  employmentTaxWages,
  fromParts,
  incomeTaxWages,
  NEXT_DAY_THRESHOLD,
  FUTA_DEPOSIT_THRESHOLD,
  PAYROLL_TAX_TABLES,
  payrollTaxYear,
  quarterEnd,
  quarterlyDue,
  quarterOf,
  quarterStart,
  todayIn,
  underWageBase,
  type CalendarDate,
  type JournalEntryDraft,
  type PostingDraft,
  type WageParts,
} from '@montra/domain';
import { newId, type PayrollDepositRow, type PayrollSettingsRow, type Trx } from '@montra/db';
import type {
  DepositObligationDto,
  PayrollDepositDto,
  PayrollSettingsDto,
  PayrollTaxesDto,
  PayrollTaxKind,
  RecordDepositRequest,
  UpdatePayrollSettingsRequest,
  WorksheetDto,
  WorksheetLineDto,
} from '@montra/schemas';
import { AppError, notFound, unprocessable } from '../common/errors.js';
import { Db } from '../db/database.js';
import { businessEntity, formatScaled, parseScaled, type BusinessEntity } from '../business/shared.js';
import { TransactionPoster, type TransactionSpec } from '../transactions/poster.js';
import { payrollAccount, type PayrollAccountRole } from './payroll-accounts.js';
import { conflict, payrollEntity, type Ctx } from './shared.js';

/** Which tax codes each deposit pays, and where each one posts. */
const DEPOSIT_CODES: Record<PayrollTaxKind, Record<string, PayrollAccountRole>> = {
  federal_941: {
    fit: 'federal_withholding',
    ss: 'fica',
    medicare: 'fica',
    addl_medicare: 'fica',
    ss_er: 'employer_taxes',
    medicare_er: 'employer_taxes',
  },
  federal_940: { futa: 'employer_taxes', futa_credit_reduction: 'employer_taxes' },
  ca_pit_sdi: { ca_pit: 'state', ca_sdi: 'state' },
  ca_ui_ett: { ca_ui: 'employer_taxes', ca_ett: 'employer_taxes' },
};

const DEPOSIT_NAMES: Record<PayrollTaxKind, { payee: string; label: string }> = {
  federal_941: { payee: 'IRS (EFTPS)', label: 'Federal payroll tax deposit (941)' },
  federal_940: { payee: 'IRS (EFTPS)', label: 'Federal unemployment tax deposit (940)' },
  ca_pit_sdi: { payee: 'California EDD', label: 'California PIT and SDI deposit' },
  ca_ui_ett: { payee: 'California EDD', label: 'California UI and ETT deposit' },
};

const DUE_SOON_DAYS = 7;

/** One approved paycheck, with what the worksheets and year-end forms need. */
export interface PaidCheck {
  personId: string;
  personName: string;
  workState: string | null;
  tinLast4: string | null;
  tinType: string | null;
  payDate: CalendarDate;
  periodStart: CalendarDate;
  periodEnd: CalendarDate;
  wages: WageParts;
  taxes: Map<string, bigint>;
}

/** Wage bases, worked out from a person's paychecks in pay-date order through the year. */
export interface Bases {
  income: bigint;
  employment: bigint;
  ss: bigint;
  addlMedicare: bigint;
  futa: bigint;
  caUi: bigint;
}

const ppmToPercent = (ppm: bigint | number): string => formatScaled(ppm, 4);
const percentToPpm = (s: string): number => Number(parseScaled(s, 4));
const sum = (m: Map<string, bigint>, codes: readonly string[]): bigint =>
  codes.reduce((t, c) => t + (m.get(c) ?? 0n), 0n);
const dateOf = (d: Date | string): CalendarDate =>
  (typeof d === 'string' ? d.slice(0, 10) : d.toISOString().slice(0, 10)) as CalendarDate;

@Injectable()
export class PayrollTaxesService {
  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(TransactionPoster) private readonly poster: TransactionPoster,
  ) {}

  // ----- Settings ---------------------------------------------------------------------------------------------------

  async settings(ctx: Ctx, entityId: string): Promise<PayrollSettingsDto> {
    return this.db.run(ctx, async (trx) => {
      await businessEntity(trx, ctx, entityId);
      return settingsDto(entityId, await this.settingsRow(trx, ctx, entityId));
    });
  }

  async updateSettings(
    ctx: Ctx,
    entityId: string,
    req: UpdatePayrollSettingsRequest,
  ): Promise<PayrollSettingsDto> {
    return this.db.run(ctx, async (trx) => {
      await payrollEntity(trx, ctx, entityId);
      const row = await this.settingsRow(trx, ctx, entityId);
      if ((row ? Number(row.version) : 0) !== req.version) throw conflict();
      const set = {
        ...(req.ein !== undefined && { ein: req.ein }),
        ...(req.caEmployerAccount !== undefined && { ca_employer_account: req.caEmployerAccount }),
        ...(req.caUiRate !== undefined && {
          ca_ui_rate_ppm: req.caUiRate === null ? null : percentToPpm(req.caUiRate),
        }),
        ...(req.caEttRate !== undefined && { ca_ett_rate_ppm: percentToPpm(req.caEttRate) }),
        ...(req.federalDepositSchedule && { federal_deposit_schedule: req.federalDepositSchedule }),
        ...(req.caDepositSchedule && { ca_deposit_schedule: req.caDepositSchedule }),
        ...(req.filingAddress !== undefined && {
          filing_line1: req.filingAddress?.line1 ?? null,
          filing_line2: req.filingAddress?.line2 ?? null,
          filing_city: req.filingAddress?.city ?? null,
          filing_state: req.filingAddress?.state ?? null,
          filing_zip: req.filingAddress?.zip ?? null,
        }),
        ...(req.ssaUserId !== undefined && { ssa_user_id: req.ssaUserId }),
        ...(req.contactName !== undefined && { contact_name: req.contactName }),
        ...(req.contactPhone !== undefined && { contact_phone: req.contactPhone }),
        ...(req.contactEmail !== undefined && { contact_email: req.contactEmail }),
      };
      if (row) {
        await trx
          .updateTable('app.payroll_settings')
          .set(set)
          .where('workspace_id', '=', ctx.workspaceId)
          .where('entity_id', '=', entityId)
          .execute();
      } else {
        await trx
          .insertInto('app.payroll_settings')
          .values({ workspace_id: ctx.workspaceId, entity_id: entityId, ...set })
          .execute();
      }
      return settingsDto(entityId, await this.settingsRow(trx, ctx, entityId));
    });
  }

  // ----- What to deposit (PRL-15) -----------------------------------------------------------------------------------

  async taxes(ctx: Ctx, entityId: string, year: number, now = new Date()): Promise<PayrollTaxesDto> {
    return this.db.run(ctx, async (trx) => {
      const e = await businessEntity(trx, ctx, entityId);
      const row = await this.settingsRow(trx, ctx, entityId);
      const today = todayIn(e.timeZone ?? 'UTC', now);
      return {
        entityId,
        year,
        settings: settingsDto(entityId, row),
        obligations: await this.obligations(trx, ctx, entityId, year, row, today),
      };
    });
  }

  async recordDeposit(ctx: Ctx, req: RecordDepositRequest, now = new Date()): Promise<PayrollDepositDto> {
    return this.db.run(ctx, async (trx) => {
      const e = await payrollEntity(trx, ctx, req.entityId);
      const today = todayIn(e.timeZone ?? 'UTC', now);
      if (req.paidOn > today)
        throw unprocessable('payroll.deposit_future', 'Record a deposit once it’s made');
      await bankAccount(trx, ctx, e.id, req.payFromAccountId);
      const year = Number(req.periodStart.slice(0, 4));
      const row = await this.settingsRow(trx, ctx, e.id);
      const all = await this.obligations(trx, ctx, e.id, year, row, today);
      const o = all.find(
        (x) => x.tax === req.tax && x.periodStart === req.periodStart && x.status !== 'carried',
      );
      if (!o) throw notFound('Deposit period');
      if (o.deposit) {
        throw new AppError(409, 'payroll.deposit_recorded', 'A deposit is already recorded for this period');
      }
      const id = newId();
      await trx
        .insertInto('app.payroll_deposit')
        .values({
          workspace_id: ctx.workspaceId,
          id,
          entity_id: e.id,
          tax: req.tax,
          period_start: o.periodStart,
          period_end: o.periodEnd,
          due_date: o.dueDate,
          paid_on: req.paidOn,
          amount_minor: BigInt(o.amount),
          parts: JSON.stringify(o.parts),
          pay_from_account_id: req.payFromAccountId,
          confirmation: req.confirmation ?? null,
          created_by: ctx.userId,
        })
        .execute();
      const transactionId = await this.post(trx, ctx, e, id, req, o);
      await trx
        .updateTable('app.payroll_deposit')
        .set({ transaction_id: transactionId })
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', id)
        .execute();
      return depositDto(await this.deposit(trx, ctx, id));
    });
  }

  /** Takes a deposit back: its transaction is voided, unless it's reconciled or in a closed period. */
  async removeDeposit(ctx: Ctx, id: string): Promise<void> {
    await this.db.run(ctx, async (trx) => {
      const d = await this.deposit(trx, ctx, id);
      await payrollEntity(trx, ctx, d.entity_id);
      if (d.transaction_id) {
        if ((await this.poster.protection(trx, ctx, d.transaction_id)) !== 'none') {
          throw new AppError(
            409,
            'payroll.deposit_locked',
            'This deposit is reconciled or in a closed period, so it can’t be removed',
          );
        }
        await trx
          .updateTable('app.payroll_deposit')
          .set({ transaction_id: null })
          .where('workspace_id', '=', ctx.workspaceId)
          .where('id', '=', id)
          .execute();
        await this.poster.unpost(trx, ctx, d.transaction_id);
        await trx
          .updateTable('app.transaction')
          .set({ status: 'void', deleted_at: new Date() })
          .where('workspace_id', '=', ctx.workspaceId)
          .where('id', '=', d.transaction_id)
          .execute();
      }
      await trx
        .deleteFrom('app.payroll_deposit')
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', id)
        .execute();
    });
  }

  // ----- Worksheets (PRL-16) ----------------------------------------------------------------------------------------

  async worksheet(
    ctx: Ctx,
    entityId: string,
    form: WorksheetDto['form'],
    year: number,
    quarter: number | null,
  ): Promise<WorksheetDto> {
    return this.db.run(ctx, async (trx) => {
      const e = await businessEntity(trx, ctx, entityId);
      const row = await this.settingsRow(trx, ctx, entityId);
      const checks = await this.paidChecks(trx, ctx, entityId, year);
      const bases = basesFor(checks, year);
      const deposits = await this.deposits(trx, ctx, entityId, year);
      const employer = {
        name: (await this.legalName(trx, ctx, e)) ?? e.name,
        ein: row?.ein ? `${row.ein.slice(0, 2)}-${row.ein.slice(2)}` : null,
        caEmployerAccount: row?.ca_employer_account
          ? `${row.ca_employer_account.slice(0, 3)}-${row.ca_employer_account.slice(3, 7)}-${row.ca_employer_account.slice(7)}`
          : null,
      };
      const t = payrollTaxYear(year);
      const notes: string[] = [];
      if (!t) notes.push(`Montra doesn’t have the ${year} tables, so wage bases aren’t worked out.`);
      const base = { entityId, year, employer, notes };
      if (form === '940')
        return { ...base, ...form940(checks, bases, deposits, t, year, notes), quarter: null };
      const q = quarter ?? 1;
      const inQ = (d: CalendarDate) => d >= quarterStart(year, q) && d <= quarterEnd(year, q);
      const qChecks = checks.filter((c) => inQ(c.payDate));
      const qDeposits = deposits.filter((d) => inQ(dateOf(d.period_start)));
      if (form === '941') {
        return { ...base, quarter: q, ...form941(qChecks, bases, qDeposits, row, year, q) };
      }
      const caChecks = qChecks.filter((c) => c.workState === 'CA');
      if (form === 'DE 9') {
        return { ...base, quarter: q, ...formDe9(caChecks, bases, qDeposits, row, t, year, q, notes) };
      }
      return { ...base, quarter: q, ...formDe9c(caChecks, bases, year, q) };
    });
  }

  // ----- Internals --------------------------------------------------------------------------------------------------

  private settingsRow(trx: Trx, ctx: Ctx, entityId: string): Promise<PayrollSettingsRow | undefined> {
    return trx
      .selectFrom('app.payroll_settings')
      .selectAll()
      .where('workspace_id', '=', ctx.workspaceId)
      .where('entity_id', '=', entityId)
      .executeTakeFirst();
  }

  private async deposit(trx: Trx, ctx: Ctx, id: string): Promise<PayrollDepositRow> {
    const d = await trx
      .selectFrom('app.payroll_deposit')
      .selectAll()
      .where('workspace_id', '=', ctx.workspaceId)
      .where('id', '=', id)
      .executeTakeFirst();
    if (!d) throw notFound('Deposit');
    return d;
  }

  private deposits(trx: Trx, ctx: Ctx, entityId: string, year: number): Promise<PayrollDepositRow[]> {
    return trx
      .selectFrom('app.payroll_deposit')
      .selectAll()
      .where('workspace_id', '=', ctx.workspaceId)
      .where('entity_id', '=', entityId)
      .where('period_start', '>=', `${year}-01-01`)
      .where('period_start', '<=', `${year}-12-31`)
      .execute();
  }

  private async legalName(trx: Trx, ctx: Ctx, e: BusinessEntity): Promise<string | null> {
    const p = await trx
      .selectFrom('app.business_profile')
      .select('legal_name')
      .where('workspace_id', '=', ctx.workspaceId)
      .where('entity_id', '=', e.id)
      .executeTakeFirst();
    return p?.legal_name ?? null;
  }

  /** Approved paychecks with pay dates in the year, oldest first, with each tax by code. */
  async paidChecks(trx: Trx, ctx: Ctx, entityId: string, year: number): Promise<PaidCheck[]> {
    const rows = await trx
      .selectFrom('app.paycheck as p')
      .innerJoin('app.pay_run as r', (j) =>
        j.onRef('r.workspace_id', '=', 'p.workspace_id').onRef('r.id', '=', 'p.pay_run_id'),
      )
      .leftJoin('app.payroll_person as x', (j) =>
        j.onRef('x.workspace_id', '=', 'p.workspace_id').onRef('x.id', '=', 'p.person_id'),
      )
      .select([
        'p.id',
        'p.person_id',
        'p.person_name',
        'p.gross_minor',
        'r.pay_date',
        'r.period_start',
        'r.period_end',
        'x.work_state',
        'x.tin_last4',
        'x.tin_type',
      ])
      .where('p.workspace_id', '=', ctx.workspaceId)
      .where('r.entity_id', '=', entityId)
      .where('r.status', '=', 'approved')
      .where('r.pay_date', '>=', `${year}-01-01`)
      .where('r.pay_date', '<=', `${year}-12-31`)
      .orderBy('r.pay_date')
      .orderBy('p.id')
      .execute();
    if (!rows.length) return [];
    const lines = await trx
      .selectFrom('app.paycheck_line')
      .select(['paycheck_id', 'kind', 'code', 'amount_minor'])
      .where('workspace_id', '=', ctx.workspaceId)
      .where(
        'paycheck_id',
        'in',
        rows.map((r) => r.id),
      )
      .where('kind', 'in', ['pre_tax_deduction', 'employee_tax', 'employer_tax'])
      .execute();
    return rows.map((r) => {
      const mine = lines.filter((l) => l.paycheck_id === r.id);
      const pre = (code: string) =>
        mine
          .filter((l) => l.kind === 'pre_tax_deduction' && l.code === code)
          .reduce((t, l) => t + BigInt(l.amount_minor), 0n);
      const taxes = new Map<string, bigint>();
      for (const l of mine) {
        if (l.kind === 'pre_tax_deduction') continue;
        taxes.set(l.code, (taxes.get(l.code) ?? 0n) + BigInt(l.amount_minor));
      }
      return {
        personId: r.person_id,
        personName: r.person_name,
        workState: r.work_state ?? null,
        tinLast4: r.tin_last4 ?? null,
        tinType: r.tin_type ?? null,
        payDate: dateOf(r.pay_date),
        periodStart: dateOf(r.period_start),
        periodEnd: dateOf(r.period_end),
        wages: { gross: BigInt(r.gross_minor), retirement: pre('retirement'), section125: pre('section125') },
        taxes,
      };
    });
  }

  private async obligations(
    trx: Trx,
    ctx: Ctx,
    entityId: string,
    year: number,
    row: PayrollSettingsRow | undefined,
    today: CalendarDate,
  ): Promise<DepositObligationDto[]> {
    const checks = await this.paidChecks(trx, ctx, entityId, year);
    const deposits = await this.deposits(trx, ctx, entityId, year);
    const fed = row?.federal_deposit_schedule ?? 'monthly';
    const caSchedule = row?.ca_deposit_schedule ?? 'quarterly';
    type Acc = {
      start: CalendarDate;
      end: CalendarDate;
      due: CalendarDate;
      parts: Map<string, bigint>;
      byDay: Map<string, bigint>;
    };
    const out: { tax: PayrollTaxKind; acc: Acc; carried?: boolean }[] = [];
    const group = (tax: PayrollTaxKind, schedule: 'monthly' | 'semiweekly' | 'quarterly') => {
      const codes = Object.keys(DEPOSIT_CODES[tax]);
      const by = new Map<string, Acc>();
      for (const c of checks) {
        const amount = sum(c.taxes, codes);
        if (amount === 0n) continue;
        const p = depositPeriod(schedule, c.payDate);
        const acc = by.get(p.start) ?? { ...p, parts: new Map(), byDay: new Map() };
        for (const code of codes) {
          const v = c.taxes.get(code);
          if (v) acc.parts.set(code, (acc.parts.get(code) ?? 0n) + v);
        }
        acc.byDay.set(c.payDate, (acc.byDay.get(c.payDate) ?? 0n) + amount);
        by.set(p.start, acc);
      }
      for (const acc of by.values()) out.push({ tax, acc });
    };
    group('federal_941', fed);
    group('ca_pit_sdi', caSchedule);
    group('ca_ui_ett', 'quarterly');

    // FUTA: by quarter, carried while $500 or less is owed; the fourth quarter (and any credit reduction) is due with
    // Form 940 by January 31.
    const t = payrollTaxYear(year);
    let carry: Acc | null = null;
    for (let q = 1; q <= 4; q++) {
      const inQ = checks.filter((c) => quarterOf(c.payDate) === q && c.taxes.get('futa'));
      const acc: Acc = carry ?? {
        start: quarterStart(year, q),
        end: quarterEnd(year, q),
        due: quarterlyDue(year, q),
        parts: new Map(),
        byDay: new Map(),
      };
      acc.end = quarterEnd(year, q);
      acc.due = quarterlyDue(year, q);
      for (const c of inQ) acc.parts.set('futa', (acc.parts.get('futa') ?? 0n) + (c.taxes.get('futa') ?? 0n));
      if (q === 4 && t) {
        const reduction = creditReduction(checks, t);
        if (reduction > 0n) acc.parts.set('futa_credit_reduction', reduction);
      }
      const owed = sum(acc.parts, ['futa', 'futa_credit_reduction']);
      if (owed === 0n) {
        carry = null;
        continue;
      }
      const ended = today > quarterEnd(year, q);
      if (q < 4 && ended && owed <= FUTA_DEPOSIT_THRESHOLD) {
        out.push({ tax: 'federal_940', acc: { ...acc, parts: new Map(acc.parts) }, carried: true });
        carry = acc;
        continue;
      }
      out.push({ tax: 'federal_940', acc });
      carry = null;
    }

    const list = out.map(({ tax, acc, carried }): DepositObligationDto => {
      const amount = [...acc.parts.values()].reduce((a, b) => a + b, 0n);
      const d = carried
        ? undefined
        : deposits.find((x) => x.tax === tax && dateOf(x.period_start) === acc.start);
      const status: DepositObligationDto['status'] = carried
        ? 'carried'
        : d
          ? 'paid'
          : today > acc.due
            ? 'overdue'
            : diffDays(acc.due, today) <= DUE_SOON_DAYS
              ? 'due_soon'
              : 'upcoming';
      return {
        tax,
        periodStart: acc.start,
        periodEnd: acc.end,
        dueDate: acc.due,
        amount: String(amount),
        parts: Object.fromEntries([...acc.parts].map(([k, v]) => [k, String(v)])),
        status,
        deposit: d ? depositDto(d) : null,
        difference: String(d ? amount - BigInt(d.amount_minor) : 0n),
        nextDay: tax === 'federal_941' && [...acc.byDay.values()].some((v) => v >= NEXT_DAY_THRESHOLD),
      };
    });
    return list.sort((a, b) =>
      a.dueDate === b.dueDate ? a.tax.localeCompare(b.tax) : a.dueDate < b.dueDate ? -1 : 1,
    );
  }

  /** One transaction: what was withheld comes out of its liability, the employer's share is expensed, the bank pays. */
  private async post(
    trx: Trx,
    ctx: Ctx,
    e: BusinessEntity,
    depositId: string,
    req: RecordDepositRequest,
    o: DepositObligationDto,
  ): Promise<string> {
    const currency = asCurrencyCode(e.currency);
    const by = new Map<string, bigint>();
    for (const [code, amount] of Object.entries(o.parts)) {
      const role = DEPOSIT_CODES[req.tax][code];
      if (!role) continue;
      const account = await payrollAccount(trx, ctx, e.id, e.currency, role);
      by.set(account, (by.get(account) ?? 0n) + BigInt(amount));
    }
    const total = BigInt(o.amount);
    const names = DEPOSIT_NAMES[req.tax];
    const description = `${names.label}, ${o.periodStart} to ${o.periodEnd}`;
    const postings: PostingDraft[] = [];
    const line = (accountId: string, amount: bigint) =>
      postings.push({
        lineNo: postings.length + 1,
        accountId,
        accountEntityId: e.id,
        currency,
        amount,
        functionalAmount: amount,
        fxRate: null,
        memo: description,
      });
    line(req.payFromAccountId, -total);
    for (const [account, amount] of by) if (amount !== 0n) line(account, amount);
    const entry: JournalEntryDraft = {
      entityId: e.id,
      functionalCurrency: currency,
      entryDate: req.paidOn,
      kind: 'standard',
      description,
      postings,
    };
    const first = [...by.keys()][0]!;
    const spec: TransactionSpec = {
      type: 'standard',
      accountId: req.payFromAccountId,
      amount: String(-total),
      currency: e.currency,
      description,
      memberId: null,
      uncategorized: false,
      splits: [{ accountId: first, amount: String(-total), memberId: null }],
      payrollDepositId: depositId,
    };
    const transactionId = newId();
    await trx
      .insertInto('app.transaction')
      .values({
        workspace_id: ctx.workspaceId,
        id: transactionId,
        primary_entity_id: e.id,
        txn_date: req.paidOn,
        payee_raw: names.payee,
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
    return transactionId;
  }
}

// ----- Pure helpers --------------------------------------------------------------------------------------------------

function settingsDto(entityId: string, row: PayrollSettingsRow | undefined): PayrollSettingsDto {
  const year = Number(new Date().toISOString().slice(0, 4));
  const t = payrollTaxYear(year) ?? Object.values(PAYROLL_TAX_TABLES).at(-1)!;
  return {
    entityId,
    ein: row?.ein ?? null,
    caEmployerAccount: row?.ca_employer_account ?? null,
    caUiRate: row?.ca_ui_rate_ppm != null ? ppmToPercent(row.ca_ui_rate_ppm) : null,
    caUiRateDefault: ppmToPercent(t.california.newEmployerUiRate),
    caEttRate: ppmToPercent(row?.ca_ett_rate_ppm ?? Number(t.california.ettRate)),
    federalDepositSchedule: row?.federal_deposit_schedule ?? 'monthly',
    caDepositSchedule: row?.ca_deposit_schedule ?? 'quarterly',
    taxYears: Object.keys(PAYROLL_TAX_TABLES).map(Number),
    filingAddress:
      row?.filing_line1 && row.filing_city && row.filing_state && row.filing_zip
        ? {
            line1: row.filing_line1,
            line2: row.filing_line2,
            city: row.filing_city,
            state: row.filing_state,
            zip: row.filing_zip,
          }
        : null,
    ssaUserId: row?.ssa_user_id ?? null,
    contactName: row?.contact_name ?? null,
    contactPhone: row?.contact_phone ?? null,
    contactEmail: row?.contact_email ?? null,
    version: row ? Number(row.version) : 0,
  };
}

function depositDto(d: PayrollDepositRow): PayrollDepositDto {
  const parts = (typeof d.parts === 'string' ? JSON.parse(d.parts) : d.parts) as Record<string, string>;
  return {
    id: d.id,
    entityId: d.entity_id,
    tax: d.tax,
    periodStart: dateOf(d.period_start),
    periodEnd: dateOf(d.period_end),
    dueDate: dateOf(d.due_date),
    paidOn: dateOf(d.paid_on),
    amount: String(d.amount_minor),
    parts,
    payFromAccountId: d.pay_from_account_id,
    transactionId: d.transaction_id,
    confirmation: d.confirmation,
  };
}

async function bankAccount(trx: Trx, ctx: Ctx, entityId: string, accountId: string): Promise<void> {
  const a = await trx
    .selectFrom('app.ledger_account as a')
    .innerJoin('app.bank_account as b', (j) =>
      j.onRef('b.workspace_id', '=', 'a.workspace_id').onRef('b.ledger_account_id', '=', 'a.id'),
    )
    .select(['a.entity_id', 'b.kind'])
    .where('a.workspace_id', '=', ctx.workspaceId)
    .where('a.id', '=', accountId)
    .executeTakeFirst();
  if (!a || a.entity_id !== entityId || !['checking', 'savings', 'cash'].includes(a.kind)) {
    throw unprocessable(
      'payroll.pay_from_account',
      'Pay from a checking, savings or cash account of this business',
    );
  }
}

/** Each paycheck's wage bases, keyed by the check, worked out per person in pay-date order. */
export function basesFor(checks: PaidCheck[], year: number): Map<PaidCheck, Bases> {
  const t = payrollTaxYear(year);
  const out = new Map<PaidCheck, Bases>();
  const ytd = new Map<string, bigint>();
  for (const c of checks) {
    const before = ytd.get(c.personId) ?? 0n;
    const employment = employmentTaxWages(c.wages);
    ytd.set(c.personId, before + employment);
    const addl = t
      ? (before + employment > t.fica.addlMedicareThreshold
          ? before + employment - t.fica.addlMedicareThreshold
          : 0n) - (before > t.fica.addlMedicareThreshold ? before - t.fica.addlMedicareThreshold : 0n)
      : 0n;
    out.set(c, {
      income: incomeTaxWages(c.wages),
      employment,
      ss: t ? underWageBase(employment, before, t.fica.ssWageBase) : employment,
      addlMedicare: addl,
      futa: t ? underWageBase(employment, before, t.futa.wageBase) : employment,
      caUi: t ? underWageBase(employment, before, t.california.uiWageBase) : employment,
    });
  }
  return out;
}

const total = (checks: PaidCheck[], f: (c: PaidCheck) => bigint): bigint =>
  checks.reduce((a, c) => a + f(c), 0n);
const amountLine = (line: string, label: string, amount: bigint, rate?: string): WorksheetLineDto => ({
  line,
  label,
  amount: String(amount),
  ...(rate !== undefined && { rate }),
});
const countLine = (line: string, label: string, count: number): WorksheetLineDto => ({
  line,
  label,
  amount: null,
  count,
});

/** People paid for a pay period that includes the 12th of a month. */
const paidOnThe12th = (checks: PaidCheck[], year: number, month: number): number => {
  const d = fromParts(year, month, 12);
  return new Set(checks.filter((c) => c.periodStart <= d && c.periodEnd >= d).map((c) => c.personId)).size;
};

const depositsOf = (deposits: PayrollDepositRow[], tax: PayrollTaxKind): bigint =>
  deposits.filter((d) => d.tax === tax).reduce((a, d) => a + BigInt(d.amount_minor), 0n);

function creditReduction(checks: PaidCheck[], t: NonNullable<ReturnType<typeof payrollTaxYear>>): bigint {
  const bases = basesFor(checks, t.year);
  let out = 0n;
  for (const [state, r] of Object.entries(t.futa.creditReduction)) {
    const wages = total(
      checks.filter((c) => c.workState === state),
      (c) => bases.get(c)!.futa,
    );
    out += applyRate(wages, r.rate);
  }
  return out;
}

const FICA_CODES = ['ss', 'medicare', 'addl_medicare', 'ss_er', 'medicare_er'];
const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

function form941(
  checks: PaidCheck[],
  bases: Map<PaidCheck, Bases>,
  deposits: PayrollDepositRow[],
  row: PayrollSettingsRow | undefined,
  year: number,
  q: number,
) {
  const b = (f: (x: Bases) => bigint) => total(checks, (c) => f(bases.get(c)!));
  const ss = b((x) => x.ss);
  const medicare = b((x) => x.employment);
  const addl = b((x) => x.addlMedicare);
  const fit = total(checks, (c) => c.taxes.get('fit') ?? 0n);
  const ssTax = applyRate(ss, 124_000n);
  const medicareTax = applyRate(medicare, 29_000n);
  const addlTax = applyRate(addl, 9_000n);
  const line5e = ssTax + medicareTax + addlTax;
  const line6 = fit + line5e;
  const withheld = total(checks, (c) => sum(c.taxes, FICA_CODES));
  const line7 = withheld - line5e;
  const line10 = line6 + line7;
  const paid = depositsOf(deposits, 'federal_941');
  const lines: WorksheetLineDto[] = [
    countLine(
      '1',
      'Employees who received pay for the pay period including the 12th of the third month',
      paidOnThe12th(checks, year, q * 3),
    ),
    amountLine(
      '2',
      'Wages, tips, and other compensation',
      b((x) => x.income),
    ),
    amountLine('3', 'Federal income tax withheld from wages', fit),
    amountLine('5a', 'Taxable social security wages', ss),
    amountLine('5a col 2', 'Social security tax (× 0.124)', ssTax, '12.4'),
    amountLine('5c', 'Taxable Medicare wages and tips', medicare),
    amountLine('5c col 2', 'Medicare tax (× 0.029)', medicareTax, '2.9'),
    amountLine('5d', 'Wages subject to Additional Medicare Tax withholding', addl),
    amountLine('5d col 2', 'Additional Medicare Tax (× 0.009)', addlTax, '0.9'),
    amountLine('5e', 'Total social security and Medicare taxes', line5e),
    amountLine('6', 'Total taxes before adjustments', line6),
    amountLine('7', 'Current quarter’s adjustment for fractions of cents', line7),
    amountLine('10', 'Total taxes after adjustments', line10),
    amountLine('12', 'Total taxes after adjustments and nonrefundable credits', line10),
    amountLine('13', 'Total deposits for this quarter', paid),
    amountLine('14', 'Balance due', line10 > paid ? line10 - paid : 0n),
    amountLine('15', 'Overpayment', paid > line10 ? paid - line10 : 0n),
  ];
  const liability = (c: PaidCheck) => (c.taxes.get('fit') ?? 0n) + sum(c.taxes, FICA_CODES);
  const semiweekly = (row?.federal_deposit_schedule ?? 'monthly') === 'semiweekly';
  const liabilities = semiweekly
    ? [...new Set(checks.map((c) => c.payDate))].map((d) => ({
        label: d,
        amount: String(
          total(
            checks.filter((c) => c.payDate === d),
            liability,
          ),
        ),
      }))
    : [0, 1, 2].map((i) => {
        const m = (q - 1) * 3 + i + 1;
        return {
          label: MONTHS[m - 1]!,
          amount: String(
            total(
              checks.filter((c) => Number(c.payDate.slice(5, 7)) === m),
              liability,
            ),
          ),
        };
      });
  return {
    form: '941' as const,
    dueDate: quarterlyDue(year, q),
    lines,
    liabilities,
  };
}

function form940(
  checks: PaidCheck[],
  bases: Map<PaidCheck, Bases>,
  deposits: PayrollDepositRow[],
  t: ReturnType<typeof payrollTaxYear>,
  year: number,
  notes: string[],
) {
  const payments = total(checks, (c) => c.wages.gross);
  const exempt = total(checks, (c) => c.wages.section125);
  const futaWages = total(checks, (c) => bases.get(c)!.futa);
  const employment = total(checks, (c) => bases.get(c)!.employment);
  const over = employment - futaWages;
  const line8 = applyRate(futaWages, t?.futa.netRate ?? 6_000n);
  const line11 = t ? creditReduction(checks, t) : 0n;
  const line12 = line8 + line11;
  const paid = depositsOf(deposits, 'federal_940');
  const states = [...new Set(checks.map((c) => c.workState).filter(Boolean))].join(', ');
  for (const [state, r] of Object.entries(t?.futa.creditReduction ?? {})) {
    if (r.provisional && checks.some((c) => c.workState === state)) {
      notes.push(
        `${state}’s ${year} FUTA credit reduction of ${ppmToPercent(r.rate)}% is the Department of Labor’s provisional figure. Check the final rate before filing.`,
      );
    }
  }
  const lines: WorksheetLineDto[] = [
    { line: '1a', label: `State where you paid state unemployment tax: ${states || '—'}`, amount: null },
    amountLine('3', 'Total payments to all employees', payments),
    amountLine('4', 'Payments exempt from FUTA tax (cafeteria plan)', exempt),
    amountLine('5', 'Total of payments made to each employee in excess of $7,000', over),
    amountLine('6', 'Subtotal (line 4 + line 5)', exempt + over),
    amountLine('7', 'Total taxable FUTA wages', futaWages),
    amountLine('8', 'FUTA tax before adjustments (× 0.006)', line8, '0.6'),
    amountLine('11', 'Credit reduction (Schedule A)', line11),
    amountLine('12', 'Total FUTA tax after adjustments', line12),
    amountLine('13', 'FUTA tax deposited for the year', paid),
    amountLine('14', 'Balance due', line12 > paid ? line12 - paid : 0n),
    amountLine('15', 'Overpayment', paid > line12 ? paid - line12 : 0n),
  ];
  const liabilities = [1, 2, 3, 4].map((q) => ({
    label: `Quarter ${q}`,
    amount: String(
      total(
        checks.filter((c) => quarterOf(c.payDate) === q),
        (c) => c.taxes.get('futa') ?? 0n,
      ) + (q === 4 ? line11 : 0n),
    ),
  }));
  return { form: '940' as const, dueDate: quarterlyDue(year, 4), lines, liabilities };
}

function formDe9(
  checks: PaidCheck[],
  bases: Map<PaidCheck, Bases>,
  deposits: PayrollDepositRow[],
  row: PayrollSettingsRow | undefined,
  t: ReturnType<typeof payrollTaxYear>,
  year: number,
  q: number,
  notes: string[],
) {
  const uiRate =
    row?.ca_ui_rate_ppm != null ? BigInt(row.ca_ui_rate_ppm) : (t?.california.newEmployerUiRate ?? 0n);
  const ettRate = BigInt(row?.ca_ett_rate_ppm ?? Number(t?.california.ettRate ?? 1000n));
  const subject = total(checks, (c) => bases.get(c)!.employment);
  const uiWages = total(checks, (c) => bases.get(c)!.caUi);
  const ui = applyRate(uiWages, uiRate);
  const ett = applyRate(uiWages, ettRate);
  const sdi = total(checks, (c) => c.taxes.get('ca_sdi') ?? 0n);
  const pit = total(checks, (c) => c.taxes.get('ca_pit') ?? 0n);
  const subtotal = ui + ett + sdi + pit;
  const paid = depositsOf(deposits, 'ca_pit_sdi') + depositsOf(deposits, 'ca_ui_ett');
  const onChecks = total(checks, (c) => (c.taxes.get('ca_ui') ?? 0n) + (c.taxes.get('ca_ett') ?? 0n));
  if (onChecks !== ui + ett) {
    notes.push(
      'The UI and ETT on the paychecks differ from the rate times taxable wages; the DE 9 uses the rate.',
    );
  }
  if (row?.ca_ui_rate_ppm == null) notes.push('No UI rate is entered, so the new-employer rate is used.');
  const lines: WorksheetLineDto[] = [
    amountLine('C', 'Total subject wages paid this quarter', subject),
    amountLine('D(1)', 'UI taxable wages for the quarter', uiWages),
    amountLine('D(2)', 'UI contributions (rate × UI taxable wages)', ui, ppmToPercent(uiRate)),
    amountLine('E', 'ETT contributions (rate × UI taxable wages)', ett, ppmToPercent(ettRate)),
    amountLine(
      'F',
      'SDI employee contributions withheld',
      sdi,
      t ? ppmToPercent(t.california.sdiRate) : undefined,
    ),
    amountLine('G', 'California PIT withheld', pit),
    amountLine('H', 'Subtotal (D(2) + E + F + G)', subtotal),
    amountLine('I', 'Less contributions and withholdings paid for the quarter', paid),
    amountLine('J', 'Total taxes due', subtotal > paid ? subtotal - paid : 0n),
    amountLine('K', 'Overpaid', paid > subtotal ? paid - subtotal : 0n),
  ];
  return { form: 'DE 9' as const, dueDate: quarterlyDue(year, q), lines, liabilities: [] };
}

function formDe9c(checks: PaidCheck[], bases: Map<PaidCheck, Bases>, year: number, q: number) {
  const people = [...new Set(checks.map((c) => c.personId))];
  const employees = people.map((id) => {
    const mine = checks.filter((c) => c.personId === id);
    const first = mine[0]!;
    return {
      personId: id,
      name: first.personName,
      tinMasked: first.tinLast4 ? `•••-••-${first.tinLast4}` : null,
      subjectWages: String(total(mine, (c) => bases.get(c)!.employment)),
      pitWages: String(total(mine, (c) => bases.get(c)!.income)),
      pitWithheld: String(total(mine, (c) => c.taxes.get('ca_pit') ?? 0n)),
    };
  });
  const lines: WorksheetLineDto[] = [0, 1, 2].map((i) =>
    countLine(
      `B${i + 1}`,
      `Employees in the pay period including the 12th of ${MONTHS[(q - 1) * 3 + i]}`,
      paidOnThe12th(checks, year, (q - 1) * 3 + i + 1),
    ),
  );
  lines.push(
    amountLine(
      'Total',
      'Total subject wages',
      total(checks, (c) => bases.get(c)!.employment),
    ),
  );
  lines.push(
    amountLine(
      'Total',
      'Total PIT withheld',
      total(checks, (c) => c.taxes.get('ca_pit') ?? 0n),
    ),
  );
  return { form: 'DE 9C' as const, dueDate: quarterlyDue(year, q), lines, liabilities: [], employees };
}
