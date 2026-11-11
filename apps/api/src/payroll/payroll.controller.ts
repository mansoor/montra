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
  Put,
  Query,
  Req,
  Res,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  AddI9DocumentRequest,
  CreatePersonRequest,
  CreateW4Request,
  CreateW9Request,
  PersonKind,
  RevealRequest,
  SaveI9Section1Request,
  SaveI9Section2Request,
  UpdatePersonRequest,
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
import { CONFIG, type AppConfig } from '../config.js';
import { AppError } from '../common/errors.js';
import { IdempotencyInterceptor } from '../common/idempotency.interceptor.js';
import { parse } from '../common/zod.js';
import { FormsService } from './forms.service.js';
import { PeopleService } from './people.service.js';

const Id = z.uuid();
const EntityQuery = z.object({ entityId: z.uuid() });

/**
 * Payroll (PRL-01..05; ADR-0034). Everything here needs write access to the business. Full personal data comes back
 * only from a reveal, a form PDF or a document copy: each needs a recent sign-in and is logged.
 */
@Controller('v1/workspaces/:workspaceId/payroll')
@UseGuards(AuthGuard, WorkspaceGuard)
@UseInterceptors(IdempotencyInterceptor)
export class PayrollController {
  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(PeopleService) private readonly people: PeopleService,
    @Inject(FormsService) private readonly forms: FormsService,
  ) {}

  // ----- People (PRL-01) -----------------------------------------------------------------------------------------

  @Get('people')
  async list(@Ctx() ctx: RequestContext, @Query() q: unknown) {
    const { entityId, kind } = parse(EntityQuery.extend({ kind: PersonKind.optional() }), q);
    return { data: await this.people.list(dbCtx(ctx), entityId, kind) };
  }

  @Post('people')
  create(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    return this.people.create(dbCtx(ctx), parse(CreatePersonRequest, body));
  }

  @Get('people/:id')
  get(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.people.get(dbCtx(ctx), parse(Id, id));
  }

  @Patch('people/:id')
  update(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.people.update(dbCtx(ctx), parse(Id, id), parse(UpdatePersonRequest, body));
  }

  @Delete('people/:id')
  @HttpCode(204)
  async remove(@Ctx() ctx: RequestContext, @Param('id') id: string): Promise<void> {
    await this.people.remove(dbCtx(ctx), parse(Id, id));
  }

  /** PRL-05: one full value, after a recent sign-in, written to the audit log. */
  @Post('people/:id/reveal')
  @HttpCode(200)
  reveal(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    requireRecentAuth(ctx);
    return this.people.reveal(dbCtx(ctx), parse(Id, id), parse(RevealRequest, body));
  }

  // ----- W-4 (PRL-02) and W-9 (PRL-03) ---------------------------------------------------------------------------

  @Get('people/:id/w4')
  async listW4(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return { data: await this.forms.listW4(dbCtx(ctx), parse(Id, id)) };
  }

  @Post('people/:id/w4')
  createW4(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.forms.createW4(dbCtx(ctx), parse(Id, id), parse(CreateW4Request, body));
  }

  @Get('people/:id/w4/:formId/pdf')
  async w4Pdf(
    @Ctx() ctx: RequestContext,
    @Param('id') id: string,
    @Param('formId') formId: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Buffer> {
    requireRecentAuth(ctx);
    return pdf(reply, await this.forms.w4Pdf(dbCtx(ctx), parse(Id, id), parse(Id, formId)));
  }

  @Get('people/:id/w9')
  async listW9(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return { data: await this.forms.listW9(dbCtx(ctx), parse(Id, id)) };
  }

  @Post('people/:id/w9')
  createW9(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.forms.createW9(dbCtx(ctx), parse(Id, id), parse(CreateW9Request, body));
  }

  @Get('people/:id/w9/:formId/pdf')
  async w9Pdf(
    @Ctx() ctx: RequestContext,
    @Param('id') id: string,
    @Param('formId') formId: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Buffer> {
    requireRecentAuth(ctx);
    return pdf(reply, await this.forms.w9Pdf(dbCtx(ctx), parse(Id, id), parse(Id, formId)));
  }

  // ----- I-9 (PRL-04) --------------------------------------------------------------------------------------------

  @Get('people/:id/i9')
  async getI9(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return { data: await this.forms.getI9(dbCtx(ctx), parse(Id, id)) };
  }

  @Put('people/:id/i9/section1')
  saveSection1(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.forms.saveSection1(dbCtx(ctx), parse(Id, id), parse(SaveI9Section1Request, body));
  }

  @Put('people/:id/i9/section2')
  saveSection2(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.forms.saveSection2(dbCtx(ctx), parse(Id, id), parse(SaveI9Section2Request, body));
  }

  @Post('people/:id/i9/documents')
  addDocument(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.forms.addDocument(dbCtx(ctx), parse(Id, id), parse(AddI9DocumentRequest, body));
  }

  @Delete('people/:id/i9/documents/:documentId')
  removeDocument(
    @Ctx() ctx: RequestContext,
    @Param('id') id: string,
    @Param('documentId') documentId: string,
  ) {
    return this.forms.removeDocument(dbCtx(ctx), parse(Id, id), parse(Id, documentId));
  }

  @Get('people/:id/i9/documents/:documentId/files/:fileId')
  async documentFile(
    @Ctx() ctx: RequestContext,
    @Param('id') id: string,
    @Param('documentId') documentId: string,
    @Param('fileId') fileId: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Buffer> {
    requireRecentAuth(ctx);
    const f = await this.forms.documentFile(
      dbCtx(ctx),
      parse(Id, id),
      parse(Id, documentId),
      parse(Id, fileId),
    );
    void reply.header('content-type', f.mime);
    void reply.header('content-disposition', `inline; filename="${safeName(f.fileName)}"`);
    void reply.header('cache-control', 'private, no-store');
    void reply.header('x-content-type-options', 'nosniff');
    return Buffer.from(f.bytes);
  }

  /** Only after the retention period (ADR-0034 §5). */
  @Delete('people/:id/i9')
  @HttpCode(204)
  async destroyI9(@Ctx() ctx: RequestContext, @Param('id') id: string): Promise<void> {
    requireRecentAuth(ctx);
    await this.forms.destroyI9(dbCtx(ctx), parse(Id, id));
  }

  @Get('people/:id/i9/pdf')
  async i9Pdf(
    @Ctx() ctx: RequestContext,
    @Param('id') id: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Buffer> {
    requireRecentAuth(ctx);
    return pdf(reply, await this.forms.i9Pdf(dbCtx(ctx), parse(Id, id)));
  }

  /** A copy of an identity document; sealed before it's stored. */
  @Post('files')
  async upload(@Ctx() ctx: RequestContext, @Query() q: unknown, @Req() req: FastifyRequest) {
    const { entityId } = parse(EntityQuery, q);
    if (!req.isMultipart()) {
      throw new AppError(415, 'upload.multipart_required', 'Send the file as multipart/form-data');
    }
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
    return this.forms.uploadFile(dbCtx(ctx), entityId, bytes, part.filename || 'document');
  }
}

const safeName = (name: string) => name.replace(/[^\w.-]/g, '_');

function pdf(reply: FastifyReply, f: { bytes: Uint8Array; fileName: string }): Buffer {
  void reply.header('content-type', 'application/pdf');
  void reply.header('content-disposition', `inline; filename="${safeName(f.fileName)}"`);
  void reply.header('cache-control', 'private, no-store');
  void reply.header('x-content-type-options', 'nosniff');
  return Buffer.from(f.bytes);
}
