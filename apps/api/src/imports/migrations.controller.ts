import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { AnalyzeMigrationRequest, Id, StartMigrationRequest } from '@montra/schemas';
import { AuthGuard, Ctx, dbCtx, WorkspaceGuard, type RequestContext } from '../auth/auth.js';
import { IdempotencyInterceptor } from '../common/idempotency.interceptor.js';
import { requireRole } from '../common/roles.js';
import { parse } from '../common/zod.js';
import { MigrationsService } from './migrations.service.js';

/** Switching from another app (IMP-13, ADR-0029): one export, several accounts, for a fresh start. */
@Controller('v1/workspaces/:workspaceId/migrations')
@UseGuards(AuthGuard, WorkspaceGuard)
@UseInterceptors(IdempotencyInterceptor)
export class MigrationsController {
  constructor(@Inject(MigrationsService) private readonly migrations: MigrationsService) {}

  @Get('eligibility')
  eligibility(@Ctx() ctx: RequestContext) {
    return this.migrations.eligibility(dbCtx(ctx));
  }

  @Post('analyze')
  @HttpCode(200)
  analyze(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    requireRole(ctx, 'owner', 'partner', 'accountant');
    return this.migrations.analyze(dbCtx(ctx), parse(AnalyzeMigrationRequest, body));
  }

  @Post()
  start(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    requireRole(ctx, 'owner', 'partner', 'accountant');
    return this.migrations.start(dbCtx(ctx), parse(StartMigrationRequest, body));
  }

  @Get(':id')
  get(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.migrations.get(dbCtx(ctx), parse(Id, id));
  }

  @Post(':id/commit')
  @HttpCode(200)
  commit(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    requireRole(ctx, 'owner', 'partner', 'accountant');
    return this.migrations.commit(dbCtx(ctx), parse(Id, id));
  }

  /** Makes the transfers paired between the migration's accounts. */
  @Post(':id/transfers')
  @HttpCode(200)
  transfers(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    requireRole(ctx, 'owner', 'partner', 'accountant');
    return this.migrations.makeTransfers(dbCtx(ctx), parse(Id, id));
  }
}
