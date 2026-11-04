import { createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
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
  ConfirmRestoreRequest,
  CreateBackupRequest,
  CreateTaxPackageRequest,
  RequestDeletionRequest,
  SaveBackupScheduleRequest,
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
import { AppError } from '../common/errors.js';
import { IdempotencyInterceptor } from '../common/idempotency.interceptor.js';
import { parse } from '../common/zod.js';
import { CONFIG, type AppConfig } from '../config.js';
import { BackupService } from './backup.service.js';
import { OwnershipService } from './ownership.service.js';
import { RestoreService } from './restore.service.js';

const Id = z.uuid();

/** Inside a workspace: backups, the tax package, trash and storage. */
@Controller('v1/workspaces/:workspaceId')
@UseGuards(AuthGuard, WorkspaceGuard)
@UseInterceptors(IdempotencyInterceptor)
export class DataController {
  constructor(
    @Inject(BackupService) private readonly backups: BackupService,
    @Inject(OwnershipService) private readonly ownership: OwnershipService,
  ) {}

  @Get('backups')
  async listBackups(@Ctx() ctx: RequestContext) {
    return { data: await this.backups.list(dbCtx(ctx)) };
  }

  @Post('backups')
  createBackup(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    // AUTH-09: taking the books out is a sensitive action.
    requireRecentAuth(ctx);
    return this.backups.createBackup(dbCtx(ctx), ctx.role!, parse(CreateBackupRequest, body));
  }

  @Post('tax-package')
  createTaxPackage(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    requireRecentAuth(ctx);
    return this.backups.createTaxPackage(dbCtx(ctx), parse(CreateTaxPackageRequest, body));
  }

  @Get('backups/:id')
  getBackup(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.backups.get(dbCtx(ctx), parse(Id, id));
  }

  @Get('backups/:id/download')
  async download(
    @Ctx() ctx: RequestContext,
    @Param('id') id: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    requireRecentAuth(ctx);
    const f = await this.backups.open(dbCtx(ctx), parse(Id, id));
    void reply.header('content-type', f.encrypted ? 'application/octet-stream' : 'application/zip');
    void reply.header('content-disposition', `attachment; filename="${f.fileName.replace(/[^\w.-]/g, '_')}"`);
    if (f.bytes) void reply.header('content-length', f.bytes);
    void reply.header('cache-control', 'private, no-store');
    void reply.header('x-content-type-options', 'nosniff');
    return f.stream;
  }

  @Get('backup-schedule')
  async schedule(@Ctx() ctx: RequestContext) {
    return { schedule: await this.backups.getSchedule(dbCtx(ctx)) };
  }

  @Put('backup-schedule')
  saveSchedule(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    requireRecentAuth(ctx);
    return this.backups.saveSchedule(dbCtx(ctx), ctx.role!, parse(SaveBackupScheduleRequest, body));
  }

  @Delete('backup-schedule')
  @HttpCode(204)
  async removeSchedule(@Ctx() ctx: RequestContext): Promise<void> {
    await this.backups.removeSchedule(dbCtx(ctx));
  }

  @Get('trash')
  async trash(@Ctx() ctx: RequestContext) {
    return { data: await this.ownership.trash(dbCtx(ctx)) };
  }

  @Post('trash/:kind/:id/restore')
  @HttpCode(204)
  async restore(
    @Ctx() ctx: RequestContext,
    @Param('kind') kind: string,
    @Param('id') id: string,
  ): Promise<void> {
    await this.ownership.restoreFromTrash(
      dbCtx(ctx),
      parse(z.enum(['transaction', 'receipt']), kind),
      parse(Id, id),
    );
  }

  @Get('storage')
  storage(@Ctx() ctx: RequestContext) {
    return this.ownership.storageUsage(dbCtx(ctx));
  }
}

/** A restore belongs to its user, since the workspace it makes doesn't exist yet. */
@Controller('v1/me/restores')
@UseGuards(AuthGuard)
export class RestoresController {
  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(RestoreService) private readonly restores: RestoreService,
  ) {}

  @Get()
  async list(@Ctx() ctx: RequestContext) {
    return { data: await this.restores.list(ctx.user.id) };
  }

  @Post()
  async upload(@Ctx() ctx: RequestContext, @Req() req: FastifyRequest) {
    requireRecentAuth(ctx);
    if (!req.isMultipart())
      throw new AppError(415, 'upload.multipart_required', 'Send the file as multipart/form-data');
    const dir = await mkdtemp(join(tmpdir(), 'montra-upload-'));
    try {
      const path = join(dir, 'upload.bin');
      let password: string | undefined;
      let got = false;
      let truncated = false;
      for await (const part of req.parts({ limits: { fileSize: this.config.MAX_RESTORE_BYTES, files: 1 } })) {
        if (part.type === 'file') {
          await pipeline(part.file, createWriteStream(path));
          got = true;
          truncated = part.file.truncated;
        } else if (part.fieldname === 'password' && typeof part.value === 'string' && part.value) {
          password = part.value;
        }
      }
      if (!got) throw new AppError(400, 'upload.no_file', 'No file in the request');
      if (truncated) throw new AppError(413, 'upload.too_large', 'This backup is too large to upload');
      return await this.restores.upload(ctx.user.id, path, password);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  @Get(':id')
  get(@Ctx() ctx: RequestContext, @Param('id') id: string, @Query() q: unknown) {
    const { workspaceId } = parse(z.object({ workspaceId: Id.optional() }), q);
    return this.restores.get(ctx.user.id, parse(Id, id), workspaceId);
  }

  @Post(':id/confirm')
  @HttpCode(200)
  confirm(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    requireRecentAuth(ctx);
    return this.restores.confirm(ctx.user.id, parse(Id, id), parse(ConfirmRestoreRequest, body));
  }
}

/** The account itself: its security log, and leaving. */
@Controller('v1/me')
@UseGuards(AuthGuard)
export class AccountDataController {
  constructor(@Inject(OwnershipService) private readonly ownership: OwnershipService) {}

  @Get('security-activity')
  async activity(@Ctx() ctx: RequestContext) {
    return { data: await this.ownership.securityActivity(ctx.user.id) };
  }

  @Get('deletion')
  deletion(@Ctx() ctx: RequestContext) {
    return this.ownership.deletionStatus(ctx.user.id);
  }

  @Post('deletion')
  @HttpCode(200)
  requestDeletion(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    requireRecentAuth(ctx);
    parse(RequestDeletionRequest, body);
    return this.ownership.requestDeletion(ctx.user.id);
  }

  @Delete('deletion')
  cancelDeletion(@Ctx() ctx: RequestContext) {
    return this.ownership.cancelDeletion(ctx.user.id);
  }
}
