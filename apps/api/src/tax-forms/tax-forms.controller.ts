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
  UseInterceptors,
} from '@nestjs/common';
import {
  CreateTaxFormRequest,
  CreateTaxFormWaiverRequest,
  Id,
  ListTaxFormsQuery,
  UpdateTaxFormRequest,
  type TaxFormDto,
  type TaxFormWaiverDto,
  type TaxYearDto,
} from '@montra/schemas';
import { AuthGuard, Ctx, dbCtx, WorkspaceGuard, type RequestContext } from '../auth/auth.js';
import { IdempotencyInterceptor } from '../common/idempotency.interceptor.js';
import { requireRole } from '../common/roles.js';
import { parse } from '../common/zod.js';
import { TAX_FORM_WRITERS, TaxFormsService } from './tax-forms.service.js';

/**
 * Tax forms received (ADR-0052, TAX-01, TAX-02, TAX-08): a year's forms, typing one in, changing it, deleting it to the
 * Trash, and waivers for expected forms. Uploading and reading files come later (PR 3). Row-level security decides
 * which forms each login sees (§8.4).
 */
@Controller('v1/workspaces/:workspaceId/tax-forms')
@UseGuards(AuthGuard, WorkspaceGuard)
@UseInterceptors(IdempotencyInterceptor)
export class TaxFormsController {
  constructor(@Inject(TaxFormsService) private readonly taxForms: TaxFormsService) {}

  @Get()
  list(@Ctx() ctx: RequestContext, @Query() q: unknown): Promise<TaxYearDto> {
    return this.taxForms.year(dbCtx(ctx), parse(ListTaxFormsQuery, q).year);
  }

  @Post()
  create(@Ctx() ctx: RequestContext, @Body() body: unknown): Promise<TaxFormDto> {
    requireRole(ctx, ...TAX_FORM_WRITERS);
    return this.taxForms.create(dbCtx(ctx), parse(CreateTaxFormRequest, body));
  }

  @Post('waivers')
  createWaiver(@Ctx() ctx: RequestContext, @Body() body: unknown): Promise<TaxFormWaiverDto> {
    requireRole(ctx, ...TAX_FORM_WRITERS);
    return this.taxForms.createWaiver(dbCtx(ctx), parse(CreateTaxFormWaiverRequest, body));
  }

  @Delete('waivers/:id')
  @HttpCode(204)
  async removeWaiver(@Ctx() ctx: RequestContext, @Param('id') id: string): Promise<void> {
    requireRole(ctx, ...TAX_FORM_WRITERS);
    await this.taxForms.removeWaiver(dbCtx(ctx), parse(Id, id));
  }

  @Get(':id')
  get(@Ctx() ctx: RequestContext, @Param('id') id: string): Promise<TaxFormDto> {
    return this.taxForms.get(dbCtx(ctx), parse(Id, id));
  }

  @Patch(':id')
  update(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown): Promise<TaxFormDto> {
    requireRole(ctx, ...TAX_FORM_WRITERS);
    return this.taxForms.update(dbCtx(ctx), parse(Id, id), parse(UpdateTaxFormRequest, body));
  }

  /** To the Trash for 30 days; restored through `POST trash/tax_form/:id/restore`. */
  @Delete(':id')
  @HttpCode(204)
  async remove(@Ctx() ctx: RequestContext, @Param('id') id: string): Promise<void> {
    requireRole(ctx, ...TAX_FORM_WRITERS);
    await this.taxForms.remove(dbCtx(ctx), parse(Id, id));
  }
}
