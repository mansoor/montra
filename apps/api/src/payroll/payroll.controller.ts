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
  AddI9DocumentRequest,
  ApprovePayRunRequest,
  CreatePayRunRequest,
  CreatePayScheduleRequest,
  CreateReimbursementRequest,
  DecideReimbursementRequest,
  ReimbursementStatus,
  UpdatePaycheckRequest,
  UpdatePayRunRequest,
  UpdatePayScheduleRequest,
  CreatePersonRequest,
  CreateDe4Request,
  CreateW4Request,
  RecordDepositRequest,
  UpdatePayrollSettingsRequest,
  CreateW9Request,
  PersonKind,
  RevealRequest,
  SaveI9Section1Request,
  SaveI9Section2Request,
  UpdatePersonRequest,
  BillContractorTimeRequest,
  CreateContractorTimeRequest,
  CreateLeaveEntryRequest,
  UpdateContractorTimeRequest,
  UpdateLeaveSettingsRequest,
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
import { AppError, forbidden } from '../common/errors.js';
import { IdempotencyInterceptor } from '../common/idempotency.interceptor.js';
import { parse } from '../common/zod.js';
import { FormsService } from './forms.service.js';
import { PayRunsService } from './pay-runs.service.js';
import { PayrollTaxesService } from './payroll-taxes.service.js';
import { YearEndService } from './year-end.service.js';
import { PeopleService } from './people.service.js';
import { ReimbursementsService } from './reimbursements.service.js';
import { LeaveService } from './leave.service.js';
import { ContractorTimeService } from './contractor-time.service.js';

const Id = z.uuid();
const EntityQuery = z.object({ entityId: z.uuid() });
const Year = z.coerce.number().int().min(2000).max(2100);
const WorksheetQuery = EntityQuery.extend({
  year: Year,
  quarter: z.coerce.number().int().min(1).max(4).optional(),
});
const FORMS = { '941': '941', '940': '940', de9: 'DE 9', de9c: 'DE 9C' } as const;

/**
 * Payroll (PRL-01..16; ADR-0034). People and their forms need write access to the business; pay runs, taxes and
 * worksheets can be read with read access. Full personal data comes back
 * only from a reveal, a form PDF or a document copy: each needs a recent sign-in and is logged.
 */
@Controller('v1/workspaces/:workspaceId/payroll')
@UseGuards(AuthGuard, WorkspaceGuard)
@UseInterceptors(IdempotencyInterceptor)
export class PayrollController {
  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(PeopleService) private readonly people: PeopleService,
    @Inject(FormsService) private readonly forms: FormsService,
    @Inject(PayRunsService) private readonly runs: PayRunsService,
    @Inject(ReimbursementsService) private readonly reimbursements: ReimbursementsService,
    @Inject(PayrollTaxesService) private readonly taxes: PayrollTaxesService,
    @Inject(YearEndService) private readonly yearEnd: YearEndService,
    @Inject(LeaveService) private readonly leave: LeaveService,
    @Inject(ContractorTimeService) private readonly time: ContractorTimeService,
  ) {}

  // ----- People (PRL-01) -----------------------------------------------------------------------------------------

  @Get('people')
  async list(@Ctx() ctx: RequestContext, @Query() q: unknown) {
    const { entityId, kind } = parse(EntityQuery.extend({ kind: PersonKind.optional() }), q);
    return { data: await this.people.list(dbCtx(ctx), entityId, kind) };
  }

  @Post('people')
  create(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    return this.people.create(dbCtx(ctx), parse(CreatePersonRequest, body));
  }

  @Get('people/:id')
  get(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.people.get(dbCtx(ctx), parse(Id, id));
  }

  @Patch('people/:id')
  update(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.people.update(dbCtx(ctx), parse(Id, id), parse(UpdatePersonRequest, body));
  }

  @Delete('people/:id')
  @HttpCode(204)
  async remove(@Ctx() ctx: RequestContext, @Param('id') id: string): Promise<void> {
    await this.people.remove(dbCtx(ctx), parse(Id, id));
  }

  /** PRL-05: one full value, after a recent sign-in, written to the audit log. */
  @Post('people/:id/reveal')
  @HttpCode(200)
  reveal(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    requireRecentAuth(ctx);
    return this.people.reveal(dbCtx(ctx), parse(Id, id), parse(RevealRequest, body));
  }

  // ----- W-4 (PRL-02) and W-9 (PRL-03) ---------------------------------------------------------------------------

  @Get('people/:id/w4')
  async listW4(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return { data: await this.forms.listW4(dbCtx(ctx), parse(Id, id)) };
  }

  @Post('people/:id/w4')
  createW4(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.forms.createW4(dbCtx(ctx), parse(Id, id), parse(CreateW4Request, body));
  }

  @Get('people/:id/w4/:formId/pdf')
  async w4Pdf(
    @Ctx() ctx: RequestContext,
    @Param('id') id: string,
    @Param('formId') formId: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Buffer> {
    requireRecentAuth(ctx);
    return pdf(reply, await this.forms.w4Pdf(dbCtx(ctx), parse(Id, id), parse(Id, formId)));
  }

  @Get('people/:id/de4')
  async listDe4(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return { data: await this.forms.listDe4(dbCtx(ctx), parse(Id, id)) };
  }

  @Post('people/:id/de4')
  createDe4(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.forms.createDe4(dbCtx(ctx), parse(Id, id), parse(CreateDe4Request, body));
  }

  @Get('people/:id/de4/:formId/pdf')
  async de4Pdf(
    @Ctx() ctx: RequestContext,
    @Param('id') id: string,
    @Param('formId') formId: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Buffer> {
    requireRecentAuth(ctx);
    return pdf(reply, await this.forms.de4Pdf(dbCtx(ctx), parse(Id, id), parse(Id, formId)));
  }

  @Get('people/:id/w9')
  async listW9(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return { data: await this.forms.listW9(dbCtx(ctx), parse(Id, id)) };
  }

  @Post('people/:id/w9')
  createW9(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.forms.createW9(dbCtx(ctx), parse(Id, id), parse(CreateW9Request, body));
  }

  @Get('people/:id/w9/:formId/pdf')
  async w9Pdf(
    @Ctx() ctx: RequestContext,
    @Param('id') id: string,
    @Param('formId') formId: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Buffer> {
    requireRecentAuth(ctx);
    return pdf(reply, await this.forms.w9Pdf(dbCtx(ctx), parse(Id, id), parse(Id, formId)));
  }

  // ----- I-9 (PRL-04) --------------------------------------------------------------------------------------------

  @Get('people/:id/i9')
  async getI9(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return { data: await this.forms.getI9(dbCtx(ctx), parse(Id, id)) };
  }

  @Put('people/:id/i9/section1')
  saveSection1(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.forms.saveSection1(dbCtx(ctx), parse(Id, id), parse(SaveI9Section1Request, body));
  }

  @Put('people/:id/i9/section2')
  saveSection2(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.forms.saveSection2(dbCtx(ctx), parse(Id, id), parse(SaveI9Section2Request, body));
  }

  @Post('people/:id/i9/documents')
  addDocument(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.forms.addDocument(dbCtx(ctx), parse(Id, id), parse(AddI9DocumentRequest, body));
  }

  @Delete('people/:id/i9/documents/:documentId')
  removeDocument(
    @Ctx() ctx: RequestContext,
    @Param('id') id: string,
    @Param('documentId') documentId: string,
  ) {
    return this.forms.removeDocument(dbCtx(ctx), parse(Id, id), parse(Id, documentId));
  }

  @Get('people/:id/i9/documents/:documentId/files/:fileId')
  async documentFile(
    @Ctx() ctx: RequestContext,
    @Param('id') id: string,
    @Param('documentId') documentId: string,
    @Param('fileId') fileId: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Buffer> {
    requireRecentAuth(ctx);
    const f = await this.forms.documentFile(
      dbCtx(ctx),
      parse(Id, id),
      parse(Id, documentId),
      parse(Id, fileId),
    );
    void reply.header('content-type', f.mime);
    void reply.header('content-disposition', `inline; filename="${safeName(f.fileName)}"`);
    void reply.header('cache-control', 'private, no-store');
    void reply.header('x-content-type-options', 'nosniff');
    return Buffer.from(f.bytes);
  }

  /** Only after the retention period (ADR-0034 §5). */
  @Delete('people/:id/i9')
  @HttpCode(204)
  async destroyI9(@Ctx() ctx: RequestContext, @Param('id') id: string): Promise<void> {
    requireRecentAuth(ctx);
    await this.forms.destroyI9(dbCtx(ctx), parse(Id, id));
  }

  @Get('people/:id/i9/pdf')
  async i9Pdf(
    @Ctx() ctx: RequestContext,
    @Param('id') id: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Buffer> {
    requireRecentAuth(ctx);
    return pdf(reply, await this.forms.i9Pdf(dbCtx(ctx), parse(Id, id)));
  }

  /**
   * A copy of an identity document (sealed before it's stored) or a receipt for a spending claim. Members may send
   * receipts only: they can claim spending (AUTH-17) but not handle anyone's identity documents.
   */
  @Post('files')
  async upload(@Ctx() ctx: RequestContext, @Query() q: unknown, @Req() req: FastifyRequest) {
    const { entityId, purpose } = parse(
      EntityQuery.extend({ purpose: z.enum(['identity', 'receipt']).default('identity') }),
      q,
    );
    if (purpose === 'identity' && ctx.role === 'member') {
      throw forbidden('Members can upload receipts for spending claims only');
    }
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
    return this.forms.uploadFile(dbCtx(ctx), entityId, bytes, part.filename || 'document', purpose);
  }
  // ----- Pay schedules and pay runs (PRL-06..09) -------------------------------------------------------------------

  @Get('schedules')
  async schedules(@Ctx() ctx: RequestContext, @Query() q: unknown) {
    return { data: await this.runs.listSchedules(dbCtx(ctx), parse(EntityQuery, q).entityId) };
  }

  @Post('schedules')
  createSchedule(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    return this.runs.createSchedule(dbCtx(ctx), parse(CreatePayScheduleRequest, body));
  }

  @Patch('schedules/:id')
  updateSchedule(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.runs.updateSchedule(dbCtx(ctx), parse(Id, id), parse(UpdatePayScheduleRequest, body));
  }

  @Get('runs')
  async runsList(@Ctx() ctx: RequestContext, @Query() q: unknown) {
    return { data: await this.runs.list(dbCtx(ctx), parse(EntityQuery, q).entityId) };
  }

  @Post('runs')
  createRun(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    return this.runs.create(dbCtx(ctx), parse(CreatePayRunRequest, body));
  }

  @Get('runs/:id')
  getRun(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.runs.get(dbCtx(ctx), parse(Id, id));
  }

  @Patch('runs/:id')
  updateRun(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.runs.update(dbCtx(ctx), parse(Id, id), parse(UpdatePayRunRequest, body));
  }

  @Delete('runs/:id')
  @HttpCode(204)
  async deleteRun(@Ctx() ctx: RequestContext, @Param('id') id: string): Promise<void> {
    await this.runs.remove(dbCtx(ctx), parse(Id, id));
  }

  @Patch('runs/:id/paychecks/:paycheckId')
  updatePaycheck(
    @Ctx() ctx: RequestContext,
    @Param('id') id: string,
    @Param('paycheckId') paycheckId: string,
    @Body() body: unknown,
  ) {
    return this.runs.updatePaycheck(
      dbCtx(ctx),
      parse(Id, id),
      parse(Id, paycheckId),
      parse(UpdatePaycheckRequest, body),
    );
  }

  @Post('runs/:id/approve')
  @HttpCode(200)
  approveRun(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.runs.approve(dbCtx(ctx), parse(Id, id), parse(ApprovePayRunRequest, body));
  }

  @Post('runs/:id/reopen')
  @HttpCode(200)
  reopenRun(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    const { version } = parse(z.object({ version: z.number().int().positive() }), body);
    return this.runs.reopen(dbCtx(ctx), parse(Id, id), version);
  }

  /** PRL-08: a payslip, for anyone who can read the pay runs of the business. */
  @Get('paychecks/:id/payslip')
  async payslip(
    @Ctx() ctx: RequestContext,
    @Param('id') id: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Buffer> {
    return pdf(reply, await this.runs.payslipPdf(dbCtx(ctx), parse(Id, id)));
  }

  // ----- Reimbursements (PRL-11) -----------------------------------------------------------------------------------

  @Get('reimbursements')
  async reimbursementList(@Ctx() ctx: RequestContext, @Query() q: unknown) {
    const opts = parse(
      EntityQuery.extend({ status: ReimbursementStatus.optional(), personId: z.uuid().optional() }),
      q,
    );
    return { data: await this.reimbursements.list(dbCtx(ctx), opts) };
  }

  @Post('reimbursements')
  createReimbursement(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    return this.reimbursements.create(dbCtx(ctx), parse(CreateReimbursementRequest, body));
  }

  @Get('reimbursements/:id')
  getReimbursement(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.reimbursements.get(dbCtx(ctx), parse(Id, id));
  }

  @Post('reimbursements/:id/decision')
  @HttpCode(200)
  decideReimbursement(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.reimbursements.decide(dbCtx(ctx), parse(Id, id), parse(DecideReimbursementRequest, body));
  }

  @Get('reimbursements/:id/files/:fileId')
  async reimbursementFile(
    @Ctx() ctx: RequestContext,
    @Param('id') id: string,
    @Param('fileId') fileId: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Buffer> {
    const f = await this.reimbursements.file(dbCtx(ctx), parse(Id, id), parse(Id, fileId));
    void reply.header('content-type', f.mime);
    void reply.header('content-disposition', `inline; filename="${safeName(f.fileName)}"`);
    void reply.header('cache-control', 'private, no-store');
    void reply.header('x-content-type-options', 'nosniff');
    return Buffer.from(f.bytes);
  }

  // ----- Employer tax (PRL-12..16) ---------------------------------------------------------------------------------

  @Get('settings')
  settings(@Ctx() ctx: RequestContext, @Query() q: unknown) {
    return this.taxes.settings(dbCtx(ctx), parse(EntityQuery, q).entityId);
  }

  @Put('settings')
  updateSettings(@Ctx() ctx: RequestContext, @Query() q: unknown, @Body() body: unknown) {
    return this.taxes.updateSettings(
      dbCtx(ctx),
      parse(EntityQuery, q).entityId,
      parse(UpdatePayrollSettingsRequest, body),
    );
  }

  @Get('taxes')
  taxesFor(@Ctx() ctx: RequestContext, @Query() q: unknown) {
    const { entityId, year } = parse(EntityQuery.extend({ year: Year }), q);
    return this.taxes.taxes(dbCtx(ctx), entityId, year);
  }

  @Post('deposits')
  recordDeposit(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    return this.taxes.recordDeposit(dbCtx(ctx), parse(RecordDepositRequest, body));
  }

  @Delete('deposits/:id')
  @HttpCode(204)
  async removeDeposit(@Ctx() ctx: RequestContext, @Param('id') id: string): Promise<void> {
    await this.taxes.removeDeposit(dbCtx(ctx), parse(Id, id));
  }

  @Get('worksheets/:form')
  worksheet(@Ctx() ctx: RequestContext, @Param('form') form: string, @Query() q: unknown) {
    const name = FORMS[form as keyof typeof FORMS];
    if (!name) throw new AppError(404, 'not_found', 'No such worksheet');
    const { entityId, year, quarter } = parse(WorksheetQuery, q);
    return this.taxes.worksheet(dbCtx(ctx), entityId, name, year, name === '940' ? null : (quarter ?? 1));
  }

  // ----- Year-end forms (PRL-17..20) -------------------------------------------------------------------------------

  @Get('year-end')
  yearEndSummary(@Ctx() ctx: RequestContext, @Query() q: unknown) {
    const { entityId, year } = parse(EntityQuery.extend({ year: Year }), q);
    return this.yearEnd.summary(dbCtx(ctx), entityId, year);
  }

  @Get('year-end/w2/:personId')
  async w2(
    @Ctx() ctx: RequestContext,
    @Param('personId') personId: string,
    @Query() q: unknown,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Buffer> {
    requireRecentAuth(ctx);
    const { entityId, year } = parse(EntityQuery.extend({ year: Year }), q);
    return pdf(reply, await this.yearEnd.w2EmployeePdf(dbCtx(ctx), entityId, year, parse(Id, personId)));
  }

  @Get('year-end/w2-employer')
  async w2Employer(
    @Ctx() ctx: RequestContext,
    @Query() q: unknown,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Buffer> {
    requireRecentAuth(ctx);
    const { entityId, year } = parse(EntityQuery.extend({ year: Year }), q);
    return pdf(reply, await this.yearEnd.w2EmployerPdf(dbCtx(ctx), entityId, year));
  }

  @Get('year-end/1099/:personId')
  async nec(
    @Ctx() ctx: RequestContext,
    @Param('personId') personId: string,
    @Query() q: unknown,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Buffer> {
    requireRecentAuth(ctx);
    const { entityId, year } = parse(EntityQuery.extend({ year: Year }), q);
    return pdf(reply, await this.yearEnd.necRecipientPdf(dbCtx(ctx), entityId, year, parse(Id, personId)));
  }

  @Get('year-end/1099-payer')
  async necPayer(
    @Ctx() ctx: RequestContext,
    @Query() q: unknown,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Buffer> {
    requireRecentAuth(ctx);
    const { entityId, year } = parse(EntityQuery.extend({ year: Year }), q);
    return pdf(reply, await this.yearEnd.necPayerPdf(dbCtx(ctx), entityId, year));
  }

  @Get('year-end/efw2')
  async efw2(
    @Ctx() ctx: RequestContext,
    @Query() q: unknown,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<string> {
    requireRecentAuth(ctx);
    const { entityId, year } = parse(EntityQuery.extend({ year: Year }), q);
    const f = await this.yearEnd.efw2(dbCtx(ctx), entityId, year);
    void reply.header('content-type', 'text/plain; charset=us-ascii');
    void reply.header('content-disposition', `attachment; filename="${safeName(f.fileName)}"`);
    void reply.header('cache-control', 'private, no-store');
    void reply.header('x-content-type-options', 'nosniff');
    return f.text;
  }

  // ----- Staff time (PRL-23..28; ADR-0036) -------------------------------------------------------------------------

  /** Vacation and sick leave policies and the workweek; readable with read access, like the pay runs they shape. */
  @Get('leave-settings')
  leaveSettings(@Ctx() ctx: RequestContext, @Query() q: unknown) {
    return this.leave.settings(dbCtx(ctx), parse(EntityQuery, q).entityId);
  }

  @Put('leave-settings')
  updateLeaveSettings(@Ctx() ctx: RequestContext, @Query() q: unknown, @Body() body: unknown) {
    return this.leave.updateSettings(
      dbCtx(ctx),
      parse(EntityQuery, q).entityId,
      parse(UpdateLeaveSettingsRequest, body),
    );
  }

  /** Current employees' vacation and sick balances. */
  @Get('leave')
  async leaveBalances(@Ctx() ctx: RequestContext, @Query() q: unknown) {
    return { data: await this.leave.balances(dbCtx(ctx), parse(EntityQuery, q).entityId) };
  }

  @Get('people/:id/leave')
  personLeave(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.leave.personLeave(dbCtx(ctx), parse(Id, id));
  }

  @Post('people/:id/leave')
  addLeave(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.leave.addEntry(dbCtx(ctx), parse(Id, id), parse(CreateLeaveEntryRequest, body));
  }

  @Delete('people/:id/leave/:entryId')
  removeLeave(@Ctx() ctx: RequestContext, @Param('id') id: string, @Param('entryId') entryId: string) {
    return this.leave.removeEntry(dbCtx(ctx), parse(Id, id), parse(Id, entryId));
  }

  @Get('people/:id/time')
  timesheet(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.time.timesheet(dbCtx(ctx), parse(Id, id));
  }

  @Post('people/:id/time')
  addTime(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.time.add(dbCtx(ctx), parse(Id, id), parse(CreateContractorTimeRequest, body));
  }

  /** "Bill these hours": one bill to the contractor's vendor record. */
  @Post('people/:id/time/bill')
  billTime(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.time.bill(dbCtx(ctx), parse(Id, id), parse(BillContractorTimeRequest, body));
  }

  @Patch('time/:id')
  updateTime(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.time.update(dbCtx(ctx), parse(Id, id), parse(UpdateContractorTimeRequest, body));
  }

  @Delete('time/:id')
  removeTime(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.time.remove(dbCtx(ctx), parse(Id, id));
  }
}

const safeName = (name: string) => name.replace(/[^\w.-]/g, '_');

function pdf(reply: FastifyReply, f: { bytes: Uint8Array; fileName: string }): Buffer {
  void reply.header('content-type', 'application/pdf');
  void reply.header('content-disposition', `inline; filename="${safeName(f.fileName)}"`);
  void reply.header('cache-control', 'private, no-store');
  void reply.header('x-content-type-options', 'nosniff');
  return Buffer.from(f.bytes);
}
