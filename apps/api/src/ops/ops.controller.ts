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
  AddPlanPriceRequest,
  AdminLogQuery,
  AddPlanVersionRequest,
  AdminSetPlanRequest,
  CloseAccountRequest,
  CouponRequest,
  ExtendTrialRequest,
  SuspendRequest,
  MoveSubscribersRequest,
  SavePlanRequest,
  SetStaffRequest,
  AppVersionsDto,
  type AppRequirementsDto,
  PasswordPolicyDto,
  CheckoutRequest,
  ClientErrorRequest,
  CreateNoticeRequest,
  CreateSupportGrantRequest,
  CreateSupportRequest,
  SaveAiCeilingRequest,
  SaveProviderSettingsRequest,
  SaveFeatureFlagRequest,
  SaveImportProfileRequest,
  SaveMerchantRequest,
  SaveMileageRateRequest,
  SaveTaxLineRequest,
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
import { AppError, badRequest } from '../common/errors.js';
import { requireWorkspaceAdmin, isAdmin } from '../common/roles.js';
import { parse } from '../common/zod.js';
import { Db } from '../db/database.js';
import { AdminAccountsService } from './admin-accounts.service.js';
import { AdminPlansService } from './admin-plans.service.js';
import { AdminService } from './admin.service.js';
import { Plans } from './plans.js';
import { ProvidersService } from './providers.service.js';
import { BillingService } from './billing.service.js';
import { AppVersionInterceptor, METRICS_CONTENT_TYPE, MetricsService } from './metrics.js';
import { requireAdmin, requireOwner, StaffGuard, type StaffRequest } from './staff.js';
import { StatusService, SupportService } from './support.service.js';

const Id = z.uuid();
const ImportProfileId = z.string().max(100);
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
    const { plan, interval } = parse(CheckoutRequest, body);
    return { url: await this.billing.checkoutUrl(dbCtx(ctx), ctx.user.email, plan, interval) };
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

/** The plan picker (ADR-0049 §1): what new customers can choose, on web and phone. */
@Controller('v1/plans')
@UseGuards(AuthGuard)
export class PlansController {
  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(Plans) private readonly plans: Plans,
  ) {}

  @Get()
  async offers() {
    return { data: await this.db.run({}, (trx) => this.plans.offers(trx)) };
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
  constructor(
    @Inject(StatusService) private readonly status: StatusService,
    @Inject(AppVersionInterceptor) private readonly versions: AppVersionInterceptor,
  ) {}

  /** OPS-04: public, so a phone app can check it's new enough for this server before anyone signs in. */
  @Get('app/requirements')
  appRequirements(@Query('platform') platform: string): Promise<AppRequirementsDto> {
    if (platform !== 'ios' && platform !== 'android')
      throw new AppError(400, 'app.platform_invalid', 'platform must be ios or android');
    return this.versions.requirements(platform);
  }

  @Get('status')
  getStatus() {
    return this.status.current();
  }

  /** AUTH-02: public, so the sign-up page can show the policy before anyone has an account. */
  @Get('password-policy')
  passwordPolicy() {
    return this.status.passwordPolicy();
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
  constructor(
    @Inject(AdminService) private readonly admin: AdminService,
    @Inject(AdminPlansService) private readonly owner: AdminPlansService,
    @Inject(AdminAccountsService) private readonly accountsAdmin: AdminAccountsService,
    @Inject(ProvidersService) private readonly providers: ProvidersService,
  ) {}

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
    await this.accountsAdmin.givePlan(ctx.user.id, parse(Id, id), parse(AdminSetPlanRequest, body));
  }

  // ----- Managing accounts (ADR-0049 §4) --------------------------------------------------------------

  @Post('accounts/:id/suspend')
  @HttpCode(204)
  async suspend(
    @Req() req: StaffRequest,
    @Ctx() ctx: RequestContext,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    requireAdmin(req);
    requireRecentAuth(ctx);
    await this.accountsAdmin.suspend(ctx.user.id, parse(Id, id), parse(SuspendRequest, body));
  }

  @Post('accounts/:id/restore')
  @HttpCode(204)
  async restore(@Req() req: StaffRequest, @Ctx() ctx: RequestContext, @Param('id') id: string) {
    requireAdmin(req);
    await this.accountsAdmin.restore(ctx.user.id, parse(Id, id));
  }

  @Post('accounts/:id/close')
  closeAccount(
    @Req() req: StaffRequest,
    @Ctx() ctx: RequestContext,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    requireOwner(req, ctx);
    return this.accountsAdmin.close(ctx.user.id, parse(Id, id), parse(CloseAccountRequest, body));
  }

  @Post('workspaces/:id/trial')
  extendTrial(
    @Req() req: StaffRequest,
    @Ctx() ctx: RequestContext,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    requireAdmin(req);
    return this.accountsAdmin.extendTrial(ctx.user.id, parse(Id, id), parse(ExtendTrialRequest, body));
  }

  @Post('workspaces/:id/coupon')
  @HttpCode(204)
  async coupon(
    @Req() req: StaffRequest,
    @Ctx() ctx: RequestContext,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    requireAdmin(req);
    await this.accountsAdmin.coupon(ctx.user.id, parse(Id, id), parse(CouponRequest, body));
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

  @Get('password-policy')
  adminPasswordPolicy() {
    return this.admin.passwordPolicy();
  }

  @Put('password-policy')
  @HttpCode(204)
  async saveAdminPasswordPolicy(@Req() req: StaffRequest, @Ctx() ctx: RequestContext, @Body() body: unknown) {
    requireAdmin(req);
    await this.admin.savePasswordPolicy(ctx.user.id, parse(PasswordPolicyDto, body));
  }

  @Get('ai-ceiling')
  aiCeiling() {
    return this.admin.aiCeiling();
  }

  @Put('ai-ceiling')
  @HttpCode(204)
  async saveAiCeiling(@Req() req: StaffRequest, @Ctx() ctx: RequestContext, @Body() body: unknown) {
    requireOwner(req, ctx);
    await this.admin.saveAiCeiling(ctx.user.id, parse(SaveAiCeilingRequest, body));
  }

  // ----- Providers (ADR-0049 §5): the owner's, and nothing here can change a key ---------------------

  @Get('providers')
  async providerList(@Req() req: StaffRequest, @Ctx() ctx: RequestContext) {
    if (req.staffRole !== 'owner') throw new AppError(403, 'forbidden', 'This needs the owner role');
    return this.providers.providers(ctx.user.id);
  }

  @Put('providers/settings')
  @HttpCode(204)
  async saveProviderSettings(@Req() req: StaffRequest, @Ctx() ctx: RequestContext, @Body() body: unknown) {
    requireOwner(req, ctx);
    await this.providers.saveSettings(ctx.user.id, parse(SaveProviderSettingsRequest, body));
  }

  @Post('providers/test-email')
  @HttpCode(200)
  testEmail(@Req() req: StaffRequest, @Ctx() ctx: RequestContext) {
    if (req.staffRole !== 'owner') throw new AppError(403, 'forbidden', 'This needs the owner role');
    return this.providers.testEmail(ctx.user.email);
  }

  @Post('providers/test-text')
  @HttpCode(200)
  testText(@Req() req: StaffRequest, @Ctx() ctx: RequestContext) {
    if (req.staffRole !== 'owner') throw new AppError(403, 'forbidden', 'This needs the owner role');
    return this.providers.testText(ctx.user.id);
  }

  // ----- Staff and plans (ADR-0049 §1, §3) ------------------------------------------------------------

  @Get('staff')
  async staff(@Req() req: StaffRequest, @Ctx() ctx: RequestContext) {
    if (req.staffRole !== 'owner') throw new AppError(403, 'forbidden', 'This needs the owner role');
    return { data: await this.owner.staff(ctx.user.id) };
  }

  @Put('staff')
  @HttpCode(204)
  async setStaff(@Req() req: StaffRequest, @Ctx() ctx: RequestContext, @Body() body: unknown) {
    requireOwner(req, ctx);
    await this.owner.setStaff(ctx.user.id, ctx.user.email, parse(SetStaffRequest, body));
  }

  @Delete('staff/:userId')
  @HttpCode(204)
  async removeStaff(@Req() req: StaffRequest, @Ctx() ctx: RequestContext, @Param('userId') userId: string) {
    requireOwner(req, ctx);
    await this.owner.removeStaff(ctx.user.id, ctx.user.email, parse(Id, userId));
  }

  @Get('plans')
  async adminPlans() {
    return { data: await this.owner.plans() };
  }

  @Put('plans')
  @HttpCode(204)
  async savePlan(@Req() req: StaffRequest, @Ctx() ctx: RequestContext, @Body() body: unknown) {
    requireOwner(req, ctx);
    await this.owner.savePlan(ctx.user.id, parse(SavePlanRequest, body));
  }

  @Post('plans/:key/versions')
  addPlanVersion(
    @Req() req: StaffRequest,
    @Ctx() ctx: RequestContext,
    @Param('key') key: string,
    @Body() body: unknown,
  ) {
    requireOwner(req, ctx);
    return this.owner.addVersion(ctx.user.id, key, parse(AddPlanVersionRequest, body));
  }

  @Post('plan-versions/:id/prices')
  addPlanPrice(
    @Req() req: StaffRequest,
    @Ctx() ctx: RequestContext,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    requireOwner(req, ctx);
    return this.owner.addPrice(ctx.user.id, parse(Id, id), parse(AddPlanPriceRequest, body));
  }

  @Post('plan-prices/:id/end')
  @HttpCode(204)
  async endPlanPrice(@Req() req: StaffRequest, @Ctx() ctx: RequestContext, @Param('id') id: string) {
    requireOwner(req, ctx);
    await this.owner.endPrice(ctx.user.id, parse(Id, id));
  }

  @Post('plans/move')
  moveSubscribers(@Req() req: StaffRequest, @Ctx() ctx: RequestContext, @Body() body: unknown) {
    requireOwner(req, ctx);
    return this.owner.moveSubscribers(ctx.user.id, parse(MoveSubscribersRequest, body));
  }

  // ----- Staff log (OPS-01) ---------------------------------------------------------------------------

  /** What staff did, for admins and owners. Support staff don't read it. */
  @Get('log')
  async staffLog(@Req() req: StaffRequest, @Ctx() ctx: RequestContext, @Query() query: unknown) {
    requireAdmin(req);
    return this.admin.staffLog(ctx.user.id, parse(AdminLogQuery, query));
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

  @Get('reference/tax-lines')
  async taxLines() {
    return { data: await this.admin.taxLines() };
  }

  /** Add or change a tax line. There's no delete: categories may hold its code. */
  @Put('reference/tax-lines')
  @HttpCode(204)
  async saveTaxLine(@Req() req: StaffRequest, @Ctx() ctx: RequestContext, @Body() body: unknown) {
    requireAdmin(req);
    await this.admin.saveTaxLine(ctx.user.id, parse(SaveTaxLineRequest, body));
  }

  @Get('reference/import-profiles')
  async importProfiles() {
    return { data: await this.admin.importProfiles() };
  }

  @Put('reference/import-profiles')
  async saveImportProfile(@Req() req: StaffRequest, @Ctx() ctx: RequestContext, @Body() body: unknown) {
    requireAdmin(req);
    return this.admin.saveImportProfile(ctx.user.id, parse(SaveImportProfileRequest, body));
  }

  @Delete('reference/import-profiles/:id')
  @HttpCode(204)
  async deleteImportProfile(@Req() req: StaffRequest, @Ctx() ctx: RequestContext, @Param('id') id: string) {
    requireAdmin(req);
    await this.admin.deleteImportProfile(ctx.user.id, parse(ImportProfileId, id));
  }
}
