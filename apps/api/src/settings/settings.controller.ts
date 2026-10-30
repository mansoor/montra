import { Body, Controller, Get, Inject, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { newId } from '@montra/db';
import {
  CreateEntityRequest,
  CreateFamilyMemberRequest,
  UpdateEntityRequest,
  UpdateFamilyMemberRequest,
  UpdateMeRequest,
  type FamilyMemberDto,
  type MeDto,
} from '@montra/schemas';
import { z } from 'zod';
import { AuthGuard, Ctx, dbCtx, WorkspaceGuard, type RequestContext } from '../auth/auth.js';
import { Db } from '../db/database.js';
import { notFound } from '../common/errors.js';
import { requireRole } from '../common/roles.js';
import { parse } from '../common/zod.js';
import { WorkspacesService } from '../workspaces/workspaces.service.js';

/** Profile and preferences of the signed-in user (TZ-01, TZ-05, CUR-10). */
@Controller('v1/me')
@UseGuards(AuthGuard)
export class MeController {
  constructor(@Inject(Db) private readonly db: Db) {}

  @Get()
  get(@Ctx() ctx: RequestContext): Promise<MeDto> {
    return this.load(ctx.user.id);
  }

  @Patch()
  async update(@Ctx() ctx: RequestContext, @Body() body: unknown): Promise<MeDto> {
    const req = parse(UpdateMeRequest, body);
    await this.db.run({ userId: ctx.user.id }, (trx) =>
      trx
        .updateTable('app.app_user')
        .set({
          ...(req.displayName !== undefined ? { display_name: req.displayName } : {}),
          ...(req.locale !== undefined ? { locale: req.locale } : {}),
          ...(req.timeZone !== undefined ? { time_zone: req.timeZone } : {}),
          ...(req.dateFormat !== undefined ? { date_format: req.dateFormat } : {}),
          ...(req.weekStart !== undefined ? { week_start: req.weekStart } : {}),
        })
        .where('id', '=', ctx.user.id)
        .execute(),
    );
    return this.load(ctx.user.id);
  }

  private async load(userId: string): Promise<MeDto> {
    const u = await this.db.run({ userId }, (trx) =>
      trx.selectFrom('app.app_user').selectAll().where('id', '=', userId).executeTakeFirstOrThrow(),
    );
    return {
      id: u.id,
      email: u.email,
      displayName: u.display_name,
      locale: u.locale,
      timeZone: u.time_zone,
      dateFormat: u.date_format,
      weekStart: u.week_start,
      emailVerified: u.email_verified_at !== null,
    };
  }
}

/** Businesses and rental portfolios beyond the onboarding template (ACC-01, BIZ-01, CUR-01). */
@Controller('v1/workspaces/:workspaceId/entities')
@UseGuards(AuthGuard, WorkspaceGuard)
export class EntitiesController {
  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(WorkspacesService) private readonly workspaces: WorkspacesService,
  ) {}

  @Post()
  async create(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    requireRole(ctx, 'owner');
    const req = parse(CreateEntityRequest, body);
    const id = await this.db.run(dbCtx(ctx), async (trx) => {
      const ws = await trx
        .selectFrom('app.workspace')
        .select('base_currency')
        .where('id', '=', ctx.workspaceId!)
        .executeTakeFirstOrThrow();
      const entityId = await this.workspaces.createEntity(
        trx,
        ctx.workspaceId!,
        req.type,
        req.name,
        req.functionalCurrency ?? ws.base_currency,
      );
      await trx
        .updateTable('app.entity')
        .set({
          business_type: req.businessType ?? null,
          fiscal_year_start_month: req.fiscalYearStartMonth ?? 1,
        })
        .where('id', '=', entityId)
        .execute();
      return entityId;
    });
    return this.get(ctx, id);
  }

  @Patch(':entityId')
  async update(@Ctx() ctx: RequestContext, @Param('entityId') entityId: string, @Body() body: unknown) {
    requireRole(ctx, 'owner');
    const req = parse(UpdateEntityRequest, body);
    await this.db.run(dbCtx(ctx), async (trx) => {
      const res = await trx
        .updateTable('app.entity')
        .set({
          ...(req.name !== undefined ? { name: req.name } : {}),
          ...(req.businessType !== undefined ? { business_type: req.businessType } : {}),
          ...(req.fiscalYearStartMonth !== undefined
            ? { fiscal_year_start_month: req.fiscalYearStartMonth }
            : {}),
          ...(req.archived !== undefined ? { archived_at: req.archived ? new Date() : null } : {}),
        })
        .where('workspace_id', '=', ctx.workspaceId!)
        .where('id', '=', parse(z.uuid(), entityId))
        .where('type', '<>', 'personal')
        .executeTakeFirst();
      if (res.numUpdatedRows === 0n) throw notFound('Entity');
    });
    return this.get(ctx, entityId);
  }

  @Get()
  async list(@Ctx() ctx: RequestContext) {
    const rows = await this.db.run(dbCtx(ctx), (trx) =>
      trx
        .selectFrom('app.entity as e')
        .leftJoin('app.period_lock as pl', (j) =>
          j.onRef('pl.workspace_id', '=', 'e.workspace_id').onRef('pl.entity_id', '=', 'e.id'),
        )
        .selectAll('e')
        .select('pl.locked_through')
        .where('e.workspace_id', '=', ctx.workspaceId!)
        .orderBy('e.created_at')
        .execute(),
    );
    return { data: rows.map(toEntityDto) };
  }

  private async get(ctx: RequestContext, id: string) {
    const row = await this.db.run(dbCtx(ctx), (trx) =>
      trx
        .selectFrom('app.entity as e')
        .leftJoin('app.period_lock as pl', (j) =>
          j.onRef('pl.workspace_id', '=', 'e.workspace_id').onRef('pl.entity_id', '=', 'e.id'),
        )
        .selectAll('e')
        .select('pl.locked_through')
        .where('e.id', '=', id)
        .executeTakeFirst(),
    );
    if (!row) throw notFound('Entity');
    return toEntityDto(row);
  }
}

const toEntityDto = (e: {
  id: string;
  type: string;
  name: string;
  functional_currency: string;
  business_type: string | null;
  fiscal_year_start_month: number;
  archived_at: Date | null;
  locked_through: string | null;
}) => ({
  id: e.id,
  type: e.type,
  name: e.name,
  functionalCurrency: e.functional_currency,
  businessType: e.business_type,
  fiscalYearStartMonth: e.fiscal_year_start_month,
  archived: e.archived_at !== null,
  lockedThrough: e.locked_through,
});

/** Family members are profiles, not logins (FAM-01, FAM-02, FAM-11). */
@Controller('v1/workspaces/:workspaceId/family-members')
@UseGuards(AuthGuard, WorkspaceGuard)
export class FamilyMembersController {
  constructor(@Inject(Db) private readonly db: Db) {}

  @Get()
  async list(@Ctx() ctx: RequestContext): Promise<{ data: FamilyMemberDto[] }> {
    const rows = await this.db.run(dbCtx(ctx), (trx) =>
      trx
        .selectFrom('app.family_member')
        .selectAll()
        .where('workspace_id', '=', ctx.workspaceId!)
        .orderBy('created_at')
        .execute(),
    );
    return { data: rows.map(toMemberDto) };
  }

  @Post()
  async create(@Ctx() ctx: RequestContext, @Body() body: unknown): Promise<FamilyMemberDto> {
    const req = parse(CreateFamilyMemberRequest, body);
    const id = newId();
    await this.db.run(dbCtx(ctx), (trx) =>
      trx
        .insertInto('app.family_member')
        .values({
          workspace_id: ctx.workspaceId!,
          id,
          name: req.name,
          relationship: req.relationship,
          birth_date: req.birthDate ?? null,
          color: req.color ?? null,
          is_dependent: req.isDependent ?? false,
          linked_user_id: req.linkedUserId ?? null,
        })
        .execute(),
    );
    return this.get(ctx, id);
  }

  @Patch(':memberId')
  async update(
    @Ctx() ctx: RequestContext,
    @Param('memberId') memberId: string,
    @Body() body: unknown,
  ): Promise<FamilyMemberDto> {
    const req = parse(UpdateFamilyMemberRequest, body);
    const id = parse(z.uuid(), memberId);
    await this.db.run(dbCtx(ctx), async (trx) => {
      const res = await trx
        .updateTable('app.family_member')
        .set({
          ...(req.name !== undefined ? { name: req.name } : {}),
          ...(req.relationship !== undefined ? { relationship: req.relationship } : {}),
          ...(req.birthDate !== undefined ? { birth_date: req.birthDate } : {}),
          ...(req.color !== undefined ? { color: req.color } : {}),
          ...(req.isDependent !== undefined ? { is_dependent: req.isDependent } : {}),
          ...(req.linkedUserId !== undefined ? { linked_user_id: req.linkedUserId } : {}),
          ...(req.status !== undefined ? { status: req.status } : {}),
        })
        .where('workspace_id', '=', ctx.workspaceId!)
        .where('id', '=', id)
        .executeTakeFirst();
      if (res.numUpdatedRows === 0n) throw notFound('Family member');
    });
    return this.get(ctx, id);
  }

  private async get(ctx: RequestContext, id: string): Promise<FamilyMemberDto> {
    const row = await this.db.run(dbCtx(ctx), (trx) =>
      trx
        .selectFrom('app.family_member')
        .selectAll()
        .where('workspace_id', '=', ctx.workspaceId!)
        .where('id', '=', id)
        .executeTakeFirst(),
    );
    if (!row) throw notFound('Family member');
    return toMemberDto(row);
  }
}

const toMemberDto = (m: {
  id: string;
  name: string;
  relationship: FamilyMemberDto['relationship'];
  birth_date: string | null;
  color: string | null;
  status: 'active' | 'inactive';
  is_dependent: boolean;
  linked_user_id: string | null;
}): FamilyMemberDto => ({
  id: m.id,
  name: m.name,
  relationship: m.relationship,
  birthDate: m.birth_date,
  color: m.color,
  status: m.status,
  isDependent: m.is_dependent,
  linkedUserId: m.linked_user_id,
});
