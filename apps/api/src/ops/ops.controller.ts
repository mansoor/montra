/** Plans, support access, help, notices and the staff console (ADR-0020). */
import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Headers,
  HttpCode,
  Inject,
  Param,
  Post,
  Put,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  AdminSetPlanRequest,
  AppVersionsDto,
  CheckoutRequest,
  ClientErrorRequest,
  CreateNoticeRequest,
  CreateSupportGrantRequest,
  CreateSupportRequest,
  SaveFeatureFlagRequest,
  SaveMerchantRequest,
  SaveMileageRateRequest,
} from '@montra/schemas';
import { z } from 'zod';
import { AuthGuard, Ctx, dbCtx, WorkspaceGuard, type RequestContext } from '../auth/auth.js';
import { AppError, badRequest } from '../common/errors.js';
import { requireWorkspaceAdmin, isAdmin } from '../common/roles.js';
import { parse } from '../common/zod.js';
import { AdminService } from './admin.service.js';
import { BillingService } from './billing.service.js';
import { METRICS_CONTENT_TYPE, MetricsService } from './metrics.js';
import { requireAdmin, StaffGuard, type StaffRequest } from './staff.js';
import { StatusService, SupportService } from './support.service.js';

const Id = z.uuid();
const Days = z.coerce.number().int().min(1).max(365).default(30);

@Controller('v1/workspaces/:workspaceId')
@UseGuards(AuthGuard, WorkspaceGuard)
export class WorkspaceOpsController {
  constructor(
    @Inject(BillingService) private readonly billing: BillingService,
    @Inject(SupportService) private readonly support: SupportService,
  ) {}

  @Get('billing')
  getBilling(@Ctx() ctx: RequestContext) {
    return this.billing.get(dbCtx(ctx), isAdmin(ctx.role));
  }

  @Post('billing/checkout')
  async checkout(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    requireWorkspaceAdmin(ctx);
    const { interval } = parse(CheckoutRequest, body);
    return { url: await this.billing.checkoutUrl(dbCtx(ctx), ctx.user.email, interval) };
  }

  @Post('billing/portal')
  async portal(@Ctx() ctx: RequestContext) {
    requireWorkspaceAdmin(ctx);
    return { url: await this.billing.portalUrl(dbCtx(ctx)) };
  }

  @Get('support-grants')
  async listGrants(@Ctx() ctx: RequestContext) {
    return { data: await this.support.listGrants(dbCtx(ctx)) };
  }

  @Post('support-grants')
  createGrant(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    requireWorkspaceAdmin(ctx);
    return this.support.createGrant(dbCtx(ctx), parse(CreateSupportGrantRequest, body));
  }

  @Delete('support-grants/:id')
  @HttpCode(204)
  async revokeGrant(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    requireWorkspaceAdmin(ctx);
    await this.support.revokeGrant(dbCtx(ctx), parse(Id, id));
  }
}

/** Not about a workspace: asking for help and sending in errors. */
@Controller('v1')
@UseGuards(AuthGuard)
export class SupportController {
  constructor(@Inject(SupportService) private readonly support: SupportService) {}

  @Post('support/requests')
  async createRequest(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    return this.support.createRequest(ctx.user.id, ctx.user.email, parse(CreateSupportRequest, body));
  }

  @Get('support/requests')
  async listRequests(@Ctx() ctx: RequestContext) {
    return { data: await this.support.listRequests(ctx.user.id) };
  }

  @Post('client-errors')
  @HttpCode(204)
  clientError(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    this.support.reportClientError(ctx.user.id, parse(ClientErrorRequest, body));
  }
}

/** Open to anyone: whether the service is up, and what's been announced (OPS-03). */
@Controller('v1')
export class StatusController {
  constructor(@Inject(StatusService) private readonly status: StatusService) {}

  @Get('status')
  getStatus() {
    return this.status.current();
  }
}

/** Called by the payment provider, which proves itself with a signature over the raw body. */
@Controller('v1/billing')
export class BillingWebhookController {
  constructor(@Inject(BillingService) private readonly billing: BillingService) {}

  @Post('stripe/webhook')
  @HttpCode(200)
  webhook(
    @Req() req: FastifyRequest & { rawBody?: Buffer },
    @Headers('stripe-signature') signature: string | undefined,
  ) {
    if (!req.rawBody) throw badRequest('billing.bad_request', 'A signed body is required');
    return this.billing.handleWebhook(req.rawBody, signature);
  }
}

/** Scraped by the monitoring system with its own token. Nothing answers here without one. */
@Controller('internal')
export class MetricsController {
  constructor(@Inject(MetricsService) private readonly metrics: MetricsService) {}

  @Get('metrics')
  @Header('content-type', METRICS_CONTENT_TYPE)
  async scrape(@Headers('authorization') authorization: string | undefined) {
    if (!this.metrics.authorized(authorization)) throw new AppError(404, 'not_found', 'Not found');
    return this.metrics.render();
  }
}

@Controller('v1/admin')
@UseGuards(AuthGuard, StaffGuard)
export class AdminController {
  constructor(@Inject(AdminService) private readonly admin: AdminService) {}

  @Get('me')
  me(@Req() req: StaffRequest) {
    return { role: req.staffRole };
  }

  @Get('accounts')
  async accounts(@Query('q') q: string | undefined) {
    return { data: await this.admin.findAccounts(q ?? '') };
  }

  @Get('accounts/:id/workspaces')
  async workspaces(@Param('id') id: string) {
    return { data: await this.admin.accountWorkspaces(parse(Id, id)) };
  }

  @Put('workspaces/:id/plan')
  @HttpCode(204)
  async setPlan(
    @Req() req: StaffRequest,
    @Ctx() ctx: RequestContext,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    requireAdmin(req);
    await this.admin.setPlan(ctx.user.id, parse(Id, id), parse(AdminSetPlanRequest, body));
  }

  @Get('support/:workspaceId')
  supportView(@Ctx() ctx: RequestContext, @Param('workspaceId') workspaceId: string) {
    return this.admin.supportView(ctx.user.id, parse(Id, workspaceId));
  }

  @Get('flags')
  async flags() {
    return { data: await this.admin.listFlags() };
  }

  @Put('flags')
  @HttpCode(204)
  async saveFlag(@Req() req: StaffRequest, @Ctx() ctx: RequestContext, @Body() body: unknown) {
    requireAdmin(req);
    await this.admin.saveFlag(ctx.user.id, parse(SaveFeatureFlagRequest, body));
  }

  @Delete('flags/:key')
  @HttpCode(204)
  async deleteFlag(@Req() req: StaffRequest, @Ctx() ctx: RequestContext, @Param('key') key: string) {
    requireAdmin(req);
    await this.admin.deleteFlag(ctx.user.id, key);
  }

  @Get('notices')
  async notices() {
    return { data: await this.admin.listNotices() };
  }

  @Post('notices')
  createNotice(@Req() req: StaffRequest, @Ctx() ctx: RequestContext, @Body() body: unknown) {
    requireAdmin(req);
    return this.admin.createNotice(ctx.user.id, parse(CreateNoticeRequest, body));
  }

  @Post('notices/:id/end')
  @HttpCode(204)
  async endNotice(@Req() req: StaffRequest, @Ctx() ctx: RequestContext, @Param('id') id: string) {
    requireAdmin(req);
    await this.admin.endNotice(ctx.user.id, parse(Id, id));
  }

  @Get('app-versions')
  appVersions() {
    return this.admin.appVersions();
  }

  @Put('app-versions')
  @HttpCode(204)
  async saveAppVersions(@Req() req: StaffRequest, @Ctx() ctx: RequestContext, @Body() body: unknown) {
    requireAdmin(req);
    await this.admin.saveAppVersions(ctx.user.id, parse(AppVersionsDto, body));
  }

  @Get('analytics/imports')
  async imports(@Query('days') days: string | undefined) {
    return { data: await this.admin.importFailures(parse(Days, days)) };
  }

  @Get('analytics/ai')
  async ai(@Query('days') days: string | undefined) {
    return { data: await this.admin.aiAccuracy(parse(Days, days)) };
  }

  @Get('support-requests')
  async supportRequests(@Query('status') status: string | undefined) {
    return { data: await this.admin.supportRequests(status === 'closed' ? 'closed' : 'open') };
  }

  @Get('support-requests/:id/screenshot')
  async screenshot(@Param('id') id: string, @Res() reply: FastifyReply) {
    const shot = await this.admin.supportScreenshot(parse(Id, id));
    // Whatever was uploaded, it's shown as a download and never run as a page.
    void reply
      .header('content-type', shot[0] === 0x89 ? 'image/png' : 'image/jpeg')
      .header('content-disposition', 'attachment; filename="screenshot"')
      .header('x-content-type-options', 'nosniff')
      .send(shot);
  }

  @Post('support-requests/:id/close')
  @HttpCode(204)
  async close(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    await this.admin.closeSupportRequest(ctx.user.id, parse(Id, id));
  }

  @Get('reference/merchants')
  async merchants(@Query('q') q: string | undefined) {
    return { data: await this.admin.merchants(q ?? '') };
  }

  @Put('reference/merchants')
  @HttpCode(204)
  async saveMerchant(@Req() req: StaffRequest, @Ctx() ctx: RequestContext, @Body() body: unknown) {
    requireAdmin(req);
    await this.admin.saveMerchant(ctx.user.id, parse(SaveMerchantRequest, body));
  }

  @Get('reference/mileage-rates')
  async mileage() {
    return { data: await this.admin.mileageRates() };
  }

  @Put('reference/mileage-rates')
  @HttpCode(204)
  async saveMileage(@Req() req: StaffRequest, @Ctx() ctx: RequestContext, @Body() body: unknown) {
    requireAdmin(req);
    await this.admin.saveMileageRate(ctx.user.id, parse(SaveMileageRateRequest, body));
  }
}
