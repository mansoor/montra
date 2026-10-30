import {
  Body,
  Controller,
  Get,
  Inject,
  Param,
  Post,
  Query,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import {
  CalendarDateDto,
  CreateTransactionRequest,
  CreateTransferRequest,
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
});

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

  @Get()
  async list(@Ctx() ctx: RequestContext, @Query() query: unknown): Promise<{ data: TransactionDto[] }> {
    return { data: await this.transactions.list(dbCtx(ctx), parse(ListQuery, query)) };
  }

  @Get(':id')
  get(@Ctx() ctx: RequestContext, @Param('id') id: string): Promise<TransactionDto> {
    return this.transactions.getOrThrow(dbCtx(ctx), parse(z.uuid(), id));
  }
}
