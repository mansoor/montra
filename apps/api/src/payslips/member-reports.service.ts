/**
 * Reports by family member (FAM-08, PAY-06, RPT-01). Read models and RLS do the privacy: a viewer who can't read a
 * payslip doesn't get its gross pay or taxes in any total here.
 */
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import {
  addMonths,
  asCurrencyCode,
  calendarDate,
  endOfMonth,
  startOfMonth,
  todayIn,
  withholdingSummary,
  type CalendarDate,
  type PayslipSection,
} from '@montra/domain';
import type { MemberReportDto, PayslipSummaryDto, WithholdingDto } from '@montra/schemas';
import { AppError, notFound } from '../common/errors.js';
import { Db } from '../db/database.js';

type Ctx = { workspaceId: string; userId: string };

const ZERO = '00000000-0000-0000-0000-000000000000';

@Injectable()
export class MemberReportsService {
  constructor(@Inject(Db) private readonly db: Db) {}

  /**
   * Income and spending per member, with Household as its own group (FAM-08). Whole months, because that's what the
   * read model holds. Payroll taxes and deductions aren't spending: they're in income's gross-to-net, in PAY-06.
   */
  async byMember(
    ctx: Ctx,
    opts: { from?: CalendarDate; to?: CalendarDate; entityId?: string },
  ): Promise<MemberReportDto> {
    return this.db.run(ctx, async (trx) => {
      const ws = await trx
        .selectFrom('app.workspace')
        .select(['base_currency', 'time_zone'])
        .where('id', '=', ctx.workspaceId)
        .executeTakeFirstOrThrow();
      const today = todayIn(ws.time_zone);
      const from = startOfMonth(opts.from ?? calendarDate(`${today.slice(0, 4)}-01-01`));
      const to = endOfMonth(opts.to ?? today);
      const rows = await trx
        .selectFrom('app.category_activity_monthly as m')
        .innerJoin('app.ledger_account as a', 'a.id', 'm.ledger_account_id')
        .leftJoin('app.category_group as g', 'g.id', 'a.category_group_id')
        .select([
          'm.member_key',
          'm.ledger_account_id',
          'm.month',
          'a.name',
          'a.type',
          'g.name as group_name',
          'g.kind',
        ])
        .select((eb) => eb.fn.sum<string>('m.activity_minor').as('v'))
        .where('m.workspace_id', '=', ctx.workspaceId)
        .where('m.month', '>=', from)
        .where('m.month', '<=', to)
        .where('a.is_category', '=', true)
        .$if(!!opts.entityId, (q) => q.where('m.entity_id', '=', opts.entityId!))
        .groupBy(['m.member_key', 'm.ledger_account_id', 'm.month', 'a.name', 'a.type', 'g.name', 'g.kind'])
        .execute();
      const family = await trx
        .selectFrom('app.family_member')
        .select(['id', 'name'])
        .where('workspace_id', '=', ctx.workspaceId)
        .execute();
      const names = new Map(family.map((f) => [f.id, f.name]));
      const months: CalendarDate[] = [];
      for (let m = from; m <= to; m = addMonths(m, 1)) months.push(m);

      interface Totals {
        income: bigint;
        spending: bigint;
        categories: Map<string, { name: string; group: string | null; amount: bigint }>;
        months: Map<string, { income: bigint; spending: bigint }>;
      }
      const totals = new Map<string, Totals>();
      for (const r of rows) {
        const key = r.member_key;
        const t = totals.get(key) ?? { income: 0n, spending: 0n, categories: new Map(), months: new Map() };
        totals.set(key, t);
        const v = BigInt(r.v);
        const month = String(r.month);
        const mt = t.months.get(month) ?? { income: 0n, spending: 0n };
        t.months.set(month, mt);
        if (r.type === 'income') {
          t.income -= v;
          mt.income -= v;
        } else if (r.type === 'expense' && r.kind !== 'system') {
          t.spending += v;
          mt.spending += v;
          const c = t.categories.get(r.ledger_account_id) ?? {
            name: r.name,
            group: r.group_name,
            amount: 0n,
          };
          c.amount += v;
          t.categories.set(r.ledger_account_id, c);
        }
      }
      const allSpending = [...totals.values()].reduce((s, t) => s + t.spending, 0n);
      const members = [...totals.entries()]
        .map(([key, t]) => ({
          memberId: key === ZERO ? null : key,
          name: key === ZERO ? 'Household' : (names.get(key) ?? 'Unknown'),
          income: String(t.income),
          spending: String(t.spending),
          spendingShare: allSpending > 0n ? Number((t.spending * 1000n) / allSpending) / 10 : 0,
          categories: [...t.categories.entries()]
            .map(([categoryId, c]) => ({
              categoryId,
              name: c.name,
              group: c.group,
              amount: String(c.amount),
            }))
            .sort((a, b) =>
              BigInt(b.amount) > BigInt(a.amount) ? 1 : BigInt(b.amount) < BigInt(a.amount) ? -1 : 0,
            ),
          months: months.map((month) => {
            const mt = t.months.get(month);
            return { month, income: String(mt?.income ?? 0n), spending: String(mt?.spending ?? 0n) };
          }),
        }))
        // Household first, then members by name.
        .sort((a, b) => (a.memberId === null ? -1 : b.memberId === null ? 1 : a.name.localeCompare(b.name)));
      return { from, to, currency: asCurrencyCode(ws.base_currency), members };
    });
  }

  /** PAY-06: gross vs net, taxes, retirement and effective rate, this year so far against the same span last year. */
  async payslipSummary(ctx: Ctx, memberId: string, year?: number): Promise<PayslipSummaryDto> {
    return this.db.run(ctx, async (trx) => {
      const member = await trx
        .selectFrom('app.family_member')
        .select(['id', 'name'])
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', memberId)
        .executeTakeFirst();
      if (!member) throw notFound('Family member');
      // An empty report would read as "no payslips", which is itself something this viewer may not know (PAY-09).
      const { rows: can } = await sql<{
        ok: boolean;
      }>`select app.can_read_restricted(${memberId}) as ok`.execute(trx);
      if (!can[0]?.ok)
        throw new AppError(403, 'forbidden', 'Only owners and this member can see their payslips');
      const ws = await trx
        .selectFrom('app.workspace')
        .select(['base_currency', 'time_zone'])
        .where('id', '=', ctx.workspaceId)
        .executeTakeFirstOrThrow();
      const today = todayIn(ws.time_zone);
      const y = year ?? Number(today.slice(0, 4));
      // A past year reports the whole year; this year reports to today, and last year to the same day.
      const through = calendarDate(y === Number(today.slice(0, 4)) ? today : `${y}-12-31`);
      const span = async (start: string, end: string) => {
        const slips = await trx
          .selectFrom('app.payslip')
          .select(['id', 'net_minor'])
          .where('workspace_id', '=', ctx.workspaceId)
          .where('member_id', '=', memberId)
          .where('status', '=', 'posted')
          .where('pay_date', '>=', start)
          .where('pay_date', '<=', end)
          .execute();
        const lines = slips.length
          ? await trx
              .selectFrom('app.payslip_line')
              .select(['payslip_id', 'section', 'code', 'label', 'amount_minor'])
              .where('workspace_id', '=', ctx.workspaceId)
              .where(
                'payslip_id',
                'in',
                slips.map((s) => s.id),
              )
              .execute()
          : [];
        return { slips, lines };
      };
      const thisYear = await span(`${y}-01-01`, through);
      const prior = await span(`${y - 1}-01-01`, addMonths(through, -12));
      const byCode = new Map<string, { label: string; amount: bigint }>();
      for (const l of thisYear.lines.filter((x) => x.section === 'tax')) {
        const c = byCode.get(l.code) ?? { label: l.label, amount: 0n };
        c.amount += BigInt(l.amount_minor);
        byCode.set(l.code, c);
      }
      return {
        memberId,
        name: member.name,
        currency: asCurrencyCode(ws.base_currency),
        year: y,
        through,
        ytd: summarize(thisYear),
        priorYear: summarize(prior),
        byTax: [...byCode.entries()].map(([code, c]) => ({ code, label: c.label, amount: String(c.amount) })),
      };
    });
  }
}

function summarize(s: {
  slips: { id: string; net_minor: unknown }[];
  lines: { payslip_id: string; section: string; code: string; amount_minor: unknown }[];
}): WithholdingDto {
  const w = withholdingSummary(
    s.slips.map((p) => ({
      net: BigInt(p.net_minor as bigint),
      lines: s.lines
        .filter((l) => l.payslip_id === p.id)
        .map((l) => ({
          section: l.section as PayslipSection,
          code: l.code,
          amount: BigInt(l.amount_minor as bigint),
        })),
    })),
  );
  return {
    payslips: s.slips.length,
    gross: String(w.gross),
    net: String(w.net),
    taxes: String(w.taxes),
    preTax: String(w.preTax),
    postTax: String(w.postTax),
    retirement: String(w.retirement),
    employer: String(w.employer),
    effectiveRateBps: w.effectiveRateBps,
  };
}
