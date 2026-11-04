import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  Res,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import {
  AskRequest,
  CreateSavedReportRequest,
  ReportExportFormat,
  ReportFilters,
  ReportType,
} from '@montra/schemas';
import { z } from 'zod';
import {
  AuthGuard,
  Ctx,
  dbCtx,
  requireRecentAuth,
  WorkspaceGuard,
  type RequestContext,
} from '../auth/auth.js';
import { IdempotencyInterceptor } from '../common/idempotency.interceptor.js';
import { parse } from '../common/zod.js';
import { Db } from '../db/database.js';
import { renderReport } from './report-render.js';
import { ReportsService } from './reports.service.js';
import { SearchService } from './search.service.js';

const Id = z.uuid();

@Controller('v1/workspaces/:workspaceId')
@UseGuards(AuthGuard, WorkspaceGuard)
@UseInterceptors(IdempotencyInterceptor)
export class ReportsController {
  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(ReportsService) private readonly reports: ReportsService,
    @Inject(SearchService) private readonly searchService: SearchService,
  ) {}

  /** Separate from the richer `reports/pnl`, `reports/schedule-c` and so on, which keep their own shapes for their own screens. */
  @Get('reports/catalog/:type')
  catalog(@Ctx() ctx: RequestContext, @Param('type') type: string, @Query() q: unknown) {
    return this.reports.run(dbCtx(ctx), parse(ReportType, type), parse(ReportFilters, q));
  }

  @Get('reports/catalog/:type/export')
  async export(
    @Ctx() ctx: RequestContext,
    @Param('type') type: string,
    @Query() q: unknown,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Buffer> {
    // AUTH-09: taking the books out is a sensitive action.
    requireRecentAuth(ctx);
    const { format, ...rest } = parse(ReportFilters.extend({ format: ReportExportFormat }), q);
    const c = dbCtx(ctx);
    const report = await this.reports.run(c, parse(ReportType, type), rest);
    const scope = await this.db.run(c, async (trx) => {
      const name = rest.entityId
        ? await trx
            .selectFrom('app.entity')
            .select('name')
            .where('workspace_id', '=', c.workspaceId)
            .where('id', '=', rest.entityId)
            .executeTakeFirst()
        : await trx
            .selectFrom('app.workspace')
            .select('name')
            .where('id', '=', c.workspaceId)
            .executeTakeFirst();
      return name?.name ?? '';
    });
    const f = await renderReport(report, format, scope);
    void reply.header('content-type', f.mime);
    void reply.header('content-disposition', `attachment; filename="${f.fileName.replace(/[^\w.-]/g, '_')}"`);
    void reply.header('cache-control', 'private, no-store');
    void reply.header('x-content-type-options', 'nosniff');
    return Buffer.from(f.bytes);
  }

  @Get('saved-reports')
  async saved(@Ctx() ctx: RequestContext) {
    return { data: await this.reports.listSaved(dbCtx(ctx)) };
  }

  @Post('saved-reports')
  createSaved(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    return this.reports.createSaved(dbCtx(ctx), parse(CreateSavedReportRequest, body));
  }

  @Delete('saved-reports/:id')
  @HttpCode(204)
  async removeSaved(@Ctx() ctx: RequestContext, @Param('id') id: string): Promise<void> {
    await this.reports.removeSaved(dbCtx(ctx), parse(Id, id));
  }

  @Get('search')
  search(@Ctx() ctx: RequestContext, @Query() q: unknown) {
    const { q: text } = parse(z.object({ q: z.string().max(500).default('') }), q);
    return this.searchService.search(dbCtx(ctx), text);
  }

  @Post('ask')
  @HttpCode(200)
  ask(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    return this.searchService.ask(dbCtx(ctx), parse(AskRequest, body).question);
  }
}
