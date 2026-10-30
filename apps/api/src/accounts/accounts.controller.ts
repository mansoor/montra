import { Body, Controller, Get, Inject, Param, Post, Query, UseGuards } from '@nestjs/common';
import { CreateAccountRequest, RegisterView, type AccountDto, type CategoryDto } from '@montra/schemas';
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
  async list(@Ctx() ctx: RequestContext): Promise<{ data: AccountDto[] }> {
    return { data: await this.accounts.list(dbCtx(ctx)) };
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
