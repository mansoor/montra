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
  UseGuards,
} from '@nestjs/common';
import {
  AddValuationsRequest,
  BalanceAdjustmentRequest,
  BalanceRangeDto,
  CreateAccountRequest,
  MoveAccountRequest,
  RegisterView,
  UpdateAccountRequest,
  type AccountBalanceHistoryDto,
  type InvestmentPerformanceDto,
  type AccountDto,
  type AccountMovePreviewDto,
  type CategoryDto,
  type LedgerAccountDto,
} from '@montra/schemas';
import { z } from 'zod';
import { AuthGuard, Ctx, dbCtx, WorkspaceGuard, type RequestContext } from '../auth/auth.js';
import { requireRole } from '../common/roles.js';
import { parse } from '../common/zod.js';
import { AccountMoveService } from './account-move.service.js';
import { AccountsService } from './accounts.service.js';
import { CardsService } from './cards.service.js';
import { ValuationsService } from './valuations.service.js';

@Controller('v1/workspaces/:workspaceId')
@UseGuards(AuthGuard, WorkspaceGuard)
export class AccountsController {
  constructor(
    @Inject(AccountsService) private readonly accounts: AccountsService,
    @Inject(ValuationsService) private readonly valuationsService: ValuationsService,
    @Inject(CardsService) private readonly cards: CardsService,
    @Inject(AccountMoveService) private readonly moves: AccountMoveService,
  ) {}

  /**
   * ADR-0033: what moving the account to other books would do, changing nothing. Owners only: the move rewrites
   * entries other members may not see (a partner's payslip).
   */
  @Get('accounts/:accountId/move')
  movePreview(
    @Ctx() ctx: RequestContext,
    @Param('accountId') accountId: string,
    @Query() q: unknown,
  ): Promise<AccountMovePreviewDto> {
    requireRole(ctx, 'owner');
    return this.moves.preview(dbCtx(ctx), parse(z.uuid(), accountId), parse(MoveAccountRequest, q).entityId);
  }

  @Post('accounts/:accountId/move')
  @HttpCode(200)
  move(
    @Ctx() ctx: RequestContext,
    @Param('accountId') accountId: string,
    @Body() body: unknown,
  ): Promise<AccountMovePreviewDto> {
    requireRole(ctx, 'owner');
    return this.moves.move(dbCtx(ctx), parse(z.uuid(), accountId), parse(MoveAccountRequest, body).entityId);
  }

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

  @Get('accounts/:accountId/balance-history')
  balanceHistory(
    @Ctx() ctx: RequestContext,
    @Param('accountId') accountId: string,
    @Query('range') range?: string,
  ): Promise<AccountBalanceHistoryDto> {
    return this.accounts.balanceHistory(
      dbCtx(ctx),
      parse(z.uuid(), accountId),
      parse(BalanceRangeDto.default('1y'), range),
    );
  }

  @Get('accounts/:accountId/valuations')
  async valuations(@Ctx() ctx: RequestContext, @Param('accountId') accountId: string) {
    return { data: await this.valuationsService.list(dbCtx(ctx), parse(z.uuid(), accountId)) };
  }

  @Post('accounts/:accountId/valuations')
  async addValuations(
    @Ctx() ctx: RequestContext,
    @Param('accountId') accountId: string,
    @Body() body: unknown,
  ) {
    return {
      data: await this.valuationsService.add(
        dbCtx(ctx),
        parse(z.uuid(), accountId),
        parse(AddValuationsRequest, body),
      ),
    };
  }

  @Delete('accounts/:accountId/valuations/:valuationId')
  async removeValuation(
    @Ctx() ctx: RequestContext,
    @Param('accountId') accountId: string,
    @Param('valuationId') valuationId: string,
  ) {
    return {
      data: await this.valuationsService.removeLatest(
        dbCtx(ctx),
        parse(z.uuid(), accountId),
        parse(z.uuid(), valuationId),
      ),
    };
  }

  @Get('accounts/:accountId/performance')
  performance(
    @Ctx() ctx: RequestContext,
    @Param('accountId') accountId: string,
    @Query('range') range?: string,
  ): Promise<InvestmentPerformanceDto> {
    return this.valuationsService.performance(
      dbCtx(ctx),
      parse(z.uuid(), accountId),
      parse(BalanceRangeDto.default('1y'), range),
    );
  }

  @Get('accounts/:accountId/interest-earned')
  interestEarned(@Ctx() ctx: RequestContext, @Param('accountId') accountId: string) {
    return this.accounts.interestEarned(dbCtx(ctx), parse(z.uuid(), accountId));
  }

  /** Every card and line of credit's latest statement (ADR-0026). */
  @Get('card-statements')
  async cardStatements(@Ctx() ctx: RequestContext) {
    return { data: await this.cards.statements(dbCtx(ctx)) };
  }

  @Get('accounts/:accountId/statement')
  async cardStatement(@Ctx() ctx: RequestContext, @Param('accountId') accountId: string) {
    const [statement] = await this.cards.statements(dbCtx(ctx), parse(z.uuid(), accountId));
    return { data: statement ?? null };
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
