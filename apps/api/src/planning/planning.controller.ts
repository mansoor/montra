import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { addDays, endOfMonth, startOfMonth } from '@montra/domain';
import {
  AcceptRecommendationRequest,
  AssignRequest,
  CalendarDateDto,
  CopyBudgetRequest,
  CreateBudgetRequest,
  CreateExpectedIncomeRequest,
  CreateGoalRequest,
  DraftBudgetRequest,
  DashboardChartsQuery,
  DashboardQuery,
  MonthSummaryQuery,
  SpendingExploreQuery,
  MoveRequest,
  PlanningSettingsDto,
  RecommendationStatus,
  SetCategoryBudgetRequest,
  UpdateBudgetPeriodRequest,
  UpdateBudgetRequest,
  UpdateExpectedIncomeRequest,
  UpdateGoalRequest,
  UpdatePlanningSettingsRequest,
} from '@montra/schemas';
import { z } from 'zod';
import { AuthGuard, Ctx, dbCtx, WorkspaceGuard, type RequestContext } from '../auth/auth.js';
import { IdempotencyInterceptor } from '../common/idempotency.interceptor.js';
import { parse } from '../common/zod.js';
import { BudgetsService } from './budgets.service.js';
import { FlowService } from './flow.service.js';
import { MonthSummaryService } from './month-summary.service.js';
import { GoalsService } from './goals.service.js';
import { IncomeService } from './income.service.js';
import { RecommendationsService } from './recommendations.service.js';
import { PlanningData } from './data.js';

const Id = z.uuid();
const EntityQuery = z.object({ entityId: z.uuid().optional() });

@Controller('v1/workspaces/:workspaceId')
@UseGuards(AuthGuard, WorkspaceGuard)
@UseInterceptors(IdempotencyInterceptor)
export class PlanningController {
  constructor(
    @Inject(BudgetsService) private readonly budgets: BudgetsService,
    @Inject(GoalsService) private readonly goals: GoalsService,
    @Inject(IncomeService) private readonly income: IncomeService,
    @Inject(FlowService) private readonly flow: FlowService,
    @Inject(MonthSummaryService) private readonly monthSummary: MonthSummaryService,
    @Inject(RecommendationsService) private readonly recs: RecommendationsService,
    @Inject(PlanningData) private readonly data: PlanningData,
  ) {}

  // ----- Budgets (BUD-01..10) ------------------------------------------------------------------------------

  @Get('budgets')
  async listBudgets(@Ctx() ctx: RequestContext, @Query() q: unknown) {
    return { data: await this.budgets.list(dbCtx(ctx), parse(EntityQuery, q).entityId) };
  }

  /** Explore spending's "Make this my budget": one category, this period, budget created when there is none. */
  @Post('budgets/set-category')
  @HttpCode(200)
  setCategory(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    return this.budgets.setCategory(dbCtx(ctx), parse(SetCategoryBudgetRequest, body));
  }

  @Post('budgets')
  createBudget(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    return this.budgets.create(dbCtx(ctx), parse(CreateBudgetRequest, body));
  }

  /** BUD-02: a draft from history; AI writes only the explanation. Nothing is saved. */
  @Post('budgets/draft')
  @HttpCode(200)
  draft(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    return this.budgets.draft(dbCtx(ctx), parse(DraftBudgetRequest, body));
  }

  @Patch('budgets/:id')
  updateBudget(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.budgets.update(dbCtx(ctx), parse(Id, id), parse(UpdateBudgetRequest, body));
  }

  @Get('budgets/:id/periods/current')
  currentPeriod(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.budgets.period(dbCtx(ctx), parse(Id, id));
  }

  @Get('budgets/:id/periods/:start')
  period(@Ctx() ctx: RequestContext, @Param('id') id: string, @Param('start') start: string) {
    return this.budgets.period(dbCtx(ctx), parse(Id, id), parse(CalendarDateDto, start));
  }

  @Patch('budgets/:id/periods/:start')
  updatePeriod(
    @Ctx() ctx: RequestContext,
    @Param('id') id: string,
    @Param('start') start: string,
    @Body() body: unknown,
  ) {
    return this.budgets.updatePeriod(
      dbCtx(ctx),
      parse(Id, id),
      parse(CalendarDateDto, start),
      parse(UpdateBudgetPeriodRequest, body),
    );
  }

  @Put('budgets/:id/periods/:start/lines/:categoryId')
  assign(
    @Ctx() ctx: RequestContext,
    @Param('id') id: string,
    @Param('start') start: string,
    @Param('categoryId') categoryId: string,
    @Body() body: unknown,
  ) {
    return this.budgets.assign(
      dbCtx(ctx),
      parse(Id, id),
      parse(CalendarDateDto, start),
      parse(Id, categoryId),
      parse(AssignRequest, body),
    );
  }

  @Get('budgets/:id/periods/:start/moves')
  async moves(@Ctx() ctx: RequestContext, @Param('id') id: string, @Param('start') start: string) {
    return { data: await this.budgets.moves(dbCtx(ctx), parse(Id, id), parse(CalendarDateDto, start)) };
  }

  @Post('budgets/:id/periods/:start/moves')
  @HttpCode(200)
  move(
    @Ctx() ctx: RequestContext,
    @Param('id') id: string,
    @Param('start') start: string,
    @Body() body: unknown,
  ) {
    return this.budgets.move(
      dbCtx(ctx),
      parse(Id, id),
      parse(CalendarDateDto, start),
      parse(MoveRequest, body),
    );
  }

  @Post('budgets/:id/periods/:start/copy')
  @HttpCode(200)
  copy(
    @Ctx() ctx: RequestContext,
    @Param('id') id: string,
    @Param('start') start: string,
    @Body() body: unknown,
  ) {
    return this.budgets.copy(
      dbCtx(ctx),
      parse(Id, id),
      parse(CalendarDateDto, start),
      parse(CopyBudgetRequest, body),
    );
  }

  // ----- Goals (BUD-07/08, FAM-07) -------------------------------------------------------------------------

  @Get('goals')
  async listGoals(@Ctx() ctx: RequestContext, @Query() q: unknown) {
    return { data: await this.goals.list(dbCtx(ctx), parse(EntityQuery, q).entityId) };
  }

  @Post('goals')
  createGoal(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    return this.goals.create(dbCtx(ctx), parse(CreateGoalRequest, body));
  }

  @Get('goals/:id')
  goal(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.goals.get(dbCtx(ctx), parse(Id, id));
  }

  @Patch('goals/:id')
  updateGoal(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.goals.update(dbCtx(ctx), parse(Id, id), parse(UpdateGoalRequest, body));
  }

  // ----- Expected income (BUD-03) ------------------------------------------------------------------------

  @Get('expected-income')
  async listIncome(@Ctx() ctx: RequestContext, @Query() q: unknown) {
    return { data: await this.income.list(dbCtx(ctx), parse(EntityQuery, q).entityId) };
  }

  @Post('expected-income')
  createIncome(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    return this.income.create(dbCtx(ctx), parse(CreateExpectedIncomeRequest, body));
  }

  @Patch('expected-income/:id')
  updateIncome(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.income.update(dbCtx(ctx), parse(Id, id), parse(UpdateExpectedIncomeRequest, body));
  }

  // ----- Money flow (FLOW-01..07) ------------------------------------------------------------------------

  @Get('dashboard')
  dashboard(@Ctx() ctx: RequestContext, @Query() q: unknown) {
    const { entityId, memberId, period } = parse(DashboardQuery, q);
    return this.flow.dashboard(dbCtx(ctx), { entityId, memberId, period });
  }

  /** Month in review (FLOW-01, AIA-01): the figures, worded by the AI or in plain sentences. */
  @Get('summary/month')
  monthReview(@Ctx() ctx: RequestContext, @Query() q: unknown) {
    return this.monthSummary.month(dbCtx(ctx), parse(MonthSummaryQuery, q));
  }

  @Get('dashboard/charts')
  dashboardCharts(@Ctx() ctx: RequestContext, @Query() q: unknown) {
    const { entityId, memberId, months } = parse(DashboardChartsQuery, q);
    return this.flow.dashboardCharts(dbCtx(ctx), { entityId, memberId, months });
  }

  @Get('spending/explore')
  spendingExplore(@Ctx() ctx: RequestContext, @Query() q: unknown) {
    const { entityId, memberId, months, categoryIds } = parse(SpendingExploreQuery, q);
    return this.flow.spendingExplore(dbCtx(ctx), { entityId, memberId, months, categoryIds });
  }

  @Get('flow/sankey')
  async sankey(@Ctx() ctx: RequestContext, @Query() q: unknown) {
    const c = dbCtx(ctx);
    const p = parse(
      z.object({
        from: CalendarDateDto.optional(),
        to: CalendarDateDto.optional(),
        entityId: z.uuid().optional(),
      }),
      q,
    );
    const today = await this.data.db.run(c, (trx) => this.data.today(trx, c));
    const from = p.from ?? startOfMonth(today);
    return this.flow.sankey(c, from, p.to ?? endOfMonth(from), p.entityId);
  }

  @Get('flow/forecast')
  forecast(@Ctx() ctx: RequestContext, @Query() q: unknown) {
    const p = parse(
      z.object({ days: z.coerce.number().int().min(7).max(90).default(90), entityId: z.uuid().optional() }),
      q,
    );
    return this.flow.forecast(dbCtx(ctx), p.days, p.entityId);
  }

  @Get('calendar')
  async calendar(@Ctx() ctx: RequestContext, @Query() q: unknown) {
    const c = dbCtx(ctx);
    const p = parse(
      z.object({
        from: CalendarDateDto.optional(),
        to: CalendarDateDto.optional(),
        entityId: z.uuid().optional(),
      }),
      q,
    );
    const today = await this.data.db.run(c, (trx) => this.data.today(trx, c));
    const from = p.from ?? startOfMonth(today);
    return this.flow.calendar(c, from, p.to ?? addDays(from, 41), p.entityId);
  }

  @Get('net-worth')
  netWorth(@Ctx() ctx: RequestContext, @Query() q: unknown) {
    const p = parse(
      z.object({
        date: CalendarDateDto.optional(),
        entityId: z.uuid().optional(),
        months: z.coerce.number().int().min(1).max(60).default(12),
      }),
      q,
    );
    return this.flow.netWorth(dbCtx(ctx), p);
  }

  // ----- Recommendations (REC-01..08) --------------------------------------------------------------------

  @Get('recommendations')
  async recommendations(@Ctx() ctx: RequestContext, @Query() q: unknown) {
    const p = parse(z.object({ entityId: z.uuid().optional(), status: RecommendationStatus.optional() }), q);
    return { data: await this.recs.list(dbCtx(ctx), p) };
  }

  /** Runs the rules now (the nightly job does the same). */
  @Post('recommendations/refresh')
  @HttpCode(200)
  refresh(@Ctx() ctx: RequestContext) {
    return this.recs.refresh(dbCtx(ctx));
  }

  @Post('recommendations/:id/accept')
  @HttpCode(200)
  accept(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.recs.accept(dbCtx(ctx), parse(Id, id), parse(AcceptRecommendationRequest, body ?? {}));
  }

  @Post('recommendations/:id/dismiss')
  @HttpCode(200)
  dismiss(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.recs.dismiss(dbCtx(ctx), parse(Id, id));
  }

  @Get('planning/settings')
  async settings(@Ctx() ctx: RequestContext) {
    return PlanningSettingsDto.parse(await this.recs.settings(dbCtx(ctx)));
  }

  @Patch('planning/settings')
  async updateSettings(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    return PlanningSettingsDto.parse(
      await this.recs.updateSettings(dbCtx(ctx), parse(UpdatePlanningSettingsRequest, body)),
    );
  }
}
