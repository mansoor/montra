import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { newId, type Trx } from '@montra/db';
import {
  asCurrencyCode,
  naturalBalance,
  type AccountResolver,
  type AccountType,
  type EntityRef,
  type JournalEntryDraft,
  type LedgerAccountRef,
  type SystemRole,
} from '@montra/domain';
import { notFound } from '../common/errors.js';

type CounterpartyRole = Extract<SystemRole, 'inter_entity_clearing' | 'due_to_entity' | 'due_from_entity'>;

const COUNTERPARTY_ACCOUNT: Record<CounterpartyRole, { type: AccountType; label: string }> = {
  inter_entity_clearing: { type: 'equity', label: 'Transfers with' },
  due_from_entity: { type: 'asset', label: 'Due from' },
  due_to_entity: { type: 'liability', label: 'Due to' },
};

/**
 * The only writer of journal entries and postings (design 02 §4). Turns domain drafts into rows and supplies
 * the AccountResolver the domain builder needs.
 */
@Injectable()
export class LedgerService {
  async accountRef(
    trx: Trx,
    workspaceId: string,
    accountId: string,
  ): Promise<LedgerAccountRef & { name: string }> {
    const row = await trx
      .selectFrom('app.ledger_account')
      .select(['id', 'entity_id', 'type', 'currency', 'system_role', 'name', 'archived_at'])
      .where('workspace_id', '=', workspaceId)
      .where('id', '=', accountId)
      .executeTakeFirst();
    if (!row) throw notFound(`Account ${accountId}`);
    return {
      id: row.id,
      entityId: row.entity_id,
      type: row.type,
      currency: asCurrencyCode(row.currency),
      systemRole: row.system_role as SystemRole | null,
      name: row.name,
    };
  }

  /**
   * Loads entities and system accounts, and makes sure inter-entity accounts exist for every entity pair the
   * caller is about to post between (DE-05, ledger_account.counterparty_entity_id).
   */
  async resolver(trx: Trx, workspaceId: string, pairs: [string, string][] = []): Promise<AccountResolver> {
    const ws = await trx
      .selectFrom('app.workspace')
      .select('inter_entity_mode')
      .where('id', '=', workspaceId)
      .executeTakeFirstOrThrow();
    const entities = new Map<string, EntityRef & { name: string }>();
    for (const e of await trx
      .selectFrom('app.entity')
      .select(['id', 'type', 'name', 'functional_currency'])
      .where('workspace_id', '=', workspaceId)
      .execute()) {
      entities.set(e.id, {
        id: e.id,
        type: e.type,
        name: e.name,
        functionalCurrency: asCurrencyCode(e.functional_currency),
      });
    }
    const system = new Map<string, LedgerAccountRef>();
    const key = (entityId: string, role: string, cp?: string | null) => `${entityId}|${role}|${cp ?? ''}`;
    const loadSystem = async () => {
      for (const a of await trx
        .selectFrom('app.ledger_account')
        .select(['id', 'entity_id', 'type', 'currency', 'system_role', 'counterparty_entity_id'])
        .where('workspace_id', '=', workspaceId)
        .where('system_role', 'is not', null)
        .execute()) {
        system.set(key(a.entity_id, a.system_role!, a.counterparty_entity_id), {
          id: a.id,
          entityId: a.entity_id,
          type: a.type,
          currency: asCurrencyCode(a.currency),
          systemRole: a.system_role as SystemRole,
        });
      }
    };
    await loadSystem();

    const entity = (id: string) => {
      const e = entities.get(id);
      if (!e) throw notFound(`Entity ${id}`);
      return e;
    };
    const get = (entityId: string, role: SystemRole, cp?: string) => {
      const a = system.get(key(entityId, role, cp));
      if (!a) throw new Error(`System account ${role} missing for entity ${entityId}`);
      return a;
    };
    const plan = (local: string, remote: string, flow: 'out' | 'in') => {
      const l = entity(local);
      const r = entity(remote);
      if (ws.inter_entity_mode === 'equity' && (l.type === 'personal' || r.type === 'personal')) {
        if (l.type === 'personal') {
          return {
            local: ['inter_entity_clearing', remote] as const,
            remote: [flow === 'out' ? 'owner_contribution' : 'owner_draw', undefined] as const,
          };
        }
        return {
          local: [flow === 'out' ? 'owner_draw' : 'owner_contribution', undefined] as const,
          remote: ['inter_entity_clearing', local] as const,
        };
      }
      return flow === 'out'
        ? { local: ['due_from_entity', remote] as const, remote: ['due_to_entity', local] as const }
        : { local: ['due_to_entity', remote] as const, remote: ['due_from_entity', local] as const };
    };

    // Create any missing counterparty accounts up front so the domain resolver can stay synchronous.
    let created = false;
    for (const [local, remote] of pairs) {
      if (local === remote) continue;
      for (const flow of ['out', 'in'] as const) {
        const p = plan(local, remote, flow);
        for (const [entityId, [role, cp]] of [
          [local, p.local],
          [remote, p.remote],
        ] as const) {
          if (!cp || system.has(key(entityId, role, cp))) continue;
          const spec = COUNTERPARTY_ACCOUNT[role as CounterpartyRole];
          const e = entity(entityId);
          await trx
            .insertInto('app.ledger_account')
            .values({
              workspace_id: workspaceId,
              id: newId(),
              entity_id: entityId,
              type: spec.type,
              subtype: 'inter_entity',
              name: `${spec.label} ${entity(cp).name}`,
              currency: e.functionalCurrency,
              system_role: role,
              counterparty_entity_id: cp,
            })
            .execute();
          created = true;
          system.set(key(entityId, role, cp), {
            id: 'pending',
            entityId,
            type: spec.type,
            currency: e.functionalCurrency,
          });
        }
      }
    }
    if (created) {
      system.clear();
      await loadSystem();
    }

    return {
      entity,
      systemAccount: (entityId, role) => get(entityId, role),
      interEntity: (local, remote, flow) => {
        const p = plan(local, remote, flow);
        return { local: get(local, p.local[0], p.local[1]), remote: get(remote, p.remote[0], p.remote[1]) };
      },
    };
  }

  /** Writes journal entries (and their postings) for a transaction. Balance is enforced again by the DB. */
  async post(
    trx: Trx,
    ctx: { workspaceId: string; userId: string },
    transactionId: string | null,
    drafts: readonly JournalEntryDraft[],
  ): Promise<string[]> {
    const ids: string[] = [];
    for (const draft of drafts) {
      const entryId = newId();
      ids.push(entryId);
      await trx
        .insertInto('app.journal_entry')
        .values({
          workspace_id: ctx.workspaceId,
          id: entryId,
          entity_id: draft.entityId,
          transaction_id: transactionId,
          entry_date: draft.entryDate,
          description: draft.description,
          kind: draft.kind,
          posted_by: ctx.userId,
        })
        .execute();
      await trx
        .insertInto('app.posting')
        .values(
          draft.postings.map((p) => ({
            workspace_id: ctx.workspaceId,
            id: newId(),
            journal_entry_id: entryId,
            line_no: p.lineNo,
            ledger_account_id: p.accountId,
            amount_minor: p.amount,
            currency: p.currency,
            functional_amount_minor: p.functionalAmount,
            fx_rate: p.fxRate,
            member_id: p.memberId ?? null,
            property_id: p.propertyId ?? null,
            unit_id: p.unitId ?? null,
            memo: p.memo ?? null,
          })),
        )
        .execute();
    }
    return ids;
  }

  /** Debit-positive balances per account, for the accounts list. */
  async balances(trx: Trx, workspaceId: string, accountIds: string[]): Promise<Map<string, bigint>> {
    if (accountIds.length === 0) return new Map();
    const rows = await trx
      .selectFrom('app.posting')
      .select(['ledger_account_id', sql<bigint>`sum(amount_minor)::bigint`.as('total')])
      .where('workspace_id', '=', workspaceId)
      .where('ledger_account_id', 'in', accountIds)
      .groupBy('ledger_account_id')
      .execute();
    return new Map(rows.map((r) => [r.ledger_account_id, BigInt(r.total)]));
  }

  /** Account register (DE-06): ordered lines with debit/credit and running balances. */
  async register(trx: Trx, workspaceId: string, accountId: string, limit = 500) {
    const account = await this.accountRef(trx, workspaceId, accountId);
    const rows = await sql<{
      entry_date: string;
      transaction_id: string | null;
      entry_id: string;
      description: string;
      amount_minor: bigint;
      cleared: 'uncleared' | 'cleared' | 'reconciled';
      running: bigint;
    }>`
      select p.entry_date, je.transaction_id, je.id as entry_id,
             coalesce(nullif(t.description, ''), t.payee_raw, je.description) as description,
             p.amount_minor, p.cleared,
             sum(p.amount_minor) over (order by p.entry_date, je.posted_at, je.id, p.line_no)::bigint as running
        from app.posting p
        join app.journal_entry je on je.workspace_id = p.workspace_id and je.id = p.journal_entry_id
        left join app.transaction t on t.workspace_id = je.workspace_id and t.id = je.transaction_id
       where p.workspace_id = ${workspaceId} and p.ledger_account_id = ${accountId}
       order by p.entry_date, je.posted_at, je.id, p.line_no
       limit ${limit}`.execute(trx);
    return {
      account,
      lines: rows.rows.map((r) => ({
        date: r.entry_date,
        transactionId: r.transaction_id,
        entryId: r.entry_id,
        description: r.description,
        debit: r.amount_minor > 0n ? r.amount_minor.toString() : null,
        credit: r.amount_minor < 0n ? (-r.amount_minor).toString() : null,
        amount: naturalBalance(account.type, BigInt(r.amount_minor)).toString(),
        runningBalance: naturalBalance(account.type, BigInt(r.running)).toString(),
        cleared: r.cleared,
      })),
    };
  }
}
