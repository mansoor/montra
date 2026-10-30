import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  AcceptCategoryProposalsRequest,
  AcceptInsightRequest,
  AcceptReviewRequest,
  AcceptRuleSuggestionRequest,
  CreateRuleRequest,
  ParseQuickAddRequest,
  ResolveReviewRequest,
  RulePreviewRequest,
  SuggestRequest,
  UpdateRuleRequest,
  type RuleConditions,
} from '@montra/schemas';
import { calendarDate } from '@montra/domain';
import { z } from 'zod';
import { AuthGuard, Ctx, dbCtx, WorkspaceGuard, type RequestContext } from '../auth/auth.js';
import { Db } from '../db/database.js';
import { parse } from '../common/zod.js';
import { requireRole } from '../common/roles.js';
import { RulesService } from './rules.service.js';
import { ReviewService } from './review.service.js';
import { InsightsService } from './insights.service.js';

const uuid = (v: string) => parse(z.uuid(), v);
const EDITORS = ['owner', 'partner', 'accountant'] as const;

/** Rules, rule suggestions, review queue, suggestions, quick add, category proposals and insights (ADR-0012). */
@Controller('v1/workspaces/:workspaceId')
@UseGuards(AuthGuard, WorkspaceGuard)
export class CategorizationController {
  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(RulesService) private readonly rules: RulesService,
    @Inject(ReviewService) private readonly review: ReviewService,
    @Inject(InsightsService) private readonly insights: InsightsService,
  ) {}

  // ----- Rules (UP-02) ------------------------------------------------------------------------------------

  @Get('rules')
  async listRules(@Ctx() ctx: RequestContext) {
    const c = dbCtx(ctx);
    return { data: await this.db.run(c, (trx) => this.rules.list(trx, c)) };
  }

  @Post('rules')
  createRule(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    requireRole(ctx, ...EDITORS);
    const req = parse(CreateRuleRequest, body);
    const c = dbCtx(ctx);
    return this.db.run(c, (trx) => this.rules.create(trx, c, req));
  }

  @Post('rules/preview')
  @HttpCode(200)
  previewDraft(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    const req = parse(RulePreviewRequest, body);
    const c = dbCtx(ctx);
    return this.db.run(c, (trx) => this.rules.preview(trx, c, req.conditions, req.actions, req.entityId));
  }

  @Get('rules/:id')
  getRule(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    const c = dbCtx(ctx);
    return this.db.run(c, (trx) => this.rules.get(trx, c, uuid(id)));
  }

  @Patch('rules/:id')
  updateRule(
    @Ctx() ctx: RequestContext,
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('if-match') ifMatch?: string,
  ) {
    requireRole(ctx, ...EDITORS);
    const req = parse(UpdateRuleRequest, body);
    const c = dbCtx(ctx);
    return this.db.run(c, (trx) => this.rules.update(trx, c, uuid(id), req, ifMatch));
  }

  @Delete('rules/:id')
  @HttpCode(204)
  async deleteRule(@Ctx() ctx: RequestContext, @Param('id') id: string): Promise<void> {
    requireRole(ctx, ...EDITORS);
    const c = dbCtx(ctx);
    await this.db.run(c, (trx) => this.rules.remove(trx, c, uuid(id)));
  }

  @Post('rules/:id/preview')
  @HttpCode(200)
  previewRule(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    const c = dbCtx(ctx);
    return this.db.run(c, async (trx) => {
      const r = await this.rules.get(trx, c, uuid(id));
      return this.rules.preview(trx, c, r.conditions as RuleConditions, r.actions, r.entityId);
    });
  }

  @Post('rules/:id/apply')
  @HttpCode(202)
  async applyRule(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    requireRole(ctx, ...EDITORS);
    const c = dbCtx(ctx);
    const jobId = await this.db.run(c, (trx) => this.rules.startApply(trx, c, uuid(id)));
    return this.job(c, jobId);
  }

  @Get('rule-suggestions')
  async ruleSuggestions(@Ctx() ctx: RequestContext) {
    const c = dbCtx(ctx);
    return { data: await this.db.run(c, (trx) => this.rules.suggestions(trx, c)) };
  }

  @Post('rule-suggestions/:id/accept')
  async acceptSuggestion(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    requireRole(ctx, ...EDITORS);
    const req = parse(AcceptRuleSuggestionRequest, body ?? {});
    const c = dbCtx(ctx);
    const { rule, jobId } = await this.db.run(c, (trx) =>
      this.rules.acceptSuggestion(trx, c, uuid(id), req.applyToExisting),
    );
    return { rule, job: jobId ? await this.job(c, jobId) : null };
  }

  @Post('rule-suggestions/:id/dismiss')
  @HttpCode(204)
  async dismissSuggestion(@Ctx() ctx: RequestContext, @Param('id') id: string): Promise<void> {
    const c = dbCtx(ctx);
    await this.db.run(c, (trx) => this.rules.dismissSuggestion(trx, c, uuid(id)));
  }

  // ----- Review queue (AI-03/04) --------------------------------------------------------------------------

  @Get('review')
  reviewList(
    @Ctx() ctx: RequestContext,
    @Query('entityId') entityId?: string,
    @Query('minConfidence') minConfidence?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    const c = dbCtx(ctx);
    return this.db.run(c, (trx) =>
      this.review.list(trx, c, {
        entityId: entityId ? uuid(entityId) : undefined,
        minConfidence:
          minConfidence !== undefined ? parse(z.coerce.number().min(0).max(1), minConfidence) : undefined,
        cursor,
        limit: limit ? parse(z.coerce.number().int().min(1).max(500), limit) : undefined,
      }),
    );
  }

  @Post('review/accept')
  @HttpCode(200)
  reviewAccept(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    requireRole(ctx, ...EDITORS);
    const req = parse(AcceptReviewRequest, body);
    const c = dbCtx(ctx);
    return this.db.run(c, (trx) => this.review.accept(trx, c, req));
  }

  @Post('review/:transactionId/resolve')
  @HttpCode(200)
  reviewResolve(@Ctx() ctx: RequestContext, @Param('transactionId') id: string, @Body() body: unknown) {
    requireRole(ctx, ...EDITORS);
    const req = parse(ResolveReviewRequest, body);
    const c = dbCtx(ctx);
    return this.db.run(c, (trx) => this.review.resolve(trx, c, uuid(id), req));
  }

  // ----- Suggestions and quick add ------------------------------------------------------------------------

  @Post('categorize/suggest')
  @HttpCode(200)
  suggest(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    const req = parse(SuggestRequest, body);
    const c = dbCtx(ctx);
    return this.db.run(c, (trx) => this.review.suggest(trx, c, req));
  }

  @Post('transactions/parse')
  @HttpCode(200)
  parseQuickAdd(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    const req = parse(ParseQuickAddRequest, body);
    const c = dbCtx(ctx);
    return this.db.run(c, (trx) => this.review.parseQuickAdd(trx, c, req.text, calendarDate(req.today)));
  }

  // ----- Category proposals (UP-03) -----------------------------------------------------------------------

  @Get('imports/:id/category-proposals')
  proposals(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    const c = dbCtx(ctx);
    return this.db.run(c, (trx) => this.review.proposals(trx, c, uuid(id)));
  }

  @Post('imports/:id/category-proposals/accept')
  @HttpCode(200)
  acceptProposals(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    requireRole(ctx, ...EDITORS);
    const req = parse(AcceptCategoryProposalsRequest, body);
    const c = dbCtx(ctx);
    return this.db.run(c, (trx) => this.review.acceptProposals(trx, c, uuid(id), req.names));
  }

  // ----- Insights (AI-08/09) ------------------------------------------------------------------------------

  @Get('insights')
  async listInsights(@Ctx() ctx: RequestContext, @Query('status') status?: string) {
    const c = dbCtx(ctx);
    const st = status ? parse(z.enum(['open', 'dismissed', 'accepted']), status) : 'open';
    return { data: await this.db.run(c, (trx) => this.insights.list(trx, c, st)) };
  }

  @Post('insights/:id/accept')
  @HttpCode(200)
  acceptInsight(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    const req = parse(AcceptInsightRequest, body ?? {});
    return this.insights.accept(dbCtx(ctx), uuid(id), req);
  }

  @Post('insights/:id/dismiss')
  @HttpCode(200)
  dismissInsight(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    const c = dbCtx(ctx);
    return this.db.run(c, (trx) => this.insights.dismiss(trx, c, uuid(id)));
  }

  /** Refresh recurring proposals and anomaly flags now (they also run after each import). */
  @Post('insights/detect')
  @HttpCode(200)
  detect(@Ctx() ctx: RequestContext) {
    const c = dbCtx(ctx);
    return this.db.run(c, (trx) =>
      this.insights.detect(trx, c, calendarDate(new Date().toISOString().slice(0, 10))),
    );
  }

  private async job(c: { workspaceId: string; userId: string }, id: string) {
    const j = await this.db.run(c, (trx) =>
      trx
        .selectFrom('app.job')
        .selectAll()
        .where('workspace_id', '=', c.workspaceId)
        .where('id', '=', id)
        .executeTakeFirstOrThrow(),
    );
    return {
      id: j.id,
      type: j.type,
      status: j.status,
      progress: j.progress ?? null,
      error: j.error ?? null,
      result: (j.result as Record<string, unknown> | null) ?? null,
      createdAt: j.created_at.toISOString(),
      finishedAt: j.finished_at?.toISOString() ?? null,
    };
  }
}
