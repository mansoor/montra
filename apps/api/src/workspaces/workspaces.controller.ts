import { Body, Controller, Get, Inject, Param, Post, Put, UseGuards } from '@nestjs/common';
import { CreateWorkspaceRequest, WorkspaceSecurityDto, type WorkspaceDto } from '@montra/schemas';
import { AuthGuard, Ctx, requireRecentAuth, WorkspaceGuard, type RequestContext } from '../auth/auth.js';
import { parse } from '../common/zod.js';
import { notFound } from '../common/errors.js';
import { requireWorkspaceAdmin } from '../common/roles.js';
import { WorkspacesService } from './workspaces.service.js';

@Controller('v1/workspaces')
@UseGuards(AuthGuard)
export class WorkspacesController {
  constructor(@Inject(WorkspacesService) private readonly workspaces: WorkspacesService) {}

  @Post()
  create(@Ctx() ctx: RequestContext, @Body() body: unknown): Promise<WorkspaceDto> {
    return this.workspaces.create(ctx.user, parse(CreateWorkspaceRequest, body));
  }

  @Get()
  async list(@Ctx() ctx: RequestContext): Promise<{ data: WorkspaceDto[] }> {
    return { data: await this.workspaces.list(ctx.user) };
  }

  @Get(':workspaceId')
  @UseGuards(WorkspaceGuard)
  async get(@Ctx() ctx: RequestContext, @Param('workspaceId') workspaceId: string): Promise<WorkspaceDto> {
    const ws = await this.workspaces.get(ctx.user, workspaceId);
    if (!ws) throw notFound('Workspace');
    return ws;
  }

  /**
   * Who must use two-step verification here, and the web's idle sign-out (AUTH-04, AUTH-07, ADR-0044). Owners and
   * admins, with a recent sign-in, since it can loosen what protects everyone's data.
   */
  @Put(':workspaceId/security')
  @UseGuards(WorkspaceGuard)
  setSecurity(
    @Ctx() ctx: RequestContext,
    @Param('workspaceId') workspaceId: string,
    @Body() body: unknown,
  ): Promise<WorkspaceSecurityDto> {
    requireWorkspaceAdmin(ctx);
    requireRecentAuth(ctx);
    return this.workspaces.setSecurity(ctx.user, workspaceId, parse(WorkspaceSecurityDto, body));
  }
}
