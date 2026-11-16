import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { CreateIntakeRequest, ListIntakesQuery, ResolveIntakeRequest, type IntakeDto } from '@montra/schemas';
import { z } from 'zod';
import { AuthGuard, Ctx, dbCtx, WorkspaceGuard, type RequestContext } from '../auth/auth.js';
import { CONFIG, type AppConfig } from '../config.js';
import { AppError } from '../common/errors.js';
import { IdempotencyInterceptor } from '../common/idempotency.interceptor.js';
import { requireRole } from '../common/roles.js';
import { parse } from '../common/zod.js';
import { BILL_ROLES, IntakesService, STATEMENT_ROLES } from './intakes.service.js';

/**
 * Statements and bills without a destination yet (ADR-0051): upload a statement with no account, list what waits in
 * Review, and pick the account or biller to finish.
 */
@Controller('v1/workspaces/:workspaceId/intakes')
@UseGuards(AuthGuard, WorkspaceGuard)
@UseInterceptors(IdempotencyInterceptor)
export class IntakesController {
  constructor(
    @Inject(IntakesService) private readonly intakes: IntakesService,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  /** A statement of any kind (CSV, XLS, XLSX, PDF, QIF, OFX/QFX, or a photo), multipart field `file`. */
  @Post('files')
  @HttpCode(202)
  async upload(@Ctx() ctx: RequestContext, @Req() req: FastifyRequest): Promise<IntakeDto> {
    requireRole(ctx, ...STATEMENT_ROLES);
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
    return this.intakes.upload(dbCtx(ctx), bytes, part.filename);
  }

  /** A statement uploaded already (`POST uploads`). */
  @Post()
  @HttpCode(202)
  create(@Ctx() ctx: RequestContext, @Body() body: unknown): Promise<IntakeDto> {
    requireRole(ctx, ...STATEMENT_ROLES);
    return this.intakes.create(dbCtx(ctx), parse(CreateIntakeRequest, body));
  }

  @Get()
  async list(@Ctx() ctx: RequestContext, @Query() q: unknown): Promise<{ data: IntakeDto[] }> {
    return { data: await this.intakes.list(dbCtx(ctx), parse(ListIntakesQuery, q)) };
  }

  @Get(':id')
  get(@Ctx() ctx: RequestContext, @Param('id') id: string): Promise<IntakeDto> {
    return this.intakes.get(dbCtx(ctx), parse(z.uuid(), id));
  }

  @Post(':id/resolve')
  resolve(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown): Promise<IntakeDto> {
    requireRole(ctx, ...BILL_ROLES);
    return this.intakes.resolve(
      dbCtx(ctx),
      ctx.role!,
      parse(z.uuid(), id),
      parse(ResolveIntakeRequest, body),
    );
  }

  @Post(':id/dismiss')
  dismiss(@Ctx() ctx: RequestContext, @Param('id') id: string): Promise<IntakeDto> {
    requireRole(ctx, ...BILL_ROLES);
    return this.intakes.dismiss(dbCtx(ctx), ctx.role!, parse(z.uuid(), id));
  }
}
