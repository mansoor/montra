import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import {
  ConnectBankFeedRequest,
  UpdateBankFeedAccountRequest,
  UpdateBankFeedRequest,
  type BankFeedLinkDto,
  type BankFeedStateDto,
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
import { IdempotencyInterceptor } from '../common/idempotency.interceptor.js';
import { parse } from '../common/zod.js';
import { Plans } from '../ops/plans.js';
import { BankFeedsService } from './bank-feeds.service.js';

/**
 * Bank feeds (ADR-0055 §3, §4). Owners connect, link and disconnect; owners, admins and partners see the feed; whoever
 * imports statements sees its accounts (row-level security decides, D5).
 */
@Controller('v1/workspaces/:workspaceId/bank-feeds')
@UseGuards(AuthGuard, WorkspaceGuard)
@UseInterceptors(IdempotencyInterceptor)
export class BankFeedsController {
  constructor(@Inject(BankFeedsService) private readonly feeds: BankFeedsService) {}

  @Get()
  state(@Ctx() ctx: RequestContext): Promise<BankFeedStateDto> {
    return this.feeds.state(dbCtx(ctx));
  }

  /** §6: the accounts a live feed imports into, for the Statements screen's note. */
  @Get('links')
  async links(@Ctx() ctx: RequestContext): Promise<{ data: BankFeedLinkDto[] }> {
    return { data: await this.feeds.links(dbCtx(ctx)) };
  }

  @Patch(':id')
  update(
    @Ctx() ctx: RequestContext,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<BankFeedStateDto> {
    return this.feeds.update(
      dbCtx(ctx),
      ctx.role!,
      parse(z.uuid(), id),
      parse(UpdateBankFeedRequest, body ?? {}),
    );
  }

  /** Lists the accounts again (one request against the day's limit). */
  @Post(':id/refresh')
  @HttpCode(200)
  refresh(@Ctx() ctx: RequestContext, @Param('id') id: string): Promise<BankFeedStateDto> {
    return this.feeds.refresh(dbCtx(ctx), ctx.role!, parse(z.uuid(), id));
  }

  @Patch(':id/accounts/:accountId')
  updateAccount(
    @Ctx() ctx: RequestContext,
    @Param('id') id: string,
    @Param('accountId') accountId: string,
    @Body() body: unknown,
  ): Promise<BankFeedStateDto> {
    return this.feeds.updateAccount(
      dbCtx(ctx),
      ctx.role!,
      parse(z.uuid(), id),
      parse(z.uuid(), accountId),
      parse(UpdateBankFeedAccountRequest, body ?? {}),
    );
  }

  /** §5: Sync now (owners, admins and partners), spaced by SIMPLEFIN_SYNC_NOW_MINUTES. */
  @Post(':id/sync')
  @HttpCode(200)
  syncNow(@Ctx() ctx: RequestContext, @Param('id') id: string): Promise<BankFeedStateDto> {
    return this.feeds.syncNow(dbCtx(ctx), ctx.role!, parse(z.uuid(), id));
  }

  /** §3: an owner with a recent sign-in. The access is wiped at once. */
  @Post(':id/disconnect')
  @HttpCode(200)
  disconnect(
    @Ctx() ctx: RequestContext,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<BankFeedStateDto> {
    requireRecentAuth(ctx);
    const { version } = parse(z.object({ version: z.string() }), body ?? {});
    return this.feeds.disconnect(dbCtx(ctx), ctx.role!, parse(z.uuid(), id), version);
  }
}

/**
 * Connecting carries the setup token, so it is kept out of the idempotency store: not even a hash of a body with the
 * token in it is kept (as the vault's key routes, ADR-0054). An owner with a recent sign-in, on a plan with bank feeds.
 */
@Controller('v1/workspaces/:workspaceId/bank-feeds')
@UseGuards(AuthGuard, WorkspaceGuard)
export class BankFeedConnectController {
  constructor(
    @Inject(BankFeedsService) private readonly feeds: BankFeedsService,
    @Inject(Plans) private readonly plans: Plans,
  ) {}

  @Post()
  async connect(@Ctx() ctx: RequestContext, @Body() body: unknown): Promise<BankFeedStateDto> {
    requireRecentAuth(ctx);
    await this.plans.requireFeature(dbCtx(ctx), 'bankFeeds');
    return this.feeds.connect(dbCtx(ctx), ctx.role!, parse(ConnectBankFeedRequest, body ?? {}));
  }
}
