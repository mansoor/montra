/**
 * Mortgages (RNT-08, ADR-0018 §6). The schedule is computed from the terms and never stored. A payment posts its parts:
 * principal reduces the loan account, interest goes to Mortgage interest, and escrow to Taxes and Insurance.
 */
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { newId, type LoanRow, type Trx } from '@montra/db';
import {
  accountProfile,
  amortize,
  asCurrencyCode,
  calendarDate,
  monthlyPayment,
  type AmortizationRow,
  type CalendarDate,
} from '@montra/domain';
import type {
  AmortizationRowDto,
  CreateLoanRequest,
  LoanDto,
  LoanPaymentRequest,
  UpdateLoanRequest,
} from '@montra/schemas';
import { PaymentLinks } from '../business/payment-links.service.js';
import { AppError, notFound, unprocessable } from '../common/errors.js';
import { Db } from '../db/database.js';
import { NOT_OWNED, type SplitSpec } from '../transactions/poster.js';
import { PropertiesService } from './properties.service.js';
import { categoryOnLine, rentalEntity, SCH_E, type Ctx } from './shared.js';

const iso = (v: unknown): CalendarDate => calendarDate(String(v).slice(0, 10));

const scheduleOf = (r: LoanRow): AmortizationRow[] =>
  amortize(
    { principal: BigInt(r.principal_minor), rateBps: r.rate_bps, termMonths: r.term_months },
    iso(r.first_payment_date),
  );

@Injectable()
export class LoansService {
  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(PropertiesService) private readonly properties: PropertiesService,
    @Inject(PaymentLinks) private readonly links: PaymentLinks,
  ) {}

  async list(ctx: Ctx, entityId: string): Promise<LoanDto[]> {
    return this.db.run(ctx, async (trx) => {
      await rentalEntity(trx, ctx, entityId);
      const rows = await trx
        .selectFrom('app.loan_schedule')
        .selectAll()
        .where('workspace_id', '=', ctx.workspaceId)
        .where('entity_id', '=', entityId)
        .where('archived_at', 'is', null)
        .orderBy('name')
        .execute();
      const out: LoanDto[] = [];
      for (const r of rows) out.push(await this.dto(trx, ctx, r));
      return out;
    });
  }

  async row(trx: Trx, ctx: Ctx, id: string): Promise<LoanRow> {
    const r = await trx
      .selectFrom('app.loan_schedule')
      .selectAll()
      .where('workspace_id', '=', ctx.workspaceId)
      .where('id', '=', id)
      .executeTakeFirst();
    if (!r) throw notFound('Loan');
    return r;
  }

  async create(ctx: Ctx, req: CreateLoanRequest): Promise<LoanDto> {
    return this.db.run(ctx, async (trx) => {
      const p = await this.properties.row(trx, ctx, req.propertyId);
      const bank = await trx
        .selectFrom('app.bank_account as b')
        .innerJoin('app.ledger_account as a', (j) =>
          j.onRef('a.workspace_id', '=', 'b.workspace_id').onRef('a.id', '=', 'b.ledger_account_id'),
        )
        .select(['b.kind', 'a.entity_id'])
        .where('b.workspace_id', '=', ctx.workspaceId)
        .where('b.ledger_account_id', '=', req.loanAccountId)
        .executeTakeFirst();
      if (!bank || !accountProfile(bank.kind).schedule) {
        throw unprocessable('loan.account', 'Choose a loan or mortgage account');
      }
      if (bank.entity_id !== p.entity_id) {
        throw unprocessable('loan.account', 'The loan account must be in the same portfolio as the property');
      }
      const row = await trx
        .insertInto('app.loan_schedule')
        .values({
          workspace_id: ctx.workspaceId,
          id: newId(),
          entity_id: p.entity_id,
          property_id: p.id,
          loan_account_id: req.loanAccountId,
          name: req.name,
          principal_minor: req.principal,
          rate_bps: req.rateBps,
          term_months: req.termMonths,
          first_payment_date: req.firstPaymentDate,
          escrow_taxes_minor: req.escrowTaxes,
          escrow_insurance_minor: req.escrowInsurance,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      return this.dto(trx, ctx, row);
    });
  }

  async update(ctx: Ctx, id: string, req: UpdateLoanRequest): Promise<LoanDto> {
    return this.db.run(ctx, async (trx) => {
      const r = await this.row(trx, ctx, id);
      if (BigInt(r.version) !== BigInt(req.version)) {
        throw new AppError(409, 'version.conflict', 'Someone else changed this; reload and try again');
      }
      const row = await trx
        .updateTable('app.loan_schedule')
        .set({
          ...(req.name !== undefined ? { name: req.name } : {}),
          ...(req.escrowTaxes !== undefined ? { escrow_taxes_minor: req.escrowTaxes } : {}),
          ...(req.escrowInsurance !== undefined ? { escrow_insurance_minor: req.escrowInsurance } : {}),
          ...(req.archived !== undefined ? { archived_at: req.archived ? new Date() : null } : {}),
        })
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirstOrThrow();
      return this.dto(trx, ctx, row);
    });
  }

  private async paymentsOf(trx: Trx, ctx: Ctx, loanId: string) {
    return trx
      .selectFrom('app.loan_payment')
      .selectAll()
      .where('workspace_id', '=', ctx.workspaceId)
      .where('loan_id', '=', loanId)
      .execute();
  }

  private async dto(trx: Trx, ctx: Ctx, r: LoanRow): Promise<LoanDto> {
    const e = await rentalEntity(trx, ctx, r.entity_id);
    const paid = await this.paymentsOf(trx, ctx, r.id);
    const rows = scheduleOf(r);
    const last = paid.reduce((m, p) => (p.number > m ? p.number : m), 0);
    const payment = monthlyPayment({
      principal: BigInt(r.principal_minor),
      rateBps: r.rate_bps,
      termMonths: r.term_months,
    });
    const escrow = BigInt(r.escrow_taxes_minor) + BigInt(r.escrow_insurance_minor);
    return {
      id: r.id,
      entityId: r.entity_id,
      propertyId: r.property_id,
      loanAccountId: r.loan_account_id,
      name: r.name,
      principal: String(r.principal_minor),
      rateBps: r.rate_bps,
      termMonths: r.term_months,
      firstPaymentDate: iso(r.first_payment_date),
      escrowTaxes: String(r.escrow_taxes_minor),
      escrowInsurance: String(r.escrow_insurance_minor),
      payment: String(payment),
      totalPayment: String(payment + escrow),
      scheduledBalance: String(last === 0 ? BigInt(r.principal_minor) : rows[last - 1]!.balance),
      paymentsMade: paid.length,
      currency: asCurrencyCode(e.currency),
      version: Number(r.version),
    };
  }

  async schedule(ctx: Ctx, id: string): Promise<AmortizationRowDto[]> {
    return this.db.run(ctx, async (trx) => {
      const r = await this.row(trx, ctx, id);
      const paid = new Map((await this.paymentsOf(trx, ctx, id)).map((p) => [p.number, p.transaction_id]));
      const escrow = BigInt(r.escrow_taxes_minor) + BigInt(r.escrow_insurance_minor);
      return scheduleOf(r).map((row) => ({
        number: row.number,
        date: row.date,
        payment: String(row.payment),
        interest: String(row.interest),
        principal: String(row.principal),
        escrow: String(escrow),
        balance: String(row.balance),
        transactionId: paid.get(row.number) ?? null,
      }));
    });
  }

  /** The parts of one payment, all money out, each tagged to the property. */
  private async splitsFor(trx: Trx, ctx: Ctx, r: LoanRow, row: AmortizationRow): Promise<SplitSpec[]> {
    const tags = { memberId: null, propertyId: r.property_id };
    const interest = await categoryOnLine(trx, ctx, r.entity_id, SCH_E.MORTGAGE_INTEREST);
    const splits: SplitSpec[] = [];
    if (row.interest > 0n) splits.push({ accountId: interest, amount: String(-row.interest), ...tags });
    if (row.principal > 0n)
      splits.push({ accountId: r.loan_account_id, amount: String(-row.principal), ...tags });
    if (BigInt(r.escrow_taxes_minor) > 0n) {
      splits.push({
        accountId: await categoryOnLine(trx, ctx, r.entity_id, SCH_E.TAXES),
        amount: String(-BigInt(r.escrow_taxes_minor)),
        ...tags,
      });
    }
    if (BigInt(r.escrow_insurance_minor) > 0n) {
      splits.push({
        accountId: await categoryOnLine(trx, ctx, r.entity_id, SCH_E.INSURANCE),
        amount: String(-BigInt(r.escrow_insurance_minor)),
        ...tags,
      });
    }
    return splits;
  }

  async recordPayment(ctx: Ctx, id: string, req: LoanPaymentRequest): Promise<LoanDto> {
    return this.db.run(ctx, async (trx) => {
      await this.recordPaymentIn(trx, ctx, id, req, 'manual');
      return this.dto(trx, ctx, await this.row(trx, ctx, id));
    });
  }

  async recordPaymentIn(
    trx: Trx,
    ctx: Ctx,
    id: string,
    req: LoanPaymentRequest,
    source: 'auto' | 'manual',
  ): Promise<void> {
    const r = await this.row(trx, ctx, id);
    const e = await rentalEntity(trx, ctx, r.entity_id);
    const row = scheduleOf(r).find((x) => x.number === req.number);
    if (!row) throw unprocessable('loan.number', 'There is no such payment on this schedule');
    const paid = await this.paymentsOf(trx, ctx, id);
    if (paid.some((p) => p.number === req.number)) {
      throw unprocessable('loan.already_paid', 'This payment is already recorded');
    }
    const total = row.payment + BigInt(r.escrow_taxes_minor) + BigInt(r.escrow_insurance_minor);
    const splits = await this.splitsFor(trx, ctx, r, row);
    let transactionId: string;
    let depositSpec: unknown = null;
    if ('transactionId' in req) {
      const t = await trx
        .selectFrom('app.transaction')
        .select('spec')
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', req.transactionId)
        .executeTakeFirst();
      if (!t) throw notFound('Transaction');
      if (BigInt((t.spec as { amount?: string } | null)?.amount ?? '0') !== -total) {
        throw unprocessable('loan.amount', 'The payment must be the amount on the schedule, escrow included');
      }
      const taken = await this.links.takeOver(trx, ctx, req.transactionId, { loanId: id }, splits, {
        sign: -1,
        currency: e.currency,
      });
      transactionId = req.transactionId;
      depositSpec = taken.previous;
    } else {
      transactionId = await this.links.create(trx, ctx, {
        entityId: r.entity_id,
        accountId: req.accountId,
        date: req.date,
        amount: -total,
        currency: e.currency,
        payee: r.name,
        payeeKey: null,
        description: `${r.name} payment ${req.number}`,
        source: 'loan',
        owner: { loanId: id },
        splits,
      });
    }
    await trx
      .insertInto('app.loan_payment')
      .values({
        workspace_id: ctx.workspaceId,
        id: newId(),
        entity_id: r.entity_id,
        loan_id: id,
        number: req.number,
        transaction_id: transactionId,
        source,
        deposit_spec: depositSpec ? JSON.stringify(depositSpec) : null,
      })
      .execute();
  }

  async removePayment(ctx: Ctx, id: string, number: number): Promise<LoanDto> {
    return this.db.run(ctx, async (trx) => {
      const p = await trx
        .selectFrom('app.loan_payment')
        .selectAll()
        .where('workspace_id', '=', ctx.workspaceId)
        .where('loan_id', '=', id)
        .where('number', '=', number)
        .executeTakeFirst();
      if (!p) throw notFound('Payment');
      await trx
        .deleteFrom('app.loan_payment')
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', p.id)
        .execute();
      await this.links.release(trx, ctx, p.transaction_id, p.deposit_spec);
      return this.dto(trx, ctx, await this.row(trx, ctx, id));
    });
  }

  /** Payments due in a range and not yet recorded, for the forecast and calendar. */
  async dueBetween(trx: Trx, ctx: Ctx, entityId: string, from: CalendarDate, to: CalendarDate) {
    const rows = await trx
      .selectFrom('app.loan_schedule')
      .selectAll()
      .where('workspace_id', '=', ctx.workspaceId)
      .where('entity_id', '=', entityId)
      .where('archived_at', 'is', null)
      .execute();
    const out: { loanId: string; number: number; date: CalendarDate; amount: bigint; name: string }[] = [];
    for (const r of rows) {
      const paid = new Set((await this.paymentsOf(trx, ctx, r.id)).map((p) => p.number));
      const escrow = BigInt(r.escrow_taxes_minor) + BigInt(r.escrow_insurance_minor);
      for (const row of scheduleOf(r)) {
        if (row.date < from) continue;
        if (row.date > to) break;
        if (!paid.has(row.number)) {
          out.push({
            loanId: r.id,
            number: row.number,
            date: row.date,
            amount: row.payment + escrow,
            name: r.name,
          });
        }
      }
    }
    return out;
  }

  /** The next payment within 5 days of a bank line for the exact amount links by itself (design 04 §9). */
  async autoMatch(ctx: Ctx, entityId: string): Promise<number> {
    const plan = await this.db.run(ctx, async (trx) => {
      const loans = await trx
        .selectFrom('app.loan_schedule')
        .selectAll()
        .where('workspace_id', '=', ctx.workspaceId)
        .where('entity_id', '=', entityId)
        .where('archived_at', 'is', null)
        .execute();
      const out: { loanId: string; number: number; transactionId: string }[] = [];
      for (const r of loans) {
        const paid = new Set((await this.paymentsOf(trx, ctx, r.id)).map((p) => p.number));
        const escrow = BigInt(r.escrow_taxes_minor) + BigInt(r.escrow_insurance_minor);
        const next = scheduleOf(r).find((x) => !paid.has(x.number));
        if (!next) continue;
        const total = next.payment + escrow;
        const { rows } = await sql<{ id: string }>`
          select t.id from app.transaction t
           where t.workspace_id = ${ctx.workspaceId} and t.primary_entity_id = ${entityId}
             and t.status = 'posted' and t.deleted_at is null and t.spec->>'type' = 'standard'
             and (t.spec->>'amount')::bigint = ${String(-total)}::bigint
             and abs(t.txn_date - ${next.date}::date) <= 5
             and ${NOT_OWNED}
           limit 2`.execute(trx);
        if (rows.length === 1) out.push({ loanId: r.id, number: next.number, transactionId: rows[0]!.id });
      }
      return out;
    });
    let linked = 0;
    for (const p of plan) {
      await this.db.run(ctx, (trx) =>
        this.recordPaymentIn(
          trx,
          ctx,
          p.loanId,
          { number: p.number, transactionId: p.transactionId },
          'auto',
        ),
      );
      linked++;
    }
    return linked;
  }
}
