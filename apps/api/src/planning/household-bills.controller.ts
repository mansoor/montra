import {
  Body,
  Controller,
  Get,
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
import { CreateHouseholdBillRequest, UpdateHouseholdBillRequest, type FiledBillDto } from '@montra/schemas';
import { z } from 'zod';
import { AuthGuard, Ctx, dbCtx, WorkspaceGuard, type RequestContext } from '../auth/auth.js';
import { CONFIG, type AppConfig } from '../config.js';
import { AppError } from '../common/errors.js';
import { IdempotencyInterceptor } from '../common/idempotency.interceptor.js';
import { requireRole } from '../common/roles.js';
import { parse } from '../common/zod.js';
import { HouseholdBillsService } from './household-bills.service.js';

const WRITERS = ['owner', 'admin', 'partner', 'accountant', 'member'] as const;

/**
 * Bills from billers (ADR-0048 §4), under `household-bills` beside the business's vendor `bills` (ADR-0017). Filing
 * a bill for a business's biller makes that business's vendor bill; the answer says which it made.
 */
@Controller('v1/workspaces/:workspaceId/household-bills')
@UseGuards(AuthGuard, WorkspaceGuard)
@UseInterceptors(IdempotencyInterceptor)
export class HouseholdBillsController {
  constructor(
    @Inject(HouseholdBillsService) private readonly bills: HouseholdBillsService,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  /** A page of a bill to scan: a photo or PDF. */
  @Post('files')
  async upload(@Ctx() ctx: RequestContext, @Req() req: FastifyRequest) {
    requireRole(ctx, ...WRITERS);
    if (!req.isMultipart())
      throw new AppError(415, 'upload.multipart_required', 'Send the file as multipart/form-data');
    const part = await req.file({ limits: { fileSize: this.config.MAX_UPLOAD_BYTES, files: 1 } });
    if (!part) throw new AppError(400, 'upload.no_file', 'No file in the request');
    const bytes = new Uint8Array(await part.toBuffer());
    if (part.file.truncated)
      throw new AppError(
        413,
        'upload.too_large',
        `Files can be up to ${this.config.MAX_UPLOAD_BYTES / 1_048_576} MB`,
      );
    if (bytes.length === 0) throw new AppError(400, 'upload.empty', 'The file is empty');
    return this.bills.uploadFile(dbCtx(ctx), bytes, part.filename || 'bill');
  }

  @Get()
  async list(@Ctx() ctx: RequestContext, @Query() q: unknown) {
    const opts = parse(
      z.object({
        entityId: z.uuid().optional(),
        status: z.enum(['open', 'overdue', 'paid', 'void']).optional(),
      }),
      q,
    );
    return { data: await this.bills.list(dbCtx(ctx), opts) };
  }

  @Post()
  create(@Ctx() ctx: RequestContext, @Body() body: unknown): Promise<FiledBillDto> {
    requireRole(ctx, ...WRITERS);
    return this.bills.create(dbCtx(ctx), parse(CreateHouseholdBillRequest, body));
  }

  @Get(':id')
  get(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.bills.get(dbCtx(ctx), parse(z.uuid(), id));
  }

  @Patch(':id')
  update(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    requireRole(ctx, ...WRITERS);
    return this.bills.update(dbCtx(ctx), parse(z.uuid(), id), parse(UpdateHouseholdBillRequest, body));
  }

  @Get(':id/files/:fileId')
  async file(
    @Ctx() ctx: RequestContext,
    @Param('id') id: string,
    @Param('fileId') fileId: string,
    @Res() res: FastifyReply,
  ) {
    const f = await this.bills.file(dbCtx(ctx), parse(z.uuid(), id), parse(z.uuid(), fileId));
    void res
      .header('content-type', f.mime)
      .header('cache-control', 'private, no-store')
      .send(Buffer.from(f.bytes));
  }
}
