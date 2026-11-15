import { Body, Controller, Get, Inject, Param, Post, UseGuards, UseInterceptors } from '@nestjs/common';
import { CreateScanRequest, type ScanDto } from '@montra/schemas';
import { z } from 'zod';
import { AuthGuard, Ctx, dbCtx, WorkspaceGuard, type RequestContext } from '../auth/auth.js';
import { IdempotencyInterceptor } from '../common/idempotency.interceptor.js';
import { requireRole } from '../common/roles.js';
import { parse } from '../common/zod.js';
import { Plans } from '../ops/plans.js';
import { ScansService } from './scans.service.js';

/** Scanned documents read before they're filed (ADR-0048 §3). Each scan is its uploader's own. */
@Controller('v1/workspaces/:workspaceId/scans')
@UseGuards(AuthGuard, WorkspaceGuard)
@UseInterceptors(IdempotencyInterceptor)
export class ScansController {
  constructor(
    @Inject(ScansService) private readonly scans: ScansService,
    @Inject(Plans) private readonly plans: Plans,
  ) {}

  @Post()
  async create(@Ctx() ctx: RequestContext, @Body() body: unknown): Promise<ScanDto> {
    const req = parse(CreateScanRequest, body);
    // Statements are imported by the same people who import files (AUTH-18).
    if (req.kind === 'statement') requireRole(ctx, 'owner', 'admin', 'partner', 'accountant');
    await this.plans.requireFeature(dbCtx(ctx), 'scans');
    return this.scans.create(dbCtx(ctx), req);
  }

  @Get(':id')
  get(@Ctx() ctx: RequestContext, @Param('id') id: string): Promise<ScanDto> {
    return this.scans.get(dbCtx(ctx), parse(z.uuid(), id));
  }
}
