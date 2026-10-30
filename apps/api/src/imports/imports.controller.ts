import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { newId } from '@montra/db';
import { detectFileType } from '@montra/importers';
import {
  BulkImportRowsRequest,
  CreateImportRequest,
  UpdateImportRowRequest,
  UpdateMappingRequest,
  type ImportBatchDto,
  type ImportRowDto,
  type JobDto,
  type UploadDto,
} from '@montra/schemas';
import { z } from 'zod';
import { AuthGuard, Ctx, dbCtx, WorkspaceGuard, type RequestContext } from '../auth/auth.js';
import { CONFIG, type AppConfig } from '../config.js';
import { Db } from '../db/database.js';
import { AppError } from '../common/errors.js';
import { IdempotencyInterceptor } from '../common/idempotency.interceptor.js';
import { requireRole } from '../common/roles.js';
import { parse } from '../common/zod.js';
import { sha256, STORAGE_PORT, storageKey, type StoragePort } from '../storage/storage.js';
import { ImportsService } from './imports.service.js';

const MIME_BY_TYPE = {
  csv: 'text/csv',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xls: 'application/vnd.ms-excel',
  pdf: 'application/pdf',
} as const;

/** File uploads (IMP-01). Multipart for now; presigned direct-to-S3 uploads arrive with mobile (Phase 4). */
@Controller('v1/workspaces/:workspaceId/uploads')
@UseGuards(AuthGuard, WorkspaceGuard)
export class UploadsController {
  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(STORAGE_PORT) private readonly storage: StoragePort,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  @Post()
  async upload(@Ctx() ctx: RequestContext, @Req() req: FastifyRequest): Promise<UploadDto> {
    requireRole(ctx, 'owner', 'partner', 'accountant');
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
    const fileName = part.filename.replace(/[\\/\0]/g, '_').slice(0, 255) || 'statement';
    const fileType = detectFileType(bytes, fileName);
    if (!fileType) throw new AppError(415, 'upload.unsupported_type', 'Upload a CSV, XLS, XLSX or PDF file');
    const id = newId();
    const digest = sha256(bytes);
    const key = storageKey(ctx.workspaceId!, 'statement', id);
    await this.storage.put(key, bytes, MIME_BY_TYPE[fileType]);
    return this.db.run(dbCtx(ctx), async (trx) => {
      const earlier = await trx
        .selectFrom('app.file as f')
        .leftJoin('app.import_batch as b', (j) =>
          j.onRef('b.workspace_id', '=', 'f.workspace_id').onRef('b.file_id', '=', 'f.id'),
        )
        .select(['f.id', 'f.created_at', 'b.id as batch_id'])
        .where('f.workspace_id', '=', ctx.workspaceId!)
        .where('f.sha256', '=', digest)
        .where('f.deleted_at', 'is', null)
        .orderBy('f.created_at')
        .executeTakeFirst();
      await trx
        .insertInto('app.file')
        .values({
          workspace_id: ctx.workspaceId!,
          id,
          kind: 'statement',
          storage_key: key,
          file_name: fileName,
          mime: MIME_BY_TYPE[fileType],
          bytes: bytes.length,
          sha256: digest,
          uploaded_by: ctx.user.id,
        })
        .execute();
      return {
        fileId: id,
        fileName,
        fileType,
        bytes: bytes.length,
        sha256: digest,
        duplicateOf: earlier
          ? {
              fileId: earlier.id,
              importBatchId: earlier.batch_id,
              uploadedAt: earlier.created_at.toISOString(),
            }
          : null,
      };
    });
  }
}

const RowsQuery = z.object({
  status: z.enum(['new', 'duplicate', 'probable_duplicate', 'match', 'error']).optional(),
  cursor: z.coerce.number().int().min(0).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

@Controller('v1/workspaces/:workspaceId')
@UseGuards(AuthGuard, WorkspaceGuard)
@UseInterceptors(IdempotencyInterceptor)
export class ImportsController {
  constructor(@Inject(ImportsService) private readonly imports: ImportsService) {}

  @Post('imports')
  @HttpCode(202)
  create(@Ctx() ctx: RequestContext, @Body() body: unknown): Promise<ImportBatchDto> {
    return this.imports.create(dbCtx(ctx), parse(CreateImportRequest, body));
  }

  @Get('imports')
  async list(
    @Ctx() ctx: RequestContext,
    @Query('accountId') accountId?: string,
  ): Promise<{ data: ImportBatchDto[] }> {
    return { data: await this.imports.list(dbCtx(ctx), accountId ? parse(z.uuid(), accountId) : undefined) };
  }

  @Get('imports/:id')
  get(@Ctx() ctx: RequestContext, @Param('id') id: string): Promise<ImportBatchDto> {
    return this.imports.get(dbCtx(ctx), parse(z.uuid(), id));
  }

  @Get('imports/:id/rows')
  rows(
    @Ctx() ctx: RequestContext,
    @Param('id') id: string,
    @Query() query: unknown,
  ): Promise<{ data: ImportRowDto[]; nextCursor: string | null }> {
    const q = parse(RowsQuery, query);
    return this.imports.rows(dbCtx(ctx), parse(z.uuid(), id), {
      status: q.status,
      afterRowNo: q.cursor,
      limit: q.limit,
    });
  }

  @Put('imports/:id/mapping')
  @HttpCode(202)
  mapping(
    @Ctx() ctx: RequestContext,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<ImportBatchDto> {
    return this.imports.setMapping(dbCtx(ctx), parse(z.uuid(), id), parse(UpdateMappingRequest, body));
  }

  @Patch('imports/:id/rows')
  bulkRows(
    @Ctx() ctx: RequestContext,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<{ updated: number }> {
    return this.imports.bulkRows(dbCtx(ctx), parse(z.uuid(), id), parse(BulkImportRowsRequest, body));
  }

  @Patch('imports/:id/rows/:rowId')
  row(
    @Ctx() ctx: RequestContext,
    @Param('id') id: string,
    @Param('rowId') rowId: string,
    @Body() body: unknown,
  ): Promise<ImportRowDto> {
    return this.imports.updateRow(
      dbCtx(ctx),
      parse(z.uuid(), id),
      parse(z.uuid(), rowId),
      parse(UpdateImportRowRequest, body),
    );
  }

  @Post('imports/:id/commit')
  @HttpCode(202)
  commit(@Ctx() ctx: RequestContext, @Param('id') id: string): Promise<ImportBatchDto> {
    return this.imports.commit(dbCtx(ctx), parse(z.uuid(), id));
  }

  @Post('imports/:id/undo')
  @HttpCode(202)
  undo(@Ctx() ctx: RequestContext, @Param('id') id: string): Promise<ImportBatchDto> {
    return this.imports.undo(dbCtx(ctx), parse(z.uuid(), id));
  }

  @Get('jobs/:id')
  job(@Ctx() ctx: RequestContext, @Param('id') id: string): Promise<JobDto> {
    return this.imports.job(dbCtx(ctx), parse(z.uuid(), id)) as Promise<JobDto>;
  }
}
