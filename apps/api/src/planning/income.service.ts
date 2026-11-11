/** Expected income (BUD-03): entered salaries, business revenue and rent; Phase 7 adds payslip patterns. */
import { Inject, Injectable } from '@nestjs/common';
import type { ExpectedIncomeRow, Trx } from '@montra/db';
import type {
  CreateExpectedIncomeRequest,
  ExpectedIncomeDto,
  UpdateExpectedIncomeRequest,
} from '@montra/schemas';
import { AppError, notFound, unprocessable } from '../common/errors.js';
import { Db } from '../db/database.js';
import { payeeKeyOf } from '../categorization/categorizer.service.js';
import type { Ctx } from './data.js';

@Injectable()
export class IncomeService {
  constructor(@Inject(Db) private readonly db: Db) {}

  async create(ctx: Ctx, req: CreateExpectedIncomeRequest): Promise<ExpectedIncomeDto> {
    return this.db.run(ctx, async (trx) => {
      if (req.accountId) await this.checkAccount(trx, ctx, req.entityId, req.accountId);
      const row = await trx
        .insertInto('app.expected_income')
        .values({
          workspace_id: ctx.workspaceId,
          entity_id: req.entityId,
          member_id: req.memberId,
          name: req.name,
          source_type: req.sourceType,
          amount_minor: req.amount,
          currency: req.currency,
          cadence: req.cadence,
          next_date: req.nextDate,
          account_id: req.accountId,
          payee_key: req.payee ? payeeKey(req.payee) : null,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      return toDto(row);
    });
  }

  async list(ctx: Ctx, entityId?: string): Promise<ExpectedIncomeDto[]> {
    const rows = await this.db.run(ctx, (trx) =>
      trx
        .selectFrom('app.expected_income')
        .selectAll()
        .where('workspace_id', '=', ctx.workspaceId)
        .$if(!!entityId, (q) => q.where('entity_id', '=', entityId!))
        .orderBy('active', 'desc')
        .orderBy('next_date')
        .execute(),
    );
    return rows.map(toDto);
  }

  async update(ctx: Ctx, id: string, req: UpdateExpectedIncomeRequest): Promise<ExpectedIncomeDto> {
    return this.db.run(ctx, async (trx) => {
      const cur = await trx
        .selectFrom('app.expected_income')
        .selectAll()
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', id)
        .executeTakeFirst();
      if (!cur) throw notFound('Expected income');
      if (req.accountId) await this.checkAccount(trx, ctx, cur.entity_id, req.accountId);
      const row = await trx
        .updateTable('app.expected_income')
        .set({
          ...(req.name !== undefined ? { name: req.name } : {}),
          ...(req.memberId !== undefined ? { member_id: req.memberId } : {}),
          ...(req.sourceType !== undefined ? { source_type: req.sourceType } : {}),
          ...(req.amount !== undefined ? { amount_minor: req.amount } : {}),
          ...(req.currency !== undefined ? { currency: req.currency } : {}),
          ...(req.cadence !== undefined ? { cadence: req.cadence } : {}),
          ...(req.nextDate !== undefined ? { next_date: req.nextDate } : {}),
          ...(req.accountId !== undefined ? { account_id: req.accountId } : {}),
          ...(req.payee !== undefined ? { payee_key: req.payee ? payeeKey(req.payee) : null } : {}),
          ...(req.active !== undefined ? { active: req.active } : {}),
        })
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', id)
        .where('version', '=', BigInt(req.version))
        .returningAll()
        .executeTakeFirst();
      if (!row)
        throw new AppError(
          409,
          'version.conflict',
          'This income was changed by someone else; reload and try again',
        );
      return toDto(row);
    });
  }

  private async checkAccount(trx: Trx, ctx: Ctx, entityId: string, accountId: string) {
    const ok = await trx
      .selectFrom('app.bank_account as b')
      .innerJoin('app.ledger_account as a', 'a.id', 'b.ledger_account_id')
      .select('a.id')
      .where('a.workspace_id', '=', ctx.workspaceId)
      .where('a.entity_id', '=', entityId)
      .where('a.id', '=', accountId)
      .where('a.type', '=', 'asset')
      .executeTakeFirst();
    if (!ok) throw unprocessable('income.account', 'Income lands in an asset account of the same entity');
  }
}

/** The payee key used on transactions, so deposits match by payee. */
const payeeKey = (payee: string) => payeeKeyOf(payee);

const toDto = (r: ExpectedIncomeRow): ExpectedIncomeDto => ({
  id: r.id,
  entityId: r.entity_id,
  memberId: r.member_id,
  name: r.name,
  sourceType: r.source_type,
  amount: String(r.amount_minor),
  currency: r.currency as ExpectedIncomeDto['currency'],
  cadence: r.cadence,
  nextDate: r.next_date as ExpectedIncomeDto['nextDate'],
  accountId: r.account_id,
  payee: r.payee_key,
  active: r.active,
  version: Number(r.version),
});
