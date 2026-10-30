import { Body, Controller, Get, Inject, Param, Post, UseGuards } from '@nestjs/common';
import { CreateWorkspaceRequest, type WorkspaceDto } from '@montra/schemas';
import { AuthGuard, Ctx, WorkspaceGuard, type RequestContext } from '../auth/auth.js';
import { parse } from '../common/zod.js';
import { notFound } from '../common/errors.js';
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
}
