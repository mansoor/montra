import { Body, Controller, Get, Inject, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import {
  BalanceAdjustmentRequest,
  CreateAccountRequest,
  RegisterView,
  UpdateAccountRequest,
  type AccountDto,
  type CategoryDto,
  type LedgerAccountDto,
} from '@montra/schemas';
import { z } from 'zod';
import { AuthGuard, Ctx, dbCtx, WorkspaceGuard, type RequestContext } from '../auth/auth.js';
import { parse } from '../common/zod.js';
import { AccountsService } from './accounts.service.js';

@Controller('v1/workspaces/:workspaceId')
@UseGuards(AuthGuard, WorkspaceGuard)
export class AccountsController {
  constructor(@Inject(AccountsService) private readonly accounts: AccountsService) {}

  @Post('accounts')
  create(@Ctx() ctx: RequestContext, @Body() body: unknown): Promise<AccountDto> {
    return this.accounts.create(dbCtx(ctx), parse(CreateAccountRequest, body));
  }

  @Get('accounts')
  async list(
    @Ctx() ctx: RequestContext,
    @Query('include') include?: string,
  ): Promise<{ data: AccountDto[] }> {
    const all = include === 'all';
    return { data: await this.accounts.list(dbCtx(ctx), { includeHidden: all, includeArchived: all }) };
  }

  @Patch('accounts/:accountId')
  update(
    @Ctx() ctx: RequestContext,
    @Param('accountId') accountId: string,
    @Body() body: unknown,
  ): Promise<AccountDto> {
    return this.accounts.update(dbCtx(ctx), parse(z.uuid(), accountId), parse(UpdateAccountRequest, body));
  }

  @Post('accounts/:accountId/balance-adjustments')
  adjust(@Ctx() ctx: RequestContext, @Param('accountId') accountId: string, @Body() body: unknown) {
    return this.accounts.adjustBalance(
      dbCtx(ctx),
      parse(z.uuid(), accountId),
      parse(BalanceAdjustmentRequest, body),
    );
  }

  @Get('accounts/:accountId/register')
  async register(
    @Ctx() ctx: RequestContext,
    @Param('accountId') accountId: string,
    @Query('view') view?: string,
  ) {
    parse(z.uuid(), accountId);
    const v = parse(RegisterView.default('ledger'), view);
    const { lines } = await this.accounts.register(dbCtx(ctx), accountId);
    return {
      view: v,
      data:
        v === 'ledger'
          ? lines.map(({ amount: _amount, ...l }) => l)
          : lines.map(({ debit: _d, credit: _c, ...l }) => l),
    };
  }

  /** Full chart of accounts including system accounts (DE-02), e.g. for manual journals. */
  @Get('ledger-accounts')
  async ledgerAccounts(
    @Ctx() ctx: RequestContext,
    @Query('entityId') entityId?: string,
  ): Promise<{ data: LedgerAccountDto[] }> {
    return {
      data: await this.accounts.ledgerAccounts(dbCtx(ctx), entityId ? parse(z.uuid(), entityId) : undefined),
    };
  }

  @Get('categories')
  async categories(
    @Ctx() ctx: RequestContext,
    @Query('entityId') entityId?: string,
  ): Promise<{ data: CategoryDto[] }> {
    return {
      data: await this.accounts.categories(dbCtx(ctx), entityId ? parse(z.uuid(), entityId) : undefined),
    };
  }
}
