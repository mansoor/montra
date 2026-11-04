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
  Query,
  Req,
  Res,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  AccountingExportQuery,
  BillStatus,
  CalendarDateDto,
  CreateBillRequest,
  CreateInvoiceRequest,
  CreatePartyRequest,
  CreateTripRequest,
  InvoiceStatus,
  PartyKind,
  RecordPaymentRequest,
  SendInvoiceRequest,
  SetTaxLineRequest,
  UpdateBillRequest,
  UpdateBusinessProfileRequest,
  UpdateInvoiceRequest,
  UpdatePartyRequest,
  UpdateTripRequest,
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
import { CONFIG, type AppConfig } from '../config.js';
import { AppError } from '../common/errors.js';
import { IdempotencyInterceptor } from '../common/idempotency.interceptor.js';
import { parse } from '../common/zod.js';
import { BillsService } from './bills.service.js';
import { BusinessReportsService } from './business-reports.service.js';
import { BusinessService } from './business.service.js';
import { ExportService } from './export.service.js';
import { InvoicesService } from './invoices.service.js';
import { MileageService } from './mileage.service.js';

const Id = z.uuid();
const EntityQuery = z.object({ entityId: z.uuid() });
const Range = EntityQuery.extend({ from: CalendarDateDto.optional(), to: CalendarDateDto.optional() });
const Year = z.coerce.number().int().min(2000).max(2100).optional();
const Versioned = z.object({ version: z.number().int().positive() });

@Controller('v1/workspaces/:workspaceId')
@UseGuards(AuthGuard, WorkspaceGuard)
@UseInterceptors(IdempotencyInterceptor)
export class BusinessController {
  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(BusinessService) private readonly business: BusinessService,
    @Inject(InvoicesService) private readonly invoices: InvoicesService,
    @Inject(BillsService) private readonly bills: BillsService,
    @Inject(MileageService) private readonly mileage: MileageService,
    @Inject(BusinessReportsService) private readonly reports: BusinessReportsService,
    @Inject(ExportService) private readonly exports: ExportService,
  ) {}

  // ----- Businesses (BIZ-01) -------------------------------------------------------------------------------

  @Get('businesses')
  async businesses(@Ctx() ctx: RequestContext) {
    return { data: await this.business.listBusinesses(dbCtx(ctx)) };
  }

  @Get('businesses/:entityId')
  profile(@Ctx() ctx: RequestContext, @Param('entityId') entityId: string) {
    return this.business.profile(dbCtx(ctx), parse(Id, entityId));
  }

  @Patch('businesses/:entityId')
  updateProfile(@Ctx() ctx: RequestContext, @Param('entityId') entityId: string, @Body() body: unknown) {
    return this.business.updateProfile(
      dbCtx(ctx),
      parse(Id, entityId),
      parse(UpdateBusinessProfileRequest, body),
    );
  }

  @Post('businesses/files')
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
    return this.business.uploadFile(dbCtx(ctx), bytes, part.filename || 'document');
  }

  // ----- Customers and vendors (BIZ-04) --------------------------------------------------------------------

  @Get('parties')
  async parties(@Ctx() ctx: RequestContext, @Query() q: unknown) {
    const { entityId, kind } = parse(EntityQuery.extend({ kind: PartyKind.optional() }), q);
    return { data: await this.business.listParties(dbCtx(ctx), entityId, kind) };
  }

  @Post('parties')
  createParty(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    return this.business.createParty(dbCtx(ctx), parse(CreatePartyRequest, body));
  }

  @Patch('parties/:id')
  updateParty(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.business.updateParty(dbCtx(ctx), parse(Id, id), parse(UpdatePartyRequest, body));
  }

  // ----- Invoices (BIZ-05) ---------------------------------------------------------------------------------

  @Get('invoices')
  async listInvoices(@Ctx() ctx: RequestContext, @Query() q: unknown) {
    const opts = parse(
      EntityQuery.extend({ status: InvoiceStatus.optional(), partyId: z.uuid().optional() }),
      q,
    );
    return { data: await this.invoices.list(dbCtx(ctx), opts) };
  }

  @Post('invoices')
  createInvoice(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    return this.invoices.create(dbCtx(ctx), parse(CreateInvoiceRequest, body));
  }

  @Get('invoices/:id')
  getInvoice(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.invoices.get(dbCtx(ctx), parse(Id, id));
  }

  @Patch('invoices/:id')
  updateInvoice(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.invoices.update(dbCtx(ctx), parse(Id, id), parse(UpdateInvoiceRequest, body));
  }

  @Delete('invoices/:id')
  @HttpCode(204)
  async deleteInvoice(@Ctx() ctx: RequestContext, @Param('id') id: string): Promise<void> {
    await this.invoices.remove(dbCtx(ctx), parse(Id, id));
  }

  @Post('invoices/:id/send')
  @HttpCode(200)
  sendInvoice(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.invoices.send(dbCtx(ctx), parse(Id, id), parse(SendInvoiceRequest, body));
  }

  @Post('invoices/:id/void')
  @HttpCode(200)
  voidInvoice(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.invoices.voidInvoice(dbCtx(ctx), parse(Id, id), parse(Versioned, body).version);
  }

  @Get('invoices/:id/pdf')
  async invoicePdf(
    @Ctx() ctx: RequestContext,
    @Param('id') id: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Buffer> {
    const f = await this.invoices.pdf(dbCtx(ctx), parse(Id, id));
    void reply.header('content-type', 'application/pdf');
    void reply.header('content-disposition', `inline; filename="${attachmentName(f.fileName)}"`);
    void reply.header('cache-control', 'private, no-store');
    void reply.header('x-content-type-options', 'nosniff');
    return Buffer.from(f.bytes);
  }

  @Get('invoices/:id/candidates')
  async invoiceCandidates(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return { data: await this.invoices.candidates(dbCtx(ctx), parse(Id, id)) };
  }

  @Post('invoices/:id/payments')
  recordPayment(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.invoices.recordPayment(dbCtx(ctx), parse(Id, id), parse(RecordPaymentRequest, body));
  }

  @Delete('invoices/:id/payments/:paymentId')
  removePayment(@Ctx() ctx: RequestContext, @Param('id') id: string, @Param('paymentId') paymentId: string) {
    return this.invoices.removePayment(dbCtx(ctx), parse(Id, id), parse(Id, paymentId));
  }

  // ----- Bills (BIZ-06) ------------------------------------------------------------------------------------

  @Get('bills')
  async listBills(@Ctx() ctx: RequestContext, @Query() q: unknown) {
    const opts = parse(
      EntityQuery.extend({ status: BillStatus.optional(), partyId: z.uuid().optional() }),
      q,
    );
    return { data: await this.bills.list(dbCtx(ctx), opts) };
  }

  @Post('bills')
  createBill(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    return this.bills.create(dbCtx(ctx), parse(CreateBillRequest, body));
  }

  @Get('bills/:id')
  getBill(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.bills.get(dbCtx(ctx), parse(Id, id));
  }

  @Patch('bills/:id')
  updateBill(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.bills.update(dbCtx(ctx), parse(Id, id), parse(UpdateBillRequest, body));
  }

  @Get('bills/:id/candidates')
  async billCandidates(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return { data: await this.bills.candidates(dbCtx(ctx), parse(Id, id)) };
  }

  @Post('bills/:id/payment')
  payBill(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.bills.pay(dbCtx(ctx), parse(Id, id), parse(RecordPaymentRequest, body));
  }

  @Delete('bills/:id/payment')
  removeBillPayment(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.bills.removePayment(dbCtx(ctx), parse(Id, id));
  }

  @Get('bills/:id/files/:fileId')
  async billFile(
    @Ctx() ctx: RequestContext,
    @Param('id') id: string,
    @Param('fileId') fileId: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Buffer> {
    const f = await this.bills.file(dbCtx(ctx), parse(Id, id), parse(Id, fileId));
    void reply.header('content-type', f.mime);
    void reply.header('cache-control', 'private, no-store');
    void reply.header('x-content-type-options', 'nosniff');
    return Buffer.from(f.bytes);
  }

  // ----- Mileage (BIZ-07) ----------------------------------------------------------------------------------

  @Get('mileage-trips')
  trips(@Ctx() ctx: RequestContext, @Query() q: unknown) {
    const { entityId, year } = parse(EntityQuery.extend({ year: Year }), q);
    return this.mileage.summary(dbCtx(ctx), entityId, year);
  }

  @Post('mileage-trips')
  createTrip(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    return this.mileage.create(dbCtx(ctx), parse(CreateTripRequest, body));
  }

  @Patch('mileage-trips/:id')
  updateTrip(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.mileage.update(dbCtx(ctx), parse(Id, id), parse(UpdateTripRequest, body));
  }

  @Delete('mileage-trips/:id')
  @HttpCode(204)
  async deleteTrip(@Ctx() ctx: RequestContext, @Param('id') id: string): Promise<void> {
    await this.mileage.remove(dbCtx(ctx), parse(Id, id));
  }

  // ----- Tax and reports (BIZ-09, BIZ-10, BIZ-12, AI-10) ---------------------------------------------------

  @Get('tax/estimates')
  taxEstimate(@Ctx() ctx: RequestContext, @Query() q: unknown) {
    const { entityId, year } = parse(EntityQuery.extend({ year: Year }), q);
    return this.reports.taxEstimate(dbCtx(ctx), entityId, year);
  }

  @Get('tax/lines')
  async taxLines(@Ctx() ctx: RequestContext, @Query() q: unknown) {
    const { form } = parse(z.object({ form: z.enum(['schedule_c', 'schedule_e']).optional() }), q);
    return { data: await this.reports.taxLines(dbCtx(ctx), form) };
  }

  @Patch('categories/:id/tax-line')
  @HttpCode(204)
  async setTaxLine(
    @Ctx() ctx: RequestContext,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<void> {
    await this.business.setTaxLine(dbCtx(ctx), parse(Id, id), parse(SetTaxLineRequest, body).taxLineCode);
  }

  @Post('businesses/:entityId/tax-lines/suggest')
  @HttpCode(200)
  async suggestTaxLines(@Ctx() ctx: RequestContext, @Param('entityId') entityId: string) {
    return { data: await this.reports.suggestTaxLines(dbCtx(ctx), parse(Id, entityId)) };
  }

  @Get('reports/pnl')
  pnl(@Ctx() ctx: RequestContext, @Query() q: unknown) {
    return this.reports.pnl(dbCtx(ctx), parse(Range, q));
  }

  @Get('reports/parties')
  byParty(@Ctx() ctx: RequestContext, @Query() q: unknown) {
    return this.reports.byParty(dbCtx(ctx), parse(Range.extend({ kind: PartyKind }), q));
  }

  @Get('reports/schedule-c')
  scheduleC(@Ctx() ctx: RequestContext, @Query() q: unknown) {
    const { entityId, year } = parse(EntityQuery.extend({ year: Year }), q);
    return this.reports.scheduleC(dbCtx(ctx), entityId, year);
  }

  @Get('reports/missing-receipts')
  missingReceipts(@Ctx() ctx: RequestContext, @Query() q: unknown) {
    const { entityId, year } = parse(EntityQuery.extend({ year: Year }), q);
    return this.reports.missingReceipts(dbCtx(ctx), entityId, year);
  }

  // ----- Accountant export (BIZ-13) ------------------------------------------------------------------------

  @Get('exports/accounting')
  async export(
    @Ctx() ctx: RequestContext,
    @Query() q: unknown,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Buffer> {
    // AUTH-09: taking the books out is a sensitive action.
    requireRecentAuth(ctx);
    const f = await this.exports.export(dbCtx(ctx), parse(AccountingExportQuery, q));
    void reply.header('content-type', f.mime);
    void reply.header('content-disposition', `attachment; filename="${attachmentName(f.fileName)}"`);
    void reply.header('cache-control', 'private, no-store');
    void reply.header('x-content-type-options', 'nosniff');
    return Buffer.from(f.bytes);
  }
}

const attachmentName = (name: string) => name.replace(/[^\w.-]/g, '_');
