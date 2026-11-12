/**
 * Linking a bank line to an invoice or bill (BIZ-05, BIZ-06; ADR-0017 §3). The line keeps its date and amount, and its
 * splits become the invoice's or bill's categories. While linked, the invoice or bill owns the transaction; releasing it
 * restores what it was before, or removes it if the payment created it.
 */
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { newId, type Trx } from '@montra/db';
import { calendarDate, type CalendarDate } from '@montra/domain';
import type { PaymentCandidateDto } from '@montra/schemas';
import { notFound, unprocessable } from '../common/errors.js';
import {
  NOT_OWNED,
  TransactionPoster,
  ownerOf,
  type SplitSpec,
  type TransactionSpec,
} from '../transactions/poster.js';
import type { Ctx } from './shared.js';

export type PaymentOwner =
  | { invoiceId: string }
  | { billId: string }
  | { leaseId: string }
  | { depositLeaseId: string }
  | { loanId: string }
  | { assetId: string };

type StandardSpec = Extract<TransactionSpec, { type: 'standard' }>;

@Injectable()
export class PaymentLinks {
  constructor(@Inject(TransactionPoster) private readonly poster: TransactionPoster) {}

  /** Takes over an existing transaction. Returns what's needed to restore it. */
  async takeOver(
    trx: Trx,
    ctx: Ctx,
    transactionId: string,
    owner: PaymentOwner,
    splits: SplitSpec[],
    expected: { sign: 1 | -1; currency: string },
  ): Promise<{ previous: StandardSpec; amount: bigint; date: CalendarDate }> {
    const t = await trx
      .selectFrom('app.transaction')
      .select(['spec', 'source', 'txn_date', 'status'])
      .where('workspace_id', '=', ctx.workspaceId)
      .where('id', '=', transactionId)
      .forUpdate()
      .executeTakeFirst();
    if (!t) throw notFound('Transaction');
    const spec = t.spec as TransactionSpec | null;
    if (t.status !== 'posted' || spec?.type !== 'standard') {
      throw unprocessable('payment.not_applicable', 'This transaction cannot be a payment');
    }
    if (ownerOf(spec)) {
      throw unprocessable('payment.already_linked', 'This transaction already belongs to something else');
    }
    if (spec.currency !== expected.currency) {
      throw unprocessable('currency.mismatch', `This transaction is not in ${expected.currency}`);
    }
    const amount = BigInt(spec.amount) * BigInt(expected.sign);
    if (amount <= 0n) {
      throw unprocessable(
        'payment.wrong_direction',
        expected.sign === 1 ? 'A payment received must be money in' : 'A bill payment must be money out',
      );
    }
    const date = calendarDate(String(t.txn_date));
    const next: StandardSpec = { ...spec, uncategorized: false, splits };
    const built = await this.poster.build(trx, ctx, next, date, transactionId);
    await trx
      .updateTable('app.transaction')
      .set({ spec: JSON.stringify({ ...next, ...owner }), review_state: 'reviewed', categorization: null })
      .where('workspace_id', '=', ctx.workspaceId)
      .where('id', '=', transactionId)
      .execute();
    // A statement line stays cleared when it's taken over (DE-08).
    await this.poster.post(trx, ctx, transactionId, built, {
      ...(t.source === 'import' ? { clearedAccountId: spec.accountId } : {}),
    });
    return { previous: spec, amount, date };
  }

  /** Records a payment that isn't in the books yet. `amount` is signed: positive is money in. */
  async create(
    trx: Trx,
    ctx: Ctx,
    input: {
      entityId: string;
      accountId: string;
      date: CalendarDate;
      amount: bigint;
      currency: string;
      payee: string;
      payeeKey: string | null;
      description: string;
      source: 'invoice' | 'bill' | 'rent' | 'security_deposit' | 'loan' | 'manual';
      owner: PaymentOwner;
      splits: SplitSpec[];
    },
  ): Promise<string> {
    const id = newId();
    const spec: StandardSpec = {
      type: 'standard',
      accountId: input.accountId,
      amount: String(input.amount),
      currency: input.currency,
      description: input.description,
      memberId: null,
      uncategorized: false,
      splits: input.splits,
    };
    const built = await this.poster.build(trx, ctx, spec, input.date, id);
    await trx
      .insertInto('app.transaction')
      .values({
        workspace_id: ctx.workspaceId,
        id,
        primary_entity_id: built.primaryEntityId,
        txn_date: input.date,
        payee_raw: input.payee,
        payee_key: input.payeeKey,
        description: input.description,
        status: 'posted',
        source: input.source,
        review_state: 'reviewed',
        spec: JSON.stringify({ ...spec, ...input.owner }),
        posted_at: new Date(),
        created_by: ctx.userId,
      })
      .execute();
    await this.poster.post(trx, ctx, id, built, { fresh: true });
    return id;
  }

  /** Lets a transaction go: back to what it was, or removed when the payment created it (`previous` null). */
  async release(trx: Trx, ctx: Ctx, transactionId: string, previous: unknown): Promise<void> {
    if (previous) {
      await this.poster.restoreTaken(trx, ctx, transactionId, previous as TransactionSpec);
      return;
    }
    await this.poster.unpost(trx, ctx, transactionId);
    await trx
      .updateTable('app.transaction')
      .set({ status: 'void', deleted_at: new Date() })
      .where('workspace_id', '=', ctx.workspaceId)
      .where('id', '=', transactionId)
      .execute();
  }

  /** Lines that could be this payment, nearest the target date first. Any account: a freelancer may have only one. */
  async candidates(
    trx: Trx,
    ctx: Ctx,
    q: {
      sign: 1 | -1;
      currency: string;
      max: bigint;
      from: CalendarDate;
      to: CalendarDate;
      near: CalendarDate;
    },
  ): Promise<PaymentCandidateDto[]> {
    const { rows } = await sql<{
      id: string;
      d: string;
      amount: string;
      payee: string | null;
      account_id: string;
    }>`
      select t.id, t.txn_date::text as d, abs((t.spec->>'amount')::bigint)::text as amount,
             coalesce(t.payee_raw, t.description) as payee, t.spec->>'accountId' as account_id
        from app.transaction t
       where t.workspace_id = ${ctx.workspaceId}
         and t.status = 'posted' and t.deleted_at is null and t.spec->>'type' = 'standard'
         and t.spec->>'currency' = ${q.currency}
         and (t.spec->>'amount')::bigint * ${q.sign}::bigint between 1 and ${String(q.max)}::bigint
         and t.txn_date between ${q.from} and ${q.to}
         and ${NOT_OWNED}
       order by abs(t.txn_date - ${q.near}::date), t.id
       limit 20`.execute(trx);
    return rows.map((r) => ({
      transactionId: r.id,
      date: calendarDate(r.d),
      amount: r.amount,
      payee: r.payee,
      accountId: r.account_id,
    }));
  }
}
