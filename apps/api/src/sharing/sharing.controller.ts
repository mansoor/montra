import { createHash, randomBytes } from 'node:crypto';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { sql } from 'kysely';
import { newId, type Trx } from '@montra/db';
import { CreateInviteRequest, SetGrantsRequest, UpdateMemberRequest, type MemberDto } from '@montra/schemas';
import { z } from 'zod';
import {
  AuthGuard,
  Ctx,
  dbCtx,
  requireRecentAuth,
  WorkspaceGuard,
  type RequestContext,
} from '../auth/auth.js';
import { Db } from '../db/database.js';
import { CONFIG, type AppConfig } from '../config.js';
import { MAIL_PORT, templates, type MailPort } from '../mail/mail.service.js';
import { AppError, notFound, unprocessable } from '../common/errors.js';
import { requireRole, requireWorkspaceAdmin } from '../common/roles.js';
import { parse } from '../common/zod.js';

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

/** Household and accountant sharing (UP-04, AUTH-10, BIZ-13). */
@Controller('v1/workspaces/:workspaceId/sharing')
@UseGuards(AuthGuard, WorkspaceGuard)
export class SharingController {
  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(MAIL_PORT) private readonly mail: MailPort,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  @Get('members')
  async members(@Ctx() ctx: RequestContext): Promise<{ data: MemberDto[] }> {
    return { data: await this.loadMembers(ctx) };
  }

  /**
   * Invites by email with a role and entity grants; the emailed link expires in 7 days (AUTH-10). Only a hash
   * of the token is stored.
   */
  @Post('invites')
  async invite(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    requireWorkspaceAdmin(ctx);
    const req = parse(CreateInviteRequest, body);
    // AUTH-09: inviting an accountant or an admin is a sensitive action.
    if (req.role === 'accountant' || req.role === 'admin') requireRecentAuth(ctx);
    const token = randomBytes(32).toString('base64url');
    const id = newId();
    const invite = await this.db.run(dbCtx(ctx), async (trx) => {
      const familyMemberId = req.familyMember
        ? await this.familyMemberFor(trx, ctx, req.familyMember, req.email)
        : null;
      await trx
        .updateTable('app.workspace_invite')
        .set({ revoked_at: new Date() })
        .where('workspace_id', '=', ctx.workspaceId!)
        .where('email', '=', req.email)
        .where('accepted_at', 'is', null)
        .where('revoked_at', 'is', null)
        .execute();
      return trx
        .insertInto('app.workspace_invite')
        .values({
          workspace_id: ctx.workspaceId!,
          id,
          email: req.email,
          role: req.role,
          entity_grants: JSON.stringify(req.entityGrants),
          token_hash: hashToken(token),
          invited_by: ctx.user.id,
          family_member_id: familyMemberId,
        })
        .returning(['id', 'email', 'role', 'expires_at', 'family_member_id'])
        .executeTakeFirstOrThrow();
    });
    const ws = await this.db.run(dbCtx(ctx), (trx) =>
      trx
        .selectFrom('app.workspace')
        .select('name')
        .where('id', '=', ctx.workspaceId!)
        .executeTakeFirstOrThrow(),
    );
    await this.mail.send(
      templates.invite({
        to: invite.email,
        inviter: ctx.user.email,
        workspace: ws.name,
        role: invite.role,
        url: `${this.config.WEB_URL}/invite/${token}`,
      }),
    );
    // The token travels by email; outside production it is also returned to ease local testing.
    return {
      id: invite.id,
      email: invite.email,
      role: invite.role,
      expiresAt: invite.expires_at,
      familyMemberId: invite.family_member_id,
      ...(this.config.NODE_ENV === 'production' ? {} : { token }),
    };
  }

  @Get('invites')
  async invites(@Ctx() ctx: RequestContext) {
    requireWorkspaceAdmin(ctx);
    const rows = await this.db.run(dbCtx(ctx), (trx) =>
      trx
        .selectFrom('app.workspace_invite')
        .select(['id', 'email', 'role', 'expires_at', 'accepted_at', 'revoked_at', 'family_member_id'])
        .where('workspace_id', '=', ctx.workspaceId!)
        .orderBy('created_at', 'desc')
        .execute(),
    );
    return {
      data: rows.map((r) => ({
        id: r.id,
        email: r.email,
        role: r.role,
        expiresAt: r.expires_at,
        familyMemberId: r.family_member_id,
        status: r.accepted_at
          ? 'accepted'
          : r.revoked_at
            ? 'revoked'
            : r.expires_at < new Date()
              ? 'expired'
              : 'pending',
      })),
    };
  }

  @Delete('invites/:inviteId')
  async revokeInvite(@Ctx() ctx: RequestContext, @Param('inviteId') inviteId: string) {
    requireWorkspaceAdmin(ctx);
    await this.db.run(dbCtx(ctx), (trx) =>
      trx
        .updateTable('app.workspace_invite')
        .set({ revoked_at: new Date() })
        .where('workspace_id', '=', ctx.workspaceId!)
        .where('id', '=', parse(z.uuid(), inviteId))
        .execute(),
    );
    return { revoked: true };
  }

  @Patch('members/:userId')
  async update(@Ctx() ctx: RequestContext, @Param('userId') userId: string, @Body() body: unknown) {
    requireWorkspaceAdmin(ctx);
    const req = parse(UpdateMemberRequest, body);
    const id = parse(z.uuid(), userId);
    if (id === ctx.user.id) throw unprocessable('member.self', 'You cannot change your own role');
    if (req.role === 'owner') {
      await this.handOver(ctx, id, req.status);
      return (await this.loadMembers(ctx)).find((m) => m.userId === id);
    }
    if (req.role === 'admin') requireRecentAuth(ctx);
    await this.db.run(dbCtx(ctx), async (trx) => {
      const res = await trx
        .updateTable('app.workspace_member')
        .set({ ...(req.role ? { role: req.role } : {}), ...(req.status ? { status: req.status } : {}) })
        .where('workspace_id', '=', ctx.workspaceId!)
        .where('user_id', '=', id)
        .where('role', '<>', 'owner')
        .executeTakeFirst();
      if (res.numUpdatedRows === 0n) throw notFound('Member');
    });
    return (await this.loadMembers(ctx)).find((m) => m.userId === id);
  }

  /**
   * AUTH-15: the owner hands the workspace to an active admin and becomes an admin. The new owner is made first:
   * once the old one steps down, RLS no longer lets them touch the owner's row.
   */
  private async handOver(ctx: RequestContext, id: string, status: string | undefined): Promise<void> {
    requireRole(ctx, 'owner');
    requireRecentAuth(ctx);
    if (status === 'revoked')
      throw unprocessable('member.owner_revoked', 'The new owner must keep their access');
    await this.db.run(dbCtx(ctx), async (trx) => {
      const promoted = await trx
        .updateTable('app.workspace_member')
        .set({ role: 'owner' })
        .where('workspace_id', '=', ctx.workspaceId!)
        .where('user_id', '=', id)
        .where('role', '=', 'admin')
        .where('status', '=', 'active')
        .executeTakeFirst();
      if (promoted.numUpdatedRows === 0n) {
        throw unprocessable('member.not_admin', 'Make them an admin before handing the workspace over');
      }
      await trx
        .updateTable('app.workspace_member')
        .set({ role: 'admin' })
        .where('workspace_id', '=', ctx.workspaceId!)
        .where('user_id', '=', ctx.user.id)
        .execute();
    });
  }

  /** The Family list person an invite is for: one already there (and not someone else's login), or a new one. */
  private async familyMemberFor(
    trx: Trx,
    ctx: RequestContext,
    who: NonNullable<CreateInviteRequest['familyMember']>,
    email: string,
  ): Promise<string> {
    if ('name' in who) {
      const created = await trx
        .insertInto('app.family_member')
        .values({
          workspace_id: ctx.workspaceId!,
          id: newId(),
          name: who.name,
          relationship: who.relationship,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      return created.id;
    }
    const person = await trx
      .selectFrom('app.family_member as f')
      .leftJoin('app.app_user as u', 'u.id', 'f.linked_user_id')
      .select(['f.id', 'f.linked_user_id', 'u.email'])
      .where('f.workspace_id', '=', ctx.workspaceId!)
      .where('f.id', '=', who.id)
      .executeTakeFirst();
    if (!person) throw notFound('Family member');
    if (person.linked_user_id && person.email?.toLowerCase() !== email) {
      throw new AppError(
        409,
        'invite.family_linked',
        'That person already signs in with another email. Remove their access first.',
      );
    }
    return person.id;
  }

  /** Per-entity access for a member (none / read / write), replacing previous grants. */
  @Put('members/:userId/grants')
  async grants(@Ctx() ctx: RequestContext, @Param('userId') userId: string, @Body() body: unknown) {
    requireWorkspaceAdmin(ctx);
    const { grants } = parse(SetGrantsRequest, body);
    const id = parse(z.uuid(), userId);
    await this.db.run(dbCtx(ctx), async (trx) => {
      await trx
        .deleteFrom('app.entity_grant')
        .where('workspace_id', '=', ctx.workspaceId!)
        .where('user_id', '=', id)
        .execute();
      if (grants.length) {
        await trx
          .insertInto('app.entity_grant')
          .values(
            grants.map((g) => ({
              workspace_id: ctx.workspaceId!,
              user_id: id,
              entity_id: g.entityId,
              access: g.access,
            })),
          )
          .execute();
      }
    });
    return (await this.loadMembers(ctx)).find((m) => m.userId === id);
  }

  private async loadMembers(ctx: RequestContext): Promise<MemberDto[]> {
    return this.db.run(dbCtx(ctx), async (trx) => {
      const members = await trx
        .selectFrom('app.workspace_member as m')
        .innerJoin('app.app_user as u', 'u.id', 'm.user_id')
        .select(['m.user_id', 'u.email', 'u.display_name', 'm.role', 'm.status'])
        .where('m.workspace_id', '=', ctx.workspaceId!)
        .orderBy('m.created_at')
        .execute();
      const grants = await trx
        .selectFrom('app.entity_grant')
        .selectAll()
        .where('workspace_id', '=', ctx.workspaceId!)
        .execute();
      const people = await trx
        .selectFrom('app.family_member')
        .select(['id', 'linked_user_id'])
        .where('workspace_id', '=', ctx.workspaceId!)
        .where('linked_user_id', 'is not', null)
        .execute();
      return members.map((m) => ({
        userId: m.user_id,
        email: m.email,
        displayName: m.display_name,
        role: m.role,
        status: m.status,
        familyMemberId: people.find((p) => p.linked_user_id === m.user_id)?.id ?? null,
        grants: grants
          .filter((g) => g.user_id === m.user_id)
          .map((g) => ({ entityId: g.entity_id, access: g.access })),
      }));
    });
  }
}

/** Accepting an invite happens before the user belongs to the workspace. */
@Controller('v1/invites')
@UseGuards(AuthGuard)
export class InviteAcceptController {
  constructor(@Inject(Db) private readonly db: Db) {}

  @Post(':token/accept')
  @HttpCode(200)
  async accept(@Ctx() ctx: RequestContext, @Param('token') token: string) {
    if (!/^[A-Za-z0-9_-]{20,100}$/.test(token))
      throw new AppError(422, 'invite.invalid', 'Invite is invalid or expired');
    const workspaceId = await this.db.run({ userId: ctx.user.id }, async (trx) => {
      const { rows } = await sql<{ id: string }>`select app.accept_invite(${hashToken(token)}) as id`.execute(
        trx,
      );
      return rows[0]!.id;
    });
    return { workspaceId };
  }
}
