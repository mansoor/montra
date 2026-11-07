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
  Query,
  Req,
  Res,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  AllocateTransactionRequest,
  CalendarDateDto,
  CreateAllocationRuleRequest,
  CreateDepreciationRequest,
  CreateLeaseRequest,
  CreateLoanRequest,
  CreateMaintenanceRequest,
  CreatePropertyRequest,
  CreateReminderRequest,
  CreateTenantRequest,
  CreateUnitRequest,
  DepositEventRequest,
  LoanPaymentRequest,
  RentPaymentRequest,
  SavePropertyBudgetRequest,
  ScheduleEExportFormat,
  UpdateChargeRequest,
  UpdateLeaseRequest,
  UpdateLoanRequest,
  UpdateMaintenanceRequest,
  UpdatePropertyRequest,
  UpdateReminderRequest,
  UpdateTenantRequest,
  UpdateUnitRequest,
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
import { BusinessService } from '../business/business.service.js';
import { AppError } from '../common/errors.js';
import { IdempotencyInterceptor } from '../common/idempotency.interceptor.js';
import { parse } from '../common/zod.js';
import { CONFIG, type AppConfig } from '../config.js';
import { Db } from '../db/database.js';
import { LoansService } from './loans.service.js';
import { PropertiesService } from './properties.service.js';
import { RentService } from './rent.service.js';
import { RentalOpsService } from './rental-ops.service.js';
import { RentalReportsService } from './rental-reports.service.js';

const Id = z.uuid();
const EntityQuery = z.object({ entityId: z.uuid() });
const Year = z.coerce.number().int().min(2000).max(2100).optional();
const safeName = (name: string) => name.replace(/[^\w.-]/g, '_');

@Controller('v1/workspaces/:workspaceId')
@UseGuards(AuthGuard, WorkspaceGuard)
@UseInterceptors(IdempotencyInterceptor)
export class RentalsController {
  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(Db) private readonly db: Db,
    @Inject(BusinessService) private readonly files: BusinessService,
    @Inject(PropertiesService) private readonly properties: PropertiesService,
    @Inject(RentService) private readonly rent: RentService,
    @Inject(LoansService) private readonly loans: LoansService,
    @Inject(RentalOpsService) private readonly ops: RentalOpsService,
    @Inject(RentalReportsService) private readonly reports: RentalReportsService,
  ) {}

  // ----- Properties and units (RNT-01, RNT-02) -----------------------------------------------------------------

  @Get('properties')
  async listProperties(@Ctx() ctx: RequestContext, @Query() q: unknown) {
    const { entityId } = parse(EntityQuery, q);
    return { data: await this.properties.list(dbCtx(ctx), entityId) };
  }

  @Post('properties')
  createProperty(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    return this.properties.create(dbCtx(ctx), parse(CreatePropertyRequest, body));
  }

  @Get('properties/:id')
  getProperty(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.properties.get(dbCtx(ctx), parse(Id, id));
  }

  @Patch('properties/:id')
  updateProperty(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.properties.update(dbCtx(ctx), parse(Id, id), parse(UpdatePropertyRequest, body));
  }

  @Post('properties/:id/units')
  createUnit(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.properties.createUnit(dbCtx(ctx), parse(Id, id), parse(CreateUnitRequest, body));
  }

  @Patch('units/:id')
  updateUnit(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.properties.updateUnit(dbCtx(ctx), parse(Id, id), parse(UpdateUnitRequest, body));
  }

  // ----- Tenants and leases (RNT-03) ---------------------------------------------------------------------------

  @Get('tenants')
  async listTenants(@Ctx() ctx: RequestContext, @Query() q: unknown) {
    const { entityId } = parse(EntityQuery, q);
    return { data: await this.properties.listTenants(dbCtx(ctx), entityId) };
  }

  @Post('tenants')
  createTenant(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    return this.properties.createTenant(dbCtx(ctx), parse(CreateTenantRequest, body));
  }

  @Patch('tenants/:id')
  updateTenant(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.properties.updateTenant(dbCtx(ctx), parse(Id, id), parse(UpdateTenantRequest, body));
  }

  @Get('leases')
  async listLeases(@Ctx() ctx: RequestContext, @Query() q: unknown) {
    const opts = parse(EntityQuery.extend({ propertyId: z.uuid().optional() }), q);
    return { data: await this.properties.listLeases(dbCtx(ctx), opts) };
  }

  @Post('leases')
  createLease(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    return this.properties.createLease(dbCtx(ctx), parse(CreateLeaseRequest, body));
  }

  @Get('leases/:id')
  getLease(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.properties.getLease(dbCtx(ctx), parse(Id, id));
  }

  @Patch('leases/:id')
  updateLease(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.properties.updateLease(dbCtx(ctx), parse(Id, id), parse(UpdateLeaseRequest, body));
  }

  // ----- Rent (RNT-04, RNT-05, RNT-10) -------------------------------------------------------------------------

  @Get('rent-roll')
  rentRoll(@Ctx() ctx: RequestContext, @Query() q: unknown) {
    const { entityId, month } = parse(EntityQuery.extend({ month: CalendarDateDto.optional() }), q);
    return this.rent.rentRoll(dbCtx(ctx), entityId, month);
  }

  @Get('arrears')
  arrears(@Ctx() ctx: RequestContext, @Query() q: unknown) {
    const { entityId } = parse(EntityQuery, q);
    return this.rent.arrears(dbCtx(ctx), entityId);
  }

  @Patch('rent-charges/:id')
  updateCharge(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.rent.updateCharge(dbCtx(ctx), parse(Id, id), parse(UpdateChargeRequest, body));
  }

  @Get('leases/:id/payments')
  async listPayments(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return { data: await this.rent.listPayments(dbCtx(ctx), parse(Id, id)) };
  }

  @Get('leases/:id/candidates')
  async candidates(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return { data: await this.rent.candidates(dbCtx(ctx), parse(Id, id)) };
  }

  @Post('leases/:id/payments')
  recordPayment(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.rent.recordPayment(dbCtx(ctx), parse(Id, id), parse(RentPaymentRequest, body));
  }

  @Delete('leases/:id/payments/:paymentId')
  @HttpCode(204)
  async removePayment(
    @Ctx() ctx: RequestContext,
    @Param('id') id: string,
    @Param('paymentId') paymentId: string,
  ): Promise<void> {
    await this.rent.removePayment(dbCtx(ctx), parse(Id, id), parse(Id, paymentId));
  }

  @Post('leases/:id/deposit-events')
  addDepositEvent(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.rent.addDepositEvent(dbCtx(ctx), parse(Id, id), parse(DepositEventRequest, body));
  }

  @Delete('leases/:id/deposit-events/:eventId')
  removeDepositEvent(@Ctx() ctx: RequestContext, @Param('id') id: string, @Param('eventId') eventId: string) {
    return this.rent.removeDepositEvent(dbCtx(ctx), parse(Id, id), parse(Id, eventId));
  }

  // ----- Shared expenses (RNT-07) ------------------------------------------------------------------------------

  @Get('allocation-rules')
  async listRules(@Ctx() ctx: RequestContext, @Query() q: unknown) {
    const { entityId } = parse(EntityQuery, q);
    return { data: await this.ops.listRules(dbCtx(ctx), entityId) };
  }

  @Post('allocation-rules')
  createRule(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    return this.ops.createRule(dbCtx(ctx), parse(CreateAllocationRuleRequest, body));
  }

  @Delete('allocation-rules/:id')
  @HttpCode(204)
  async removeRule(@Ctx() ctx: RequestContext, @Param('id') id: string): Promise<void> {
    await this.ops.removeRule(dbCtx(ctx), parse(Id, id));
  }

  @Post('transactions/:id/allocate')
  @HttpCode(200)
  allocate(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.ops.allocate(dbCtx(ctx), parse(Id, id), parse(AllocateTransactionRequest, body));
  }

  // ----- Mortgages (RNT-08) ------------------------------------------------------------------------------------

  @Get('loans')
  async listLoans(@Ctx() ctx: RequestContext, @Query() q: unknown) {
    const { entityId } = parse(EntityQuery.partial(), q);
    return { data: await this.loans.list(dbCtx(ctx), entityId) };
  }

  @Post('loans')
  createLoan(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    return this.loans.create(dbCtx(ctx), parse(CreateLoanRequest, body));
  }

  @Patch('loans/:id')
  updateLoan(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.loans.update(dbCtx(ctx), parse(Id, id), parse(UpdateLoanRequest, body));
  }

  @Get('loans/:id/schedule')
  async loanSchedule(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return { data: await this.loans.schedule(dbCtx(ctx), parse(Id, id)) };
  }

  @Post('loans/:id/payments')
  loanPayment(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.loans.recordPayment(dbCtx(ctx), parse(Id, id), parse(LoanPaymentRequest, body));
  }

  @Delete('loans/:id/payments/:number')
  removeLoanPayment(@Ctx() ctx: RequestContext, @Param('id') id: string, @Param('number') number: string) {
    return this.loans.removePayment(
      dbCtx(ctx),
      parse(Id, id),
      parse(z.coerce.number().int().positive(), number),
    );
  }

  // ----- Depreciation (RNT-09) ---------------------------------------------------------------------------------

  @Get('properties/:id/depreciation')
  async depreciation(@Ctx() ctx: RequestContext, @Param('id') id: string, @Query() q: unknown) {
    const { year } = parse(z.object({ year: Year }), q);
    return { data: await this.reports.listDepreciation(dbCtx(ctx), parse(Id, id), year) };
  }

  @Post('depreciation')
  createDepreciation(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    return this.reports.createDepreciation(dbCtx(ctx), parse(CreateDepreciationRequest, body));
  }

  @Delete('depreciation/:id')
  @HttpCode(204)
  async removeDepreciation(@Ctx() ctx: RequestContext, @Param('id') id: string): Promise<void> {
    await this.reports.removeDepreciation(dbCtx(ctx), parse(Id, id));
  }

  // ----- Reminders and maintenance (RNT-12, RNT-13) ------------------------------------------------------------

  @Get('reminders')
  async reminders(@Ctx() ctx: RequestContext, @Query() q: unknown) {
    const { entityId } = parse(EntityQuery, q);
    return { data: await this.ops.reminders(dbCtx(ctx), entityId) };
  }

  @Post('reminders')
  createReminder(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    return this.ops.createReminder(dbCtx(ctx), parse(CreateReminderRequest, body));
  }

  @Patch('reminders/:id')
  updateReminder(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.ops.updateReminder(dbCtx(ctx), parse(Id, id), parse(UpdateReminderRequest, body));
  }

  @Get('maintenance')
  async maintenance(@Ctx() ctx: RequestContext, @Query() q: unknown) {
    const opts = parse(EntityQuery.extend({ propertyId: z.uuid().optional() }), q);
    return { data: await this.ops.listMaintenance(dbCtx(ctx), opts) };
  }

  @Post('maintenance')
  createMaintenance(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    return this.ops.createMaintenance(dbCtx(ctx), parse(CreateMaintenanceRequest, body));
  }

  @Patch('maintenance/:id')
  updateMaintenance(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.ops.updateMaintenance(dbCtx(ctx), parse(Id, id), parse(UpdateMaintenanceRequest, body));
  }

  @Post('rentals/files')
  async upload(@Ctx() ctx: RequestContext, @Req() req: FastifyRequest) {
    if (!req.isMultipart()) {
      throw new AppError(415, 'upload.multipart_required', 'Send the file as multipart/form-data');
    }
    const part = await req.file({ limits: { fileSize: this.config.MAX_UPLOAD_BYTES, files: 1 } });
    if (!part) throw new AppError(400, 'upload.no_file', 'No file in the request');
    const bytes = new Uint8Array(await part.toBuffer());
    if (part.file.truncated) {
      throw new AppError(
        413,
        'upload.too_large',
        `Files can be up to ${this.config.MAX_UPLOAD_BYTES / 1_048_576} MB`,
      );
    }
    if (bytes.length === 0) throw new AppError(400, 'upload.empty', 'The file is empty');
    return this.files.uploadFile(dbCtx(ctx), bytes, part.filename || 'document');
  }

  /** A lease document or maintenance photo. It must be on a record this login can read, not merely in the workspace. */
  @Get('rentals/:kind/:id/files/:fileId')
  async file(
    @Ctx() ctx: RequestContext,
    @Param('kind') kind: string,
    @Param('id') id: string,
    @Param('fileId') fileId: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Buffer> {
    const k = parse(z.enum(['leases', 'maintenance']), kind);
    const c = dbCtx(ctx);
    const f = await this.db.run(c, async (trx) => {
      const row =
        k === 'leases'
          ? await trx
              .selectFrom('app.lease')
              .select('attachment_ids')
              .where('workspace_id', '=', c.workspaceId)
              .where('id', '=', parse(Id, id))
              .executeTakeFirst()
          : await trx
              .selectFrom('app.maintenance_log')
              .select('attachment_ids')
              .where('workspace_id', '=', c.workspaceId)
              .where('id', '=', parse(Id, id))
              .executeTakeFirst();
      if (!row?.attachment_ids.includes(parse(Id, fileId)))
        throw new AppError(404, 'not_found', 'File not found');
      return this.files.fileBytes(trx, c, fileId);
    });
    void reply.header('content-type', f.mime);
    void reply.header('cache-control', 'private, no-store');
    void reply.header('x-content-type-options', 'nosniff');
    return Buffer.from(f.bytes);
  }

  // ----- Budgets per property (RNT-14) -------------------------------------------------------------------------

  @Get('properties/:id/budget')
  budget(@Ctx() ctx: RequestContext, @Param('id') id: string, @Query() q: unknown) {
    const { month } = parse(z.object({ month: CalendarDateDto.optional() }), q);
    return this.ops.budget(dbCtx(ctx), parse(Id, id), month);
  }

  @Put('properties/:id/budget')
  saveBudget(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.ops.saveBudget(dbCtx(ctx), parse(Id, id), parse(SavePropertyBudgetRequest, body));
  }

  // ----- Reports (RNT-11, UP-10) -------------------------------------------------------------------------------

  @Get('reports/rental')
  portfolio(@Ctx() ctx: RequestContext, @Query() q: unknown) {
    return this.reports.portfolio(
      dbCtx(ctx),
      parse(EntityQuery.extend({ from: CalendarDateDto.optional(), to: CalendarDateDto.optional() }), q),
    );
  }

  @Get('reports/schedule-e')
  scheduleE(@Ctx() ctx: RequestContext, @Query() q: unknown) {
    const { entityId, year } = parse(EntityQuery.extend({ year: Year }), q);
    return this.reports.scheduleE(dbCtx(ctx), entityId, year);
  }

  @Get('exports/schedule-e')
  async exportScheduleE(
    @Ctx() ctx: RequestContext,
    @Query() q: unknown,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Buffer> {
    // AUTH-09: taking the books out is a sensitive action.
    requireRecentAuth(ctx);
    const { entityId, year, format } = parse(
      EntityQuery.extend({ year: Year, format: ScheduleEExportFormat }),
      q,
    );
    const f = await this.reports.exportScheduleE(dbCtx(ctx), entityId, year, format);
    void reply.header('content-type', f.mime);
    void reply.header('content-disposition', `attachment; filename="${safeName(f.fileName)}"`);
    void reply.header('cache-control', 'private, no-store');
    void reply.header('x-content-type-options', 'nosniff');
    return Buffer.from(f.bytes);
  }
}
