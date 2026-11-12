/**
 * Reimbursement requests (PRL-11; ADR-0034 §8). Someone who can write to the business submits one for an employee or
 * contractor with the receipt, and it's approved or declined. An employee's is paid on the next pay run as an untaxed
 * line; a contractor's becomes a bill to their vendor record. Paid is worked out from that run or bill.
 */
import { Inject, Injectable } from '@nestjs/common';
import { newId, type ReimbursementRow, type Trx } from '@montra/db';
import { calendarDate, todayIn } from '@montra/domain';
import type {
  CreateReimbursementRequest,
  DecideReimbursementRequest,
  ReimbursementDto,
  ReimbursementStatus,
} from '@montra/schemas';
import { AppError, notFound, unprocessable } from '../common/errors.js';
import { Db } from '../db/database.js';
import { STORAGE_PORT, type StoragePort } from '../storage/storage.js';
import { businessEntity } from '../business/shared.js';
import { PayRunsService } from './pay-runs.service.js';
import { conflict, payrollEntity, personName, type Ctx } from './shared.js';

const dateOf = (v: unknown) => calendarDate(String(v).slice(0, 10));

@Injectable()
export class ReimbursementsService {
  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(STORAGE_PORT) private readonly storage: StoragePort,
    @Inject(PayRunsService) private readonly runs: PayRunsService,
  ) {}

  async list(
    ctx: Ctx,
    q: { entityId: string; status?: ReimbursementStatus; personId?: string },
  ): Promise<ReimbursementDto[]> {
    return this.db.run(ctx, async (trx) => {
      await businessEntity(trx, ctx, q.entityId);
      const rows = await trx
        .selectFrom('app.reimbursement')
        .selectAll()
        .where('workspace_id', '=', ctx.workspaceId)
        .where('entity_id', '=', q.entityId)
        .$if(!!q.personId, (x) => x.where('person_id', '=', q.personId!))
        .orderBy('created_at', 'desc')
        .limit(500)
        .execute();
      const out = await this.dtos(trx, ctx, rows);
      return q.status ? out.filter((r) => r.status === q.status) : out;
    });
  }

  async get(ctx: Ctx, id: string): Promise<ReimbursementDto> {
    return this.db.run(ctx, async (trx) => (await this.dtos(trx, ctx, [await this.row(trx, ctx, id)]))[0]!);
  }

  async create(ctx: Ctx, req: CreateReimbursementRequest): Promise<ReimbursementDto> {
    return this.db.run(ctx, (trx) => this.createIn(trx, ctx, req));
  }

  async createIn(trx: Trx, ctx: Ctx, req: CreateReimbursementRequest): Promise<ReimbursementDto> {
    const e = await payrollEntity(trx, ctx, req.entityId);
    const person = await trx
      .selectFrom('app.payroll_person')
      .selectAll()
      .where('workspace_id', '=', ctx.workspaceId)
      .where('entity_id', '=', req.entityId)
      .where('id', '=', req.personId)
      .executeTakeFirst();
    if (!person) throw notFound('Person');
    const category = await trx
      .selectFrom('app.ledger_account')
      .select(['id', 'type', 'is_category'])
      .where('workspace_id', '=', ctx.workspaceId)
      .where('entity_id', '=', req.entityId)
      .where('id', '=', req.expenseAccountId)
      .executeTakeFirst();
    if (!category || category.type !== 'expense' || !category.is_category) {
      throw unprocessable('payroll.reimbursement_category', 'Choose an expense category of this business');
    }
    const files = [...new Set(req.fileIds)];
    if (files.length) {
      const found = await trx
        .selectFrom('app.file')
        .select(['id', 'sealed'])
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', 'in', files)
        .where('deleted_at', 'is', null)
        .execute();
      if (found.length !== files.length || found.some((f) => f.sealed)) {
        throw unprocessable('payroll.file_not_found', 'Upload the receipt first');
      }
    }
    if (req.spentOn > todayIn(e.timeZone)) {
      throw unprocessable('payroll.reimbursement_future', 'The spending date is in the future');
    }
    const row = await trx
      .insertInto('app.reimbursement')
      .values({
        workspace_id: ctx.workspaceId,
        id: newId(),
        entity_id: req.entityId,
        person_id: person.id,
        person_name: personName(person),
        spent_on: req.spentOn,
        description: req.description,
        amount_minor: BigInt(req.amount),
        currency: e.currency,
        expense_account_id: req.expenseAccountId,
        file_ids: files,
        created_by: ctx.userId,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return (await this.dtos(trx, ctx, [row]))[0]!;
  }

  async decide(ctx: Ctx, id: string, req: DecideReimbursementRequest): Promise<ReimbursementDto> {
    return this.db.run(ctx, (trx) => this.decideIn(trx, ctx, id, req));
  }

  async decideIn(trx: Trx, ctx: Ctx, id: string, req: DecideReimbursementRequest): Promise<ReimbursementDto> {
    const r = await this.row(trx, ctx, id);
    const e = await payrollEntity(trx, ctx, r.entity_id);
    if (BigInt(r.version) !== BigInt(req.version)) throw conflict();
    if (r.status !== 'submitted') {
      throw new AppError(409, 'payroll.reimbursement_decided', 'This reimbursement has already been decided');
    }
    if (req.decision === 'decline') {
      await trx
        .updateTable('app.reimbursement')
        .set({
          status: 'declined',
          decided_by: ctx.userId,
          decided_at: new Date(),
          decline_reason: req.reason || null,
        })
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', id)
        .execute();
      return (await this.dtos(trx, ctx, [await this.row(trx, ctx, id)]))[0]!;
    }
    const person = await trx
      .selectFrom('app.payroll_person')
      .select(['kind', 'vendor_party_id'])
      .where('workspace_id', '=', ctx.workspaceId)
      .where('id', '=', r.person_id)
      .executeTakeFirstOrThrow();
    let billId: string | null = null;
    if (person.kind === 'contractor') {
      if (!person.vendor_party_id) {
        throw unprocessable('payroll.no_vendor', 'This contractor has no vendor record to bill');
      }
      const today = todayIn(e.timeZone);
      billId = newId();
      await trx
        .insertInto('app.bill')
        .values({
          workspace_id: ctx.workspaceId,
          id: billId,
          entity_id: r.entity_id,
          party_id: person.vendor_party_id,
          reference: 'Reimbursement',
          bill_date: today,
          due_date: today,
          currency: r.currency,
          amount_minor: BigInt(r.amount_minor),
          expense_account_id: r.expense_account_id,
          notes: r.description,
          attachment_ids: r.file_ids,
          created_by: ctx.userId,
        })
        .execute();
    }
    await trx
      .updateTable('app.reimbursement')
      .set({
        status: 'approved',
        pay_via: person.kind === 'contractor' ? 'bill' : 'pay_run',
        bill_id: billId,
        decided_by: ctx.userId,
        decided_at: new Date(),
      })
      .where('workspace_id', '=', ctx.workspaceId)
      .where('id', '=', id)
      .execute();
    // An employee's joins a draft pay run they're on straight away, so the draft shows it.
    if (person.kind === 'employee') await this.runs.refreshDraftsFor(trx, ctx, r.person_id);
    return (await this.dtos(trx, ctx, [await this.row(trx, ctx, id)]))[0]!;
  }

  /** A receipt, served only through its reimbursement. */
  async file(
    ctx: Ctx,
    id: string,
    fileId: string,
  ): Promise<{ bytes: Uint8Array; mime: string; fileName: string }> {
    return this.db.run(ctx, async (trx) => {
      const r = await this.row(trx, ctx, id);
      if (!r.file_ids.includes(fileId)) throw notFound('File');
      const f = await trx
        .selectFrom('app.file')
        .select(['storage_key', 'mime', 'file_name'])
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', fileId)
        .executeTakeFirst();
      if (!f) throw notFound('File');
      return { bytes: await this.storage.get(f.storage_key), mime: f.mime, fileName: f.file_name };
    });
  }

  private async row(trx: Trx, ctx: Ctx, id: string): Promise<ReimbursementRow> {
    const r = await trx
      .selectFrom('app.reimbursement')
      .selectAll()
      .where('workspace_id', '=', ctx.workspaceId)
      .where('id', '=', id)
      .executeTakeFirst();
    if (!r) throw notFound('Reimbursement');
    return r;
  }

  private async dtos(trx: Trx, ctx: Ctx, rows: ReimbursementRow[]): Promise<ReimbursementDto[]> {
    const fileIds = rows.flatMap((r) => r.file_ids);
    const files = fileIds.length
      ? await trx
          .selectFrom('app.file')
          .select(['id', 'file_name', 'mime'])
          .where('workspace_id', '=', ctx.workspaceId)
          .where('id', 'in', fileIds)
          .execute()
      : [];
    const paycheckIds = rows.filter((r) => r.paycheck_id).map((r) => r.paycheck_id!);
    const runs = paycheckIds.length
      ? await trx
          .selectFrom('app.paycheck as p')
          .innerJoin('app.pay_run as r', (j) =>
            j.onRef('r.workspace_id', '=', 'p.workspace_id').onRef('r.id', '=', 'p.pay_run_id'),
          )
          .select(['p.id', 'r.id as run_id', 'r.status'])
          .where('p.workspace_id', '=', ctx.workspaceId)
          .where('p.id', 'in', paycheckIds)
          .execute()
      : [];
    const billIds = rows.filter((r) => r.bill_id).map((r) => r.bill_id!);
    const bills = billIds.length
      ? await trx
          .selectFrom('app.bill')
          .select(['id', 'status'])
          .where('workspace_id', '=', ctx.workspaceId)
          .where('id', 'in', billIds)
          .execute()
      : [];
    // Readers without access to payroll records see no people; the pay route then tells the kind.
    const kinds = rows.length
      ? await trx
          .selectFrom('app.payroll_person')
          .select(['id', 'kind'])
          .where('workspace_id', '=', ctx.workspaceId)
          .where('id', 'in', [...new Set(rows.map((r) => r.person_id))])
          .execute()
      : [];
    return rows.map((r) => {
      const run = runs.find((x) => x.id === r.paycheck_id);
      const bill = bills.find((b) => b.id === r.bill_id);
      const paid = (run && run.status === 'approved') || bill?.status === 'paid';
      return {
        id: r.id,
        entityId: r.entity_id,
        personId: r.person_id,
        personName: r.person_name,
        personKind:
          kinds.find((k) => k.id === r.person_id)?.kind ?? (r.pay_via === 'bill' ? 'contractor' : 'employee'),
        spentOn: dateOf(r.spent_on),
        description: r.description,
        amount: String(r.amount_minor),
        currency: r.currency,
        expenseAccountId: r.expense_account_id,
        files: r.file_ids.flatMap((id) => {
          const f = files.find((x) => x.id === id);
          return f ? [{ id, fileName: f.file_name, mime: f.mime }] : [];
        }),
        status: paid ? 'paid' : r.status,
        payVia: r.pay_via,
        declineReason: r.decline_reason,
        payRunId: run?.run_id ?? null,
        billId: r.bill_id,
        version: Number(r.version),
      };
    });
  }
}
