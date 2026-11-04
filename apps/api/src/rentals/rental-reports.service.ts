/**
 * Reports per property and portfolio, Schedule E and depreciation (RNT-09, RNT-11, UP-10). All cash basis, read from postings
 * under RLS. Depreciation is a helper added on Schedule E and never posted. Figures are for planning, not tax advice.
 */
import { Inject, Injectable } from '@nestjs/common';
import ExcelJS from 'exceljs';
import { sql } from 'kysely';
import { newId, type Trx } from '@montra/db';
import {
  asCurrencyCode,
  calendarDate,
  capRateBps,
  cashOnCashBps,
  daysBetween,
  depreciationForYear,
  divRound,
  occupancyBps,
  occupiedDays,
  type CalendarDate,
  type DepreciationMethod,
} from '@montra/domain';
import type {
  CreateDepreciationRequest,
  DepreciationDto,
  PortfolioReportDto,
  PropertyReportDto,
  ScheduleEDto,
  ScheduleEExportFormat,
} from '@montra/schemas';
import { notFound } from '../common/errors.js';
import { Db } from '../db/database.js';
import { PropertiesService } from './properties.service.js';
import { rentalEntity, SCH_E, todayOf, type Ctx } from './shared.js';

const iso = (v: unknown): CalendarDate => calendarDate(String(v).slice(0, 10));
const SCHEDULE_E = 'schedule_e';
const COUNTRY = 'US';
const DEBT_LINES = new Set<string>([SCH_E.MORTGAGE_INTEREST, SCH_E.OTHER_INTEREST]);

interface PostingSum {
  property_id: string | null;
  account_id: string;
  name: string;
  type: 'income' | 'expense' | 'asset' | 'liability' | 'equity';
  code: string | null;
  is_category: boolean;
  amount: string;
}

/** Text a spreadsheet would run as a formula gets a leading apostrophe. Names here come from the owner, but may be imported. */
const safeText = (s: string) => (/^[=+\-@\t\r]/.test(s) ? `'${s}` : s);
const csvCell = (s: string) => (/[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

@Injectable()
export class RentalReportsService {
  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(PropertiesService) private readonly properties: PropertiesService,
  ) {}

  private async postingSums(
    trx: Trx,
    ctx: Ctx,
    entityId: string,
    from: CalendarDate,
    to: CalendarDate,
  ): Promise<PostingSum[]> {
    const { rows } = await sql<PostingSum>`
      select p.property_id, a.id as account_id, a.name, a.type, a.tax_line_code as code, a.is_category,
             sum(p.functional_amount_minor)::text as amount
        from app.posting p
        join app.ledger_account a on a.workspace_id = p.workspace_id and a.id = p.ledger_account_id
       where p.workspace_id = ${ctx.workspaceId} and p.entity_id = ${entityId}
         and p.entry_date between ${from} and ${to}
       group by p.property_id, a.id, a.name, a.type, a.tax_line_code, a.is_category`.execute(trx);
    return rows;
  }

  // ----- Portfolio and property reports (RNT-11) -------------------------------------------------------------

  async portfolio(
    ctx: Ctx,
    q: { entityId: string; from?: CalendarDate; to?: CalendarDate },
  ): Promise<PortfolioReportDto> {
    return this.db.run(ctx, async (trx) => {
      const e = await rentalEntity(trx, ctx, q.entityId);
      const today = todayOf(e);
      const from = q.from ?? (`${today.slice(0, 4)}-01-01` as CalendarDate);
      const to = q.to ?? today;
      const sums = await this.postingSums(trx, ctx, q.entityId, from, to);
      const properties = await trx
        .selectFrom('app.property')
        .selectAll()
        .where('workspace_id', '=', ctx.workspaceId)
        .where('entity_id', '=', q.entityId)
        .where('archived_at', 'is', null)
        .orderBy('name')
        .execute();
      const units = await trx
        .selectFrom('app.unit')
        .select(['id', 'property_id'])
        .where('workspace_id', '=', ctx.workspaceId)
        .where('entity_id', '=', q.entityId)
        .where('archived_at', 'is', null)
        .execute();
      const leases = await trx
        .selectFrom('app.lease')
        .select(['unit_id', 'property_id', 'start_date', 'end_date', 'ended_on'])
        .where('workspace_id', '=', ctx.workspaceId)
        .where('entity_id', '=', q.entityId)
        .execute();
      // Accounts that hold capital spending, and loans whose principal is debt service.
      const improvementAccounts = new Set(properties.map((p) => p.improvements_account_id).filter(Boolean));
      const loanAccounts = new Set(
        (
          await trx
            .selectFrom('app.loan_schedule')
            .select('loan_account_id')
            .where('workspace_id', '=', ctx.workspaceId)
            .where('entity_id', '=', q.entityId)
            .execute()
        ).map((l) => l.loan_account_id),
      );
      const occupied = (propertyId: string | null) => {
        const own = units.filter((u) => propertyId === null || u.property_id === propertyId);
        let days = 0;
        for (const u of own) {
          days += occupiedDays(
            leases
              .filter((l) => l.unit_id === u.id)
              .map((l) => ({
                start: iso(l.start_date),
                end: l.ended_on ? iso(l.ended_on) : l.end_date ? iso(l.end_date) : null,
              })),
            from,
            to,
          );
        }
        return { days, units: own.length };
      };
      const span = daysBetween(from, to) + 1;
      const annualize = (v: bigint) => divRound(v * 365n, BigInt(span));

      const build = (
        propertyId: string | null,
        name: string,
        rows: PostingSum[],
        value: bigint | null,
        invested: bigint | null,
        occ: { days: number; units: number },
      ): PropertyReportDto => {
        let income = 0n;
        let opex = 0n;
        let debt = 0n;
        let capex = 0n;
        const lines: PropertyReportDto['lines'] = [];
        for (const r of rows) {
          const amount = BigInt(r.amount);
          if (r.type === 'income') {
            income += -amount;
            lines.push({ categoryId: r.account_id, name: r.name, type: 'income', amount: String(-amount) });
          } else if (r.type === 'expense') {
            if (r.code && DEBT_LINES.has(r.code)) debt += amount;
            else if (r.code !== SCH_E.DEPRECIATION) opex += amount;
            lines.push({ categoryId: r.account_id, name: r.name, type: 'expense', amount: String(amount) });
          } else if (loanAccounts.has(r.account_id)) {
            debt += amount; // a debit: principal paid down
          } else if (improvementAccounts.has(r.account_id)) {
            capex += amount;
          }
        }
        const noi = income - opex;
        const cashFlow = noi - debt - capex;
        return {
          propertyId,
          name,
          units: occ.units,
          currentValue: value !== null ? String(value) : null,
          cashInvested: invested !== null ? String(invested) : null,
          income: String(income),
          operatingExpenses: String(opex),
          noi: String(noi),
          debtService: String(debt),
          capex: String(capex),
          cashFlow: String(cashFlow),
          capRateBps: capRateBps(annualize(noi), value),
          cashOnCashBps: cashOnCashBps(annualize(cashFlow), invested),
          occupancyBps: occupancyBps(occ.days, occ.units, from, to),
          lines: lines.sort((a, b) => a.name.localeCompare(b.name)),
        };
      };

      // A ratio over all the income needs every property's figure: a partial total would overstate it.
      const totalOf = (key: 'current_value_minor' | 'cash_invested_minor') =>
        properties.length === 0 || properties.some((p) => p[key] === null)
          ? null
          : properties.reduce((t, p) => t + BigInt(p[key]!), 0n);
      return {
        entityId: q.entityId,
        from,
        to,
        currency: asCurrencyCode(e.currency),
        portfolio: build(
          null,
          e.name,
          sums,
          totalOf('current_value_minor'),
          totalOf('cash_invested_minor'),
          occupied(null),
        ),
        properties: properties.map((p) =>
          build(
            p.id,
            p.name,
            sums.filter((s) => s.property_id === p.id),
            p.current_value_minor !== null ? BigInt(p.current_value_minor) : null,
            p.cash_invested_minor !== null ? BigInt(p.cash_invested_minor) : null,
            occupied(p.id),
          ),
        ),
        untagged: build(
          null,
          '',
          sums.filter((s) => s.property_id === null),
          null,
          null,
          { days: 0, units: 0 },
        ),
      };
    });
  }

  // ----- Schedule E (RNT-06, UP-10) ----------------------------------------------------------------------------

  async scheduleE(ctx: Ctx, entityId: string, year?: number): Promise<ScheduleEDto> {
    return this.db.run(ctx, (trx) => this.scheduleEIn(trx, ctx, entityId, year));
  }

  private async scheduleEIn(trx: Trx, ctx: Ctx, entityId: string, year?: number): Promise<ScheduleEDto> {
    const e = await rentalEntity(trx, ctx, entityId);
    const y = year ?? Number(todayOf(e).slice(0, 4));
    const from = `${y}-01-01` as CalendarDate;
    const to = `${y}-12-31` as CalendarDate;
    const sums = (await this.postingSums(trx, ctx, entityId, from, to)).filter(
      (s) => s.type === 'income' || s.type === 'expense',
    );
    const refLines = await trx
      .selectFrom('ref.tax_line')
      .selectAll()
      .where('country', '=', COUNTRY)
      .where('form', '=', SCHEDULE_E)
      .orderBy('sort_order')
      .execute();
    const known = new Set(refLines.map((l) => l.code));
    const properties = await trx
      .selectFrom('app.property')
      .selectAll()
      .where('workspace_id', '=', ctx.workspaceId)
      .where('entity_id', '=', entityId)
      .where('archived_at', 'is', null)
      .orderBy('name')
      .execute();
    const schedules = await trx
      .selectFrom('app.depreciation_schedule')
      .selectAll()
      .where('workspace_id', '=', ctx.workspaceId)
      .where('entity_id', '=', entityId)
      .execute();
    const unmapped: ScheduleEDto['unmapped'] = [];
    const groupFor = (
      propertyId: string | null,
      name: string,
      address: string | null,
      type: string | null,
      ownershipBps: number,
    ) => {
      const rows = sums.filter((s) => s.property_id === propertyId);
      const byCode = new Map<string, { amount: bigint; ids: string[] }>();
      let income = 0n;
      let expenses = 0n;
      for (const r of rows) {
        const signed = r.type === 'income' ? -BigInt(r.amount) : BigInt(r.amount);
        if (r.type === 'income') income += signed;
        else expenses += signed;
        if (r.code && known.has(r.code)) {
          const cur = byCode.get(r.code) ?? { amount: 0n, ids: [] };
          cur.amount += signed;
          cur.ids.push(r.account_id);
          byCode.set(r.code, cur);
        } else {
          // Still in the totals: leaving it out would misstate the result.
          const seen = unmapped.find((u) => u.categoryId === r.account_id);
          if (seen) seen.amount = String(BigInt(seen.amount) + signed);
          else unmapped.push({ categoryId: r.account_id, name: r.name, amount: String(signed) });
        }
      }
      const dep = propertyId
        ? schedules
            .filter((d) => d.property_id === propertyId)
            .reduce(
              (t, d) =>
                t +
                depreciationForYear(
                  BigInt(d.basis_minor),
                  iso(d.in_service_date),
                  y,
                  d.method as DepreciationMethod,
                ),
              0n,
            )
        : 0n;
      expenses += dep;
      const lines: ScheduleEDto['properties'][number]['lines'] = [];
      for (const l of refLines) {
        const hit = byCode.get(l.code);
        const helper = l.code === SCH_E.DEPRECIATION && dep > 0n ? dep : null;
        if (!hit && helper === null) continue;
        lines.push({
          code: l.code,
          line: l.line,
          label: l.label,
          amount: String((hit?.amount ?? 0n) + (helper ?? 0n)),
          categoryIds: hit?.ids ?? [],
          depreciation: helper !== null ? String(helper) : null,
        });
      }
      const net = income - expenses;
      return {
        propertyId,
        name,
        address,
        type,
        ownershipBps,
        lines,
        income: String(income),
        expenses: String(expenses),
        net: String(net),
        yourShare: String(divRound(net * BigInt(ownershipBps), 10_000n)),
      };
    };
    const groups = properties.map((p) => groupFor(p.id, p.name, p.address, p.type, p.ownership_bps));
    const rest = groupFor(null, '', null, null, 10000);
    if (rest.lines.length > 0 || BigInt(rest.income) !== 0n || BigInt(rest.expenses) !== 0n)
      groups.push(rest);
    const sum = (k: 'income' | 'expenses' | 'net' | 'yourShare') =>
      String(groups.reduce((t, g) => t + BigInt(g[k]), 0n));
    return {
      entityId,
      year: y,
      currency: asCurrencyCode(e.currency),
      properties: groups,
      unmapped,
      totalIncome: sum('income'),
      totalExpenses: sum('expenses'),
      totalNet: sum('net'),
      totalYourShare: sum('yourShare'),
    };
  }

  /** UP-10: the year's Schedule E as a file, for the owner or their accountant. The full tax package is Phase 10. */
  async exportScheduleE(
    ctx: Ctx,
    entityId: string,
    year: number | undefined,
    format: ScheduleEExportFormat,
  ): Promise<{ bytes: Uint8Array; mime: string; fileName: string }> {
    const s = await this.scheduleE(ctx, entityId, year);
    const dollars = (minor: string) => {
      const v = BigInt(minor);
      const a = v < 0n ? -v : v;
      return `${v < 0n ? '-' : ''}${a / 100n}.${String(a % 100n).padStart(2, '0')}`;
    };
    const table: string[][] = [['Property', 'Address', 'Line', 'Item', 'Amount', 'Your share %']];
    for (const p of s.properties) {
      const name = safeText(p.name || 'Not assigned to a property');
      const share = String(p.ownershipBps / 100);
      for (const l of p.lines) {
        table.push([name, safeText(p.address ?? ''), l.line, l.label, dollars(l.amount), share]);
      }
      table.push([name, '', '', 'Net', dollars(p.net), share]);
    }
    for (const u of s.unmapped)
      table.push(['', '', '', safeText(`No line: ${u.name}`), dollars(u.amount), '']);
    const fileName = `schedule-e-${s.year}.${format}`;
    if (format === 'csv') {
      const text = table.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
      return { bytes: new TextEncoder().encode(text), mime: 'text/csv; charset=utf-8', fileName };
    }
    const wb = new ExcelJS.Workbook();
    const sheet = wb.addWorksheet(`Schedule E ${s.year}`);
    table.forEach((r) => sheet.addRow(r));
    sheet.getRow(1).font = { bold: true };
    [28, 32, 8, 36, 14, 12].forEach((w, i) => {
      sheet.getColumn(i + 1).width = w;
    });
    return {
      bytes: new Uint8Array(await wb.xlsx.writeBuffer()),
      mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      fileName,
    };
  }

  // ----- Depreciation helper (RNT-09) --------------------------------------------------------------------------

  async listDepreciation(ctx: Ctx, propertyId: string, year?: number): Promise<DepreciationDto[]> {
    return this.db.run(ctx, async (trx) => {
      const p = await this.properties.row(trx, ctx, propertyId);
      const e = await rentalEntity(trx, ctx, p.entity_id);
      const y = year ?? Number(todayOf(e).slice(0, 4));
      const rows = await trx
        .selectFrom('app.depreciation_schedule')
        .selectAll()
        .where('workspace_id', '=', ctx.workspaceId)
        .where('property_id', '=', propertyId)
        .orderBy('in_service_date')
        .execute();
      return rows.map((r) => {
        const basis = BigInt(r.basis_minor);
        const start = iso(r.in_service_date);
        const method = r.method as DepreciationMethod;
        let accumulated = 0n;
        for (let cy = Number(start.slice(0, 4)); cy <= y; cy++)
          accumulated += depreciationForYear(basis, start, cy, method);
        return {
          id: r.id,
          propertyId: r.property_id,
          name: r.name,
          basis: String(basis),
          inServiceDate: start,
          method,
          forYear: String(depreciationForYear(basis, start, y, method)),
          accumulated: String(accumulated),
          transactionId: r.transaction_id,
          version: Number(r.version),
        };
      });
    });
  }

  async createDepreciation(ctx: Ctx, req: CreateDepreciationRequest): Promise<{ id: string }> {
    return this.db.run(ctx, async (trx) => {
      const p = await this.properties.row(trx, ctx, req.propertyId);
      const id = newId();
      await trx
        .insertInto('app.depreciation_schedule')
        .values({
          workspace_id: ctx.workspaceId,
          id,
          entity_id: p.entity_id,
          property_id: p.id,
          name: req.name,
          basis_minor: req.basis,
          in_service_date: req.inServiceDate,
          method: req.method,
        })
        .execute();
      return { id };
    });
  }

  async removeDepreciation(ctx: Ctx, id: string): Promise<void> {
    await this.db.run(ctx, async (trx) => {
      const res = await trx
        .deleteFrom('app.depreciation_schedule')
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', id)
        .executeTakeFirst();
      if (!res.numDeletedRows) throw notFound('Depreciation');
    });
  }
}
