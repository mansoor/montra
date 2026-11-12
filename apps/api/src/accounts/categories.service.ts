import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { newId, type Trx } from '@montra/db';
import type {
  CategoryDto,
  CategoryGroupDto,
  CreateCategoryRequest,
  UpdateCategoryRequest,
} from '@montra/schemas';
import { Db } from '../db/database.js';
import { AppError, forbidden, notFound, unprocessable } from '../common/errors.js';
import { TAX_COUNTRY } from '../business/shared.js';

type Ctx = { workspaceId: string; userId: string };
type EntityType = 'personal' | 'business' | 'rental';
type GroupKind = CategoryGroupDto['kind'];

/** The tax line a new category gets when none is given: the "other" line of its entity's form (ACC-08). */
const DEFAULT_TAX_LINE: Record<EntityType, Record<'income' | 'expense', string | null>> = {
  personal: { income: null, expense: null },
  business: { income: 'US_SCH_C_L6', expense: 'US_SCH_C_L27A' },
  rental: { income: 'US_SCH_E_L3', expense: 'US_SCH_E_L19' },
};

/** Where a new expense category goes when no group is chosen. */
const SPENDING_GROUP: Record<EntityType, GroupKind> = {
  personal: 'daily',
  business: 'business',
  rental: 'rental',
};

/**
 * The user's own categories (ACC-08..10; ADR-0040). A category is a ledger account with `is_category`, so this adds,
 * renames, moves and archives those rows. Nothing is deleted: an archived category leaves the pickers, rules and
 * suggestions, and keeps its history and reports. Built-in system categories are fixed. RLS decides who may write an
 * entity's categories, as for its other records.
 */
@Injectable()
export class CategoriesService {
  constructor(@Inject(Db) private readonly db: Db) {}

  async list(ctx: Ctx, opts: { entityId?: string; includeArchived?: boolean } = {}): Promise<CategoryDto[]> {
    return this.db.run(ctx, async (trx) => {
      const rows = await this.rows(trx, ctx)
        .$if(Boolean(opts.entityId), (q) => q.where('a.entity_id', '=', opts.entityId!))
        .$if(!opts.includeArchived, (q) => q.where('a.archived_at', 'is', null))
        .execute();
      return rows.map(toDto);
    });
  }

  async groups(ctx: Ctx, entityId?: string): Promise<CategoryGroupDto[]> {
    return this.db.run(ctx, async (trx) => {
      const rows = await trx
        .selectFrom('app.category_group')
        .select(['id', 'entity_id', 'name', 'kind'])
        .where('workspace_id', '=', ctx.workspaceId)
        .where('kind', '<>', 'system')
        .$if(Boolean(entityId), (q) => q.where('entity_id', '=', entityId!))
        .orderBy('sort_order')
        .orderBy('created_at')
        .execute();
      return rows.map((g) => ({ id: g.id, entityId: g.entity_id, name: g.name, kind: g.kind as GroupKind }));
    });
  }

  async create(ctx: Ctx, req: CreateCategoryRequest): Promise<CategoryDto> {
    return this.db.run(ctx, async (trx) => {
      const entity = await trx
        .selectFrom('app.entity')
        .select(['id', 'type', 'functional_currency'])
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', req.entityId)
        .executeTakeFirst();
      if (!entity) throw notFound('Entity');
      const type = entity.type as EntityType;
      const group = req.groupId
        ? await this.group(trx, ctx, req.groupId, entity.id)
        : await this.defaultGroup(trx, ctx, entity.id, type, req.type);
      if (group) checkGroupFits(group.kind, req.type);
      await this.checkName(trx, ctx, entity.id, req.type, req.name, null);
      const taxLine =
        type === 'personal'
          ? null
          : req.taxLineCode !== undefined
            ? await this.taxLine(trx, req.taxLineCode)
            : DEFAULT_TAX_LINE[type][req.type];
      const id = newId();
      await trx
        .insertInto('app.ledger_account')
        .values({
          workspace_id: ctx.workspaceId,
          id,
          entity_id: entity.id,
          type: req.type,
          subtype: 'category',
          name: req.name,
          currency: entity.functional_currency,
          is_category: true,
          category_group_id: group?.id ?? null,
          tax_line_code: taxLine,
          sort_order: await this.nextSort(trx, ctx, entity.id, group?.id ?? null),
        })
        .execute();
      return this.one(trx, ctx, id);
    });
  }

  async update(ctx: Ctx, id: string, req: UpdateCategoryRequest): Promise<CategoryDto> {
    return this.db.run(ctx, async (trx) => {
      const current = await this.one(trx, ctx, id);
      if (current.fixed)
        throw unprocessable(
          'category.fixed',
          'This is a built-in category; it can’t be renamed, moved or archived',
        );
      const type = current.type;
      const patch: {
        name?: string;
        category_group_id?: string;
        sort_order?: number;
        archived_at?: Date | null;
      } = {};
      if (req.name !== undefined && req.name !== current.name) {
        await this.checkName(trx, ctx, current.entityId, type, req.name, id);
        patch.name = req.name;
      }
      if (req.groupId !== undefined && req.groupId !== current.groupId) {
        const group = await this.group(trx, ctx, req.groupId, current.entityId);
        checkGroupFits(group.kind, type);
        patch.category_group_id = group.id;
        patch.sort_order = await this.nextSort(trx, ctx, current.entityId, group.id);
      }
      if (req.archived !== undefined && req.archived !== current.archived) {
        // Coming back must not make two active categories with one name.
        if (!req.archived)
          await this.checkName(trx, ctx, current.entityId, type, patch.name ?? current.name, id);
        patch.archived_at = req.archived ? new Date() : null;
      }
      if (Object.keys(patch).length === 0) return current;
      const res = await trx
        .updateTable('app.ledger_account')
        .set({ ...patch, updated_at: new Date(), version: sql`version + 1` })
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', id)
        .executeTakeFirst();
      // Visible but not writable: a viewer, or an entity shared read-only.
      if (!res.numUpdatedRows) throw forbidden('You can’t change this entity’s categories');
      return this.one(trx, ctx, id);
    });
  }

  // ----- helpers --------------------------------------------------------------------------------------------------

  private rows(trx: Trx, ctx: Ctx) {
    return trx
      .selectFrom('app.ledger_account as a')
      .leftJoin('app.category_group as g', 'g.id', 'a.category_group_id')
      .select([
        'a.id',
        'a.entity_id',
        'a.name',
        'a.type',
        'a.tax_line_code',
        'a.category_group_id',
        'a.archived_at',
        'a.system_role',
        'g.name as group_name',
      ])
      .where('a.workspace_id', '=', ctx.workspaceId)
      .where('a.is_category', '=', true)
      .where('a.type', 'in', ['income', 'expense'])
      .orderBy('g.sort_order')
      .orderBy('a.sort_order')
      .orderBy('a.name');
  }

  private async one(trx: Trx, ctx: Ctx, id: string): Promise<CategoryDto> {
    const row = await this.rows(trx, ctx).where('a.id', '=', id).executeTakeFirst();
    if (!row) throw notFound('Category');
    return toDto(row);
  }

  private async group(trx: Trx, ctx: Ctx, groupId: string, entityId: string) {
    const g = await trx
      .selectFrom('app.category_group')
      .select(['id', 'kind'])
      .where('workspace_id', '=', ctx.workspaceId)
      .where('id', '=', groupId)
      .where('entity_id', '=', entityId)
      .where('kind', '<>', 'system')
      .executeTakeFirst();
    if (!g) throw unprocessable('category.group_invalid', 'Choose one of this entity’s category groups');
    return { id: g.id, kind: g.kind as GroupKind };
  }

  private async defaultGroup(
    trx: Trx,
    ctx: Ctx,
    entityId: string,
    entity: EntityType,
    type: 'income' | 'expense',
  ) {
    const groups = await trx
      .selectFrom('app.category_group')
      .select(['id', 'kind'])
      .where('workspace_id', '=', ctx.workspaceId)
      .where('entity_id', '=', entityId)
      .where('kind', '<>', 'system')
      .orderBy('sort_order')
      .orderBy('created_at')
      .execute();
    const pick =
      type === 'income'
        ? groups.find((g) => g.kind === 'income')
        : (groups.find((g) => g.kind === SPENDING_GROUP[entity]) ?? groups.find((g) => g.kind !== 'income'));
    return pick ? { id: pick.id, kind: pick.kind as GroupKind } : null;
  }

  /** Names are unique per entity and type, ignoring case and spacing; an archived one is pointed out, not reused. */
  private async checkName(
    trx: Trx,
    ctx: Ctx,
    entityId: string,
    type: 'income' | 'expense',
    name: string,
    self: string | null,
  ) {
    const clash = await trx
      .selectFrom('app.ledger_account')
      .select(['id', 'name', 'archived_at'])
      .where('workspace_id', '=', ctx.workspaceId)
      .where('entity_id', '=', entityId)
      .where('is_category', '=', true)
      .where('type', '=', type)
      .where(sql<boolean>`lower(btrim(name)) = lower(btrim(${name}))`)
      .$if(self !== null, (q) => q.where('id', '<>', self!))
      .orderBy('archived_at', 'desc')
      .executeTakeFirst();
    if (!clash) return;
    if (clash.archived_at)
      throw new AppError(
        409,
        'category.archived_exists',
        `There's an archived category called “${clash.name}”. Unarchive it instead.`,
      );
    throw new AppError(409, 'category.exists', `There's already a category called “${clash.name}”`);
  }

  private async taxLine(trx: Trx, code: string | null): Promise<string | null> {
    if (!code) return null;
    const line = await trx
      .selectFrom('ref.tax_line')
      .select('code')
      .where('country', '=', TAX_COUNTRY)
      .where('code', '=', code)
      .executeTakeFirst();
    if (!line) throw unprocessable('tax_line.unknown', 'That is not a tax line');
    return line.code;
  }

  private async nextSort(trx: Trx, ctx: Ctx, entityId: string, groupId: string | null): Promise<number> {
    const r = await trx
      .selectFrom('app.ledger_account')
      .select(sql<number>`coalesce(max(sort_order) + 1, 0)`.as('next'))
      .where('workspace_id', '=', ctx.workspaceId)
      .where('entity_id', '=', entityId)
      .where('is_category', '=', true)
      .where(sql<boolean>`category_group_id is not distinct from ${groupId}::uuid`)
      .executeTakeFirst();
    return Number(r?.next ?? 0);
  }
}

/** Income categories live in income groups, and spending ones anywhere else. */
function checkGroupFits(kind: GroupKind, type: 'income' | 'expense') {
  if ((kind === 'income') !== (type === 'income'))
    throw unprocessable(
      'category.group_type',
      type === 'income'
        ? 'Put an income category in an income group'
        : 'Put a spending category in a spending group',
    );
}

function toDto(r: {
  id: string;
  entity_id: string;
  name: string;
  type: string;
  tax_line_code: string | null;
  category_group_id: string | null;
  archived_at: Date | null;
  system_role: string | null;
  group_name: string | null;
}): CategoryDto {
  return {
    id: r.id,
    entityId: r.entity_id,
    name: r.name,
    type: r.type as 'income' | 'expense',
    group: r.group_name,
    taxLineCode: r.tax_line_code,
    groupId: r.category_group_id,
    archived: r.archived_at !== null,
    fixed: r.system_role !== null,
  };
}
