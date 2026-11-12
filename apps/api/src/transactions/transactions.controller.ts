import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  Res,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import {
  BulkEditRequest,
  CalendarDateDto,
  ConfirmOccurrenceRequest,
  CreateTransactionRequest,
  CreateTransferRequest,
  MakeTransferRequest,
  UpdateTransactionRequest,
  type BulkEditResult,
  type TransactionDto,
} from '@montra/schemas';
import { z } from 'zod';
import { AuthGuard, Ctx, dbCtx, WorkspaceGuard, type RequestContext } from '../auth/auth.js';
import { IdempotencyInterceptor } from '../common/idempotency.interceptor.js';
import { parse } from '../common/zod.js';
import { TransactionsService } from './transactions.service.js';

const ListQuery = z.object({
  from: CalendarDateDto.optional(),
  to: CalendarDateDto.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  status: z.enum(['scheduled', 'pending', 'posted', 'void']).optional(),
  reviewState: z.enum(['auto_applied', 'needs_review', 'reviewed']).optional(),
  accountId: z.uuid().optional(),
  /** Dashboard drill-down (FLOW-01/02): postings in these entities, members, categories or accounts. */
  entityId: z.uuid().optional(),
  /** A member, or "household" for what isn't tagged to anyone (FAM-09). */
  memberId: z.union([z.uuid(), z.literal('household')]).optional(),
  propertyId: z.uuid().optional(),
  /** BIZ-18: who spent it, in a business: the owner, a payroll person, or "none" for nobody named. */
  spentBy: z.union([z.uuid(), z.enum(['owner', 'none'])]).optional(),
  /** RPT-05: `coffee >20 tag:travel`. */
  q: z.string().max(500).optional(),
  categoryIds: z
    .string()
    .optional()
    .transform((v) => (v ? v.split(',') : undefined))
    .pipe(z.array(z.uuid()).max(200).optional()),
  accountIds: z
    .string()
    .optional()
    .transform((v) => (v ? v.split(',') : undefined))
    .pipe(z.array(z.uuid()).max(200).optional()),
  /** List the trash (voided and deleted) instead of active transactions (BAK-06). */
  trash: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
});

const etag = (t: TransactionDto) => `"v${t.version}"`;

@Controller('v1/workspaces/:workspaceId/transactions')
@UseGuards(AuthGuard, WorkspaceGuard)
@UseInterceptors(IdempotencyInterceptor)
export class TransactionsController {
  constructor(@Inject(TransactionsService) private readonly transactions: TransactionsService) {}

  @Post()
  create(@Ctx() ctx: RequestContext, @Body() body: unknown): Promise<TransactionDto> {
    return this.transactions.create(dbCtx(ctx), parse(CreateTransactionRequest, body));
  }

  @Post('transfer')
  transfer(@Ctx() ctx: RequestContext, @Body() body: unknown): Promise<TransactionDto> {
    return this.transactions.transfer(dbCtx(ctx), parse(CreateTransferRequest, body));
  }

  /** A plain transaction becomes a transfer (a card payment, a move between accounts), absorbing the other side. */
  @Post(':id/make-transfer')
  @HttpCode(200)
  makeTransfer(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.transactions.makeTransfer(dbCtx(ctx), id, parse(MakeTransferRequest, body));
  }

  @Post('bulk')
  @HttpCode(200)
  bulk(@Ctx() ctx: RequestContext, @Body() body: unknown): Promise<BulkEditResult> {
    return this.transactions.bulk(dbCtx(ctx), parse(BulkEditRequest, body));
  }

  @Get()
  async list(@Ctx() ctx: RequestContext, @Query() query: unknown): Promise<{ data: TransactionDto[] }> {
    return { data: await this.transactions.list(dbCtx(ctx), parse(ListQuery, query)) };
  }

  @Get(':id')
  async get(
    @Ctx() ctx: RequestContext,
    @Param('id') id: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const t = await this.transactions.getOrThrow(dbCtx(ctx), parse(z.uuid(), id));
    void reply.header('etag', etag(t));
    return t;
  }

  @Patch(':id')
  async update(
    @Ctx() ctx: RequestContext,
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('if-match') ifMatch: string | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const t = await this.transactions.update(
      dbCtx(ctx),
      parse(z.uuid(), id),
      parse(UpdateTransactionRequest, body),
      ifMatch,
    );
    void reply.header('etag', etag(t));
    return t;
  }

  @Delete(':id')
  remove(
    @Ctx() ctx: RequestContext,
    @Param('id') id: string,
    @Headers('if-match') ifMatch: string | undefined,
  ) {
    return this.transactions.remove(dbCtx(ctx), parse(z.uuid(), id), ifMatch);
  }

  @Post(':id/restore')
  @HttpCode(200)
  restore(@Ctx() ctx: RequestContext, @Param('id') id: string): Promise<TransactionDto> {
    return this.transactions.restore(dbCtx(ctx), parse(z.uuid(), id));
  }

  @Post(':id/confirm')
  @HttpCode(200)
  confirm(
    @Ctx() ctx: RequestContext,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<TransactionDto> {
    return this.transactions.confirm(
      dbCtx(ctx),
      parse(z.uuid(), id),
      parse(ConfirmOccurrenceRequest, body ?? {}),
    );
  }
}
