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
  CalendarDateDto,
  ConfirmPayslipRequest,
  CreateEmployerRequest,
  CreatePayslipRequest,
  PayslipStatus,
  UpdateEmployerRequest,
  UpdatePayslipRequest,
} from '@montra/schemas';
import { z } from 'zod';
import { AuthGuard, Ctx, dbCtx, WorkspaceGuard, type RequestContext } from '../auth/auth.js';
import { CONFIG, type AppConfig } from '../config.js';
import { AppError } from '../common/errors.js';
import { IdempotencyInterceptor } from '../common/idempotency.interceptor.js';
import { parse } from '../common/zod.js';
import { MemberReportsService } from './member-reports.service.js';
import { PayslipsService } from './payslips.service.js';

const Id = z.uuid();

@Controller('v1/workspaces/:workspaceId')
@UseGuards(AuthGuard, WorkspaceGuard)
@UseInterceptors(IdempotencyInterceptor)
export class PayslipsController {
  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(PayslipsService) private readonly payslips: PayslipsService,
    @Inject(MemberReportsService) private readonly reports: MemberReportsService,
  ) {}

  // ----- Employers (PAY-01) --------------------------------------------------------------------------------

  @Get('employers')
  async employers(@Ctx() ctx: RequestContext, @Query() q: unknown) {
    const { memberId } = parse(z.object({ memberId: z.uuid().optional() }), q);
    return { data: await this.payslips.listEmployers(dbCtx(ctx), memberId) };
  }

  @Post('employers')
  createEmployer(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    return this.payslips.createEmployer(dbCtx(ctx), parse(CreateEmployerRequest, body));
  }

  @Patch('employers/:id')
  updateEmployer(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.payslips.updateEmployer(dbCtx(ctx), parse(Id, id), parse(UpdateEmployerRequest, body));
  }

  // ----- Payslips (PAY-02..05) -----------------------------------------------------------------------------

  @Post('payslips/files')
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
    return this.payslips.uploadFile(dbCtx(ctx), bytes, part.filename || 'payslip');
  }

  @Get('payslips')
  async list(@Ctx() ctx: RequestContext, @Query() q: unknown) {
    const opts = parse(
      z.object({
        memberId: z.uuid().optional(),
        employerId: z.uuid().optional(),
        status: PayslipStatus.optional(),
      }),
      q,
    );
    return { data: await this.payslips.list(dbCtx(ctx), opts) };
  }

  @Post('payslips')
  create(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    return this.payslips.create(dbCtx(ctx), parse(CreatePayslipRequest, body));
  }

  @Get('payslips/:id')
  get(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.payslips.get(dbCtx(ctx), parse(Id, id));
  }

  @Patch('payslips/:id')
  update(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.payslips.update(dbCtx(ctx), parse(Id, id), parse(UpdatePayslipRequest, body));
  }

  @Post('payslips/:id/confirm')
  @HttpCode(200)
  confirm(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.payslips.confirm(dbCtx(ctx), parse(Id, id), parse(ConfirmPayslipRequest, body));
  }

  @Delete('payslips/:id')
  @HttpCode(204)
  async remove(@Ctx() ctx: RequestContext, @Param('id') id: string): Promise<void> {
    await this.payslips.remove(dbCtx(ctx), parse(Id, id));
  }

  @Get('payslips/:id/files/:fileId')
  async file(
    @Ctx() ctx: RequestContext,
    @Param('id') id: string,
    @Param('fileId') fileId: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Buffer> {
    const f = await this.payslips.file(dbCtx(ctx), parse(Id, id), parse(Id, fileId));
    void reply.header('content-type', f.mime);
    void reply.header('cache-control', 'private, no-store');
    void reply.header('x-content-type-options', 'nosniff');
    return Buffer.from(f.bytes);
  }

  // ----- Reports (FAM-08, PAY-06, RPT-01) ------------------------------------------------------------------

  @Get('reports/by-member')
  byMember(@Ctx() ctx: RequestContext, @Query() q: unknown) {
    const opts = parse(
      z.object({
        from: CalendarDateDto.optional(),
        to: CalendarDateDto.optional(),
        entityId: z.uuid().optional(),
      }),
      q,
    );
    return this.reports.byMember(dbCtx(ctx), opts);
  }

  @Get('reports/payslip-summary')
  payslipSummary(@Ctx() ctx: RequestContext, @Query() q: unknown) {
    const { memberId, year } = parse(
      z.object({ memberId: z.uuid(), year: z.coerce.number().int().min(2000).max(2100).optional() }),
      q,
    );
    return this.reports.payslipSummary(dbCtx(ctx), memberId, year);
  }
}
