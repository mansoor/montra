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
  ApplyReceiptRequest,
  CreateReceiptRequest,
  ReceiptListQuery,
  UpdateReceiptRequest,
  type OrderImportResultDto,
  type ReceiptDto,
  type ReceiptFileDto,
  type ReceiptPageDto,
  type ReceiptRecommendationDto,
} from '@montra/schemas';
import { z } from 'zod';
import { AuthGuard, Ctx, dbCtx, WorkspaceGuard, type RequestContext } from '../auth/auth.js';
import { CONFIG, type AppConfig } from '../config.js';
import { AppError } from '../common/errors.js';
import { IdempotencyInterceptor } from '../common/idempotency.interceptor.js';
import { requireRole } from '../common/roles.js';
import { parse } from '../common/zod.js';
import { ReceiptsService } from './receipts.service.js';

const WRITERS = ['owner', 'partner', 'accountant'] as const;

/** Receipts API (RCP-01..12, IMP-11; 05 §receipts). */
@Controller('v1/workspaces/:workspaceId/receipts')
@UseGuards(AuthGuard, WorkspaceGuard)
@UseInterceptors(IdempotencyInterceptor)
export class ReceiptsController {
  constructor(
    @Inject(ReceiptsService) private readonly receipts: ReceiptsService,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  /** A photo (JPEG, PNG, WebP) or PDF invoice; create the receipt with the returned ids. */
  @Post('files')
  async upload(@Ctx() ctx: RequestContext, @Req() req: FastifyRequest): Promise<ReceiptFileDto> {
    requireRole(ctx, ...WRITERS);
    const { bytes, fileName } = await this.readFile(req, 'receipt');
    return this.receipts.uploadFile(dbCtx(ctx), bytes, fileName);
  }

  @Post()
  create(@Ctx() ctx: RequestContext, @Body() body: unknown): Promise<ReceiptDto> {
    requireRole(ctx, ...WRITERS);
    return this.receipts.create(dbCtx(ctx), parse(CreateReceiptRequest, body));
  }

  /** The receipt inbox and search (RCP-10). */
  @Get()
  list(@Ctx() ctx: RequestContext, @Query() query: unknown): Promise<ReceiptPageDto> {
    return this.receipts.list(dbCtx(ctx), parse(ReceiptListQuery, query));
  }

  /** RCP-11: purchases at multi-department stores above $50 without a receipt. */
  @Get('recommended')
  async recommended(@Ctx() ctx: RequestContext): Promise<{ data: ReceiptRecommendationDto[] }> {
    return { data: await this.receipts.recommended(dbCtx(ctx)) };
  }

  @Post('recommended/:transactionId/dismiss')
  @HttpCode(204)
  async dismiss(@Ctx() ctx: RequestContext, @Param('transactionId') transactionId: string): Promise<void> {
    requireRole(ctx, ...WRITERS);
    await this.receipts.dismissRecommendation(dbCtx(ctx), parse(z.uuid(), transactionId));
  }

  /** RCP-12: an Amazon order-history CSV, one receipt per order. */
  @Post('order-history')
  async importOrders(@Ctx() ctx: RequestContext, @Req() req: FastifyRequest): Promise<OrderImportResultDto> {
    requireRole(ctx, ...WRITERS);
    const { bytes } = await this.readFile(req, 'orders.csv');
    return this.receipts.importOrders(dbCtx(ctx), bytes);
  }

  @Get(':id')
  get(@Ctx() ctx: RequestContext, @Param('id') id: string): Promise<ReceiptDto> {
    return this.receipts.get(dbCtx(ctx), parse(z.uuid(), id));
  }

  /** The image or PDF beside the lines on the review screen (RCP-06). */
  @Get(':id/files/:fileId')
  async file(
    @Ctx() ctx: RequestContext,
    @Param('id') id: string,
    @Param('fileId') fileId: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Buffer> {
    const f = await this.receipts.file(dbCtx(ctx), parse(z.uuid(), id), parse(z.uuid(), fileId));
    void reply.header('content-type', f.mime);
    void reply.header('cache-control', 'private, max-age=3600');
    void reply.header('x-content-type-options', 'nosniff');
    return Buffer.from(f.bytes);
  }

  @Patch(':id')
  update(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown): Promise<ReceiptDto> {
    requireRole(ctx, ...WRITERS);
    return this.receipts.update(dbCtx(ctx), parse(z.uuid(), id), parse(UpdateReceiptRequest, body));
  }

  /** Link to a transaction (or create one) and split it by the receipt (04 §7 step 7). */
  @Post(':id/apply')
  @HttpCode(200)
  apply(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown): Promise<ReceiptDto> {
    requireRole(ctx, ...WRITERS);
    return this.receipts.apply(dbCtx(ctx), parse(z.uuid(), id), parse(ApplyReceiptRequest, body));
  }

  @Post(':id/match')
  @HttpCode(200)
  match(@Ctx() ctx: RequestContext, @Param('id') id: string): Promise<ReceiptDto> {
    requireRole(ctx, ...WRITERS);
    return this.receipts.rematch(dbCtx(ctx), parse(z.uuid(), id));
  }

  @Post(':id/reject')
  @HttpCode(200)
  reject(@Ctx() ctx: RequestContext, @Param('id') id: string): Promise<ReceiptDto> {
    requireRole(ctx, ...WRITERS);
    return this.receipts.reject(dbCtx(ctx), parse(z.uuid(), id));
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@Ctx() ctx: RequestContext, @Param('id') id: string): Promise<void> {
    requireRole(ctx, ...WRITERS);
    await this.receipts.remove(dbCtx(ctx), parse(z.uuid(), id));
  }

  private async readFile(req: FastifyRequest, fallbackName: string) {
    if (!req.isMultipart())
      throw new AppError(415, 'upload.multipart_required', 'Send the file as multipart/form-data');
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
    return { bytes, fileName: part.filename || fallbackName };
  }
}
