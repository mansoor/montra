import { Inject, Injectable } from '@nestjs/common';
import { groupTemplates, newId, systemAccountTemplates, type Trx } from '@montra/db';
import { sql } from 'kysely';
import type { EntityType } from '@montra/domain';
import type { CreateWorkspaceRequest, WorkspaceDto, WorkspaceSecurityDto } from '@montra/schemas';
import { Db } from '../db/database.js';
import type { AuthUser } from '../auth/auth.js';
import { forbidden } from '../common/errors.js';

@Injectable()
export class WorkspacesService {
  constructor(@Inject(Db) private readonly db: Db) {}

  /** Creates a workspace from an onboarding template (UP-03) with seeded charts of accounts per entity. */
  async create(user: AuthUser, req: CreateWorkspaceRequest): Promise<WorkspaceDto> {
    const workspaceId = newId();
    await this.db.run({ workspaceId, userId: user.id }, async (trx) => {
      await trx
        .insertInto('app.workspace')
        .values({ id: workspaceId, name: req.name, base_currency: req.baseCurrency, time_zone: req.timeZone })
        .execute();
      await trx
        .insertInto('app.workspace_member')
        .values({ workspace_id: workspaceId, user_id: user.id, role: 'owner' })
        .execute();
      const entities: { type: EntityType; name: string }[] = [{ type: 'personal', name: 'Personal' }];
      if (req.template === 'freelancer' || req.template === 'hybrid') {
        entities.push({ type: 'business', name: req.businessName ?? 'My Business' });
      }
      if (req.template === 'landlord' || req.template === 'hybrid') {
        entities.push({ type: 'rental', name: req.rentalName ?? 'Rental Portfolio' });
      }
      for (const e of entities) await this.createEntity(trx, workspaceId, e.type, e.name, req.baseCurrency);
      await trx
        .insertInto('app.family_member')
        .values({
          workspace_id: workspaceId,
          id: newId(),
          name: 'Me',
          relationship: 'self',
          linked_user_id: user.id,
        })
        .execute();
    });
    const ws = await this.get(user, workspaceId);
    return ws!;
  }

  async createEntity(
    trx: Trx,
    workspaceId: string,
    type: EntityType,
    name: string,
    currency: string,
  ): Promise<string> {
    const entityId = newId();
    await trx
      .insertInto('app.entity')
      .values({ workspace_id: workspaceId, id: entityId, type, name, functional_currency: currency })
      .execute();
    let sort = 0;
    for (const g of groupTemplates(type)) {
      const groupId = newId();
      await trx
        .insertInto('app.category_group')
        .values({
          workspace_id: workspaceId,
          id: groupId,
          entity_id: entityId,
          name: g.name,
          kind: g.kind,
          sort_order: sort++,
        })
        .execute();
      await trx
        .insertInto('app.ledger_account')
        .values(
          g.categories.map((c, i) => ({
            workspace_id: workspaceId,
            id: newId(),
            entity_id: entityId,
            type: c.type,
            subtype: 'category',
            name: c.name,
            currency,
            is_category: true,
            category_group_id: groupId,
            tax_line_code: c.taxLine ?? null,
            sort_order: i,
          })),
        )
        .execute();
    }
    await trx
      .insertInto('app.ledger_account')
      .values(
        systemAccountTemplates(type).map((s) => ({
          workspace_id: workspaceId,
          id: newId(),
          entity_id: entityId,
          type: s.type,
          subtype: 'system',
          name: s.name,
          currency,
          is_category: s.type === 'income' || s.type === 'expense',
          system_role: s.role,
        })),
      )
      .execute();
    return entityId;
  }

  async list(user: AuthUser): Promise<WorkspaceDto[]> {
    const ids = await this.db.run({ userId: user.id }, (trx) =>
      trx
        .selectFrom('app.workspace_member')
        .select('workspace_id')
        .where('user_id', '=', user.id)
        .where('status', '=', 'active')
        .execute(),
    );
    const result: WorkspaceDto[] = [];
    for (const { workspace_id } of ids) {
      const ws = await this.get(user, workspace_id);
      if (ws) result.push(ws);
    }
    return result;
  }

  async get(user: AuthUser, workspaceId: string): Promise<WorkspaceDto | null> {
    return this.db.run({ workspaceId, userId: user.id }, async (trx) => {
      const ws = await trx
        .selectFrom('app.workspace as w')
        .innerJoin('app.workspace_member as m', (j) =>
          j.onRef('m.workspace_id', '=', 'w.id').on('m.user_id', '=', user.id),
        )
        .select([
          'w.id',
          'w.name',
          'w.base_currency',
          'w.time_zone',
          'w.mfa_policy',
          'w.idle_timeout_minutes',
          'm.role',
        ])
        .where('w.id', '=', workspaceId)
        .where('w.deleted_at', 'is', null)
        .executeTakeFirst();
      if (!ws) return null;
      const entities = await trx
        .selectFrom('app.entity as e')
        .leftJoin('app.period_lock as pl', (j) =>
          j.onRef('pl.workspace_id', '=', 'e.workspace_id').onRef('pl.entity_id', '=', 'e.id'),
        )
        .select(['e.id', 'e.type', 'e.name', 'e.functional_currency', 'pl.locked_through'])
        .select(sql<string>`app.entity_access(e.id)`.as('access'))
        .where('e.workspace_id', '=', workspaceId)
        .where('e.archived_at', 'is', null)
        .orderBy('e.created_at')
        .execute();
      return {
        id: ws.id,
        name: ws.name,
        baseCurrency: ws.base_currency,
        timeZone: ws.time_zone,
        role: ws.role,
        security: { mfaPolicy: ws.mfa_policy, idleTimeoutMinutes: ws.idle_timeout_minutes },
        entities: entities.map((e) => ({
          id: e.id,
          type: e.type,
          name: e.name,
          functionalCurrency: e.functional_currency,
          lockedThrough: e.locked_through,
          access: e.access === 'write' ? ('write' as const) : ('read' as const),
        })),
      };
    });
  }

  /** AUTH-04, AUTH-07 (ADR-0044): owners and admins set who needs two-step verification and the web's idle sign-out. */
  async setSecurity(
    user: AuthUser,
    workspaceId: string,
    req: WorkspaceSecurityDto,
  ): Promise<WorkspaceSecurityDto> {
    return this.db.run({ workspaceId, userId: user.id }, async (trx) => {
      const row = await trx
        .updateTable('app.workspace')
        .set({ mfa_policy: req.mfaPolicy, idle_timeout_minutes: req.idleTimeoutMinutes })
        .where('id', '=', workspaceId)
        .returning(['mfa_policy', 'idle_timeout_minutes'])
        .executeTakeFirst();
      if (!row) throw forbidden();
      return { mfaPolicy: row.mfa_policy, idleTimeoutMinutes: row.idle_timeout_minutes };
    });
  }
}
