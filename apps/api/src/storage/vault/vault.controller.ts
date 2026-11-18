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
  Res,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import {
  ConnectVaultRequest,
  DisconnectVaultRequest,
  FileStorageStatesQuery,
  Id,
  MoveToVaultRequest,
  ReplaceVaultKeyRequest,
  RetryVaultItemsRequest,
  SendExistingToVaultRequest,
  UpdateVaultConnectionRequest,
  VaultItemsQuery,
  VaultMoveQuery,
  VaultOpenQuery,
} from '@montra/schemas';
import { z } from 'zod';
import {
  AuthGuard,
  Ctx,
  dbCtx,
  requireRecentAuth,
  WorkspaceGuard,
  type RequestContext,
} from '../../auth/auth.js';
import { AppError } from '../../common/errors.js';
import { IdempotencyInterceptor } from '../../common/idempotency.interceptor.js';
import { parse } from '../../common/zod.js';
import { Plans } from '../../ops/plans.js';
import type { FakeVaultHandle } from './fake.js';
import { VAULT_TRANSPORT, type VaultTransport } from './transport.js';
import { VaultOpener, VaultOpenRefused } from './vault.open.js';
import { VaultService } from './vault.service.js';

/**
 * The household's Family Document Vault (ADR-0054 §2, §13). Connecting, replacing the key and disconnecting need an
 * owner with a recent sign-in (AUTH-09, D4); connecting needs the plan's `familyVault` feature.
 */
@Controller('v1/workspaces/:workspaceId/family-vault')
@UseGuards(AuthGuard, WorkspaceGuard)
@UseInterceptors(IdempotencyInterceptor)
export class VaultController {
  constructor(
    @Inject(VaultService) private readonly vault: VaultService,
    @Inject(Plans) private readonly plans: Plans,
  ) {}

  @Get()
  async get(@Ctx() ctx: RequestContext) {
    return { connection: await this.vault.get(dbCtx(ctx), ctx.role!) };
  }

  /** "Check again": owners and admins (D4). */
  @Post('check')
  @HttpCode(200)
  check(@Ctx() ctx: RequestContext) {
    return this.vault.checkAgain(dbCtx(ctx), ctx.role!);
  }

  /**
   * "Send these to the vault" (§6): owners change anything; turning payslips or tax documents on needs a recent sign-in.
   * Admins may set those two back to not sent (D4).
   */
  @Patch()
  update(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    return this.vault.update(dbCtx(ctx), ctx.role!, parse(UpdateVaultConnectionRequest, body), () =>
      requireRecentAuth(ctx),
    );
  }

  /** §12: how many existing documents would be sent, and how long that takes. */
  @Get('existing')
  existing(@Ctx() ctx: RequestContext) {
    return this.vault.existing(dbCtx(ctx), ctx.role!);
  }

  /** §12 "Send existing documents": owner only, with a recent sign-in. */
  @Post('existing')
  @HttpCode(200)
  async sendExisting(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    requireRecentAuth(ctx);
    await this.plans.requireFeature(dbCtx(ctx), 'familyVault');
    return this.vault.sendExisting(dbCtx(ctx), ctx.role!, parse(SendExistingToVaultRequest, body));
  }

  /** §5 "Move existing documents": how many filed files of groups sent with no local copy Montra still holds. */
  @Get('move')
  moveCount(@Ctx() ctx: RequestContext, @Query() query: unknown) {
    return this.vault.moveCount(dbCtx(ctx), ctx.role!, parse(VaultMoveQuery, query ?? {}).groups);
  }

  /** "Move these N files too?": owner only, with a recent sign-in, as a move (§2). */
  @Post('move')
  @HttpCode(200)
  move(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    requireRecentAuth(ctx);
    return this.vault.move(dbCtx(ctx), ctx.role!, parse(MoveToVaultRequest, body));
  }

  /** §10 "Bring the files back", staying connected: owner only, with a recent sign-in. */
  @Post('bring-back')
  @HttpCode(200)
  bringBack(@Ctx() ctx: RequestContext) {
    requireRecentAuth(ctx);
    return this.vault.bringBack(dbCtx(ctx), ctx.role!);
  }

  /** "Try again" and "Send again" (§4.5, §12): owners and admins (D4). */
  @Post('retry')
  @HttpCode(200)
  retry(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    return this.vault.retry(dbCtx(ctx), ctx.role!, parse(RetryVaultItemsRequest, body ?? {}));
  }

  @Get('items')
  items(@Ctx() ctx: RequestContext, @Query() query: unknown) {
    return this.vault.items(dbCtx(ctx), ctx.role!, parse(VaultItemsQuery, query));
  }

  /** The badges on files (§13): anyone who can see the files. */
  @Get('files')
  files(@Ctx() ctx: RequestContext, @Query() query: unknown) {
    return this.vault.fileStates(dbCtx(ctx), parse(FileStorageStatesQuery, query).ids);
  }

  @Delete()
  @HttpCode(204)
  async disconnect(@Ctx() ctx: RequestContext, @Body() body: unknown): Promise<void> {
    requireRecentAuth(ctx);
    await this.vault.disconnect(dbCtx(ctx), ctx.role!, parse(DisconnectVaultRequest, body ?? {}));
  }
}

/**
 * §2, §7: the two requests that carry a vault API key's secret, an owner's with a recent sign-in. Outside the
 * idempotency interceptor, which keeps a hash of each request's body and the answer for a replay: nothing made from
 * the secret is stored anywhere but its sealed value. The answers carry no secret either way.
 */
@Controller('v1/workspaces/:workspaceId/family-vault')
@UseGuards(AuthGuard, WorkspaceGuard)
export class VaultKeyController {
  constructor(
    @Inject(VaultService) private readonly vault: VaultService,
    @Inject(Plans) private readonly plans: Plans,
  ) {}

  /** §2: connect with the connection string the vault gave for Montra's API key (and its secret, when not in it). */
  @Post()
  async connect(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    requireRecentAuth(ctx);
    await this.plans.requireFeature(dbCtx(ctx), 'familyVault');
    return this.vault.connect(dbCtx(ctx), ctx.role!, parse(ConnectVaultRequest, body ?? {}));
  }

  /** "Replace the key": a new key the owner generated in the vault, checked before Montra switches to it. */
  @Post('key')
  @HttpCode(200)
  replaceKey(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    requireRecentAuth(ctx);
    return this.vault.replaceKey(dbCtx(ctx), ctx.role!, parse(ReplaceVaultKeyRequest, body ?? {}));
  }
}

/**
 * §9 "Open in the vault": anyone who can see the file. A single-use link is made for this click and the answer is a
 * redirect to it, never a body with it in. POST, so nothing prefetches it, and outside the idempotency interceptor,
 * which would store the answer for a replay.
 */
@Controller('v1/workspaces/:workspaceId/family-vault/files/:fileId/open')
@UseGuards(AuthGuard, WorkspaceGuard)
export class VaultOpenController {
  constructor(@Inject(VaultOpener) private readonly opener: VaultOpener) {}

  @Post()
  @HttpCode(303)
  async open(
    @Ctx() ctx: RequestContext,
    @Param('fileId') fileId: string,
    @Query() query: unknown,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<void> {
    void reply.header('cache-control', 'no-store');
    void reply.header('referrer-policy', 'no-referrer');
    let url: URL;
    try {
      url = await this.opener.open(dbCtx(ctx), parse(Id, fileId), parse(VaultOpenQuery, query).mode);
    } catch (e) {
      if (e instanceof VaultOpenRefused && e.retryAfterSeconds) {
        void reply.header('retry-after', String(e.retryAfterSeconds));
      }
      throw e;
    }
    void reply.header('location', url.href);
  }
}

const RegisterRequest = z.object({ approved: z.boolean().default(true) }).strict();

/**
 * Only with `FAMILY_VAULT_FAKE=on` (never in production, `config.ts`): stands in for the vault's owner connecting
 * Montra in the in-process fake vault and generating its API keys, so the e2e run can connect a workspace end to end
 * without any real vault. It answers what the vault shows its owner: the connection string and the fake's secret.
 */
@Controller('v1/dev/fake-vault')
@UseGuards(AuthGuard)
export class FakeVaultController {
  constructor(@Inject(VAULT_TRANSPORT) private readonly transport: VaultTransport) {}

  private fake(): FakeVaultHandle {
    const fake = this.transport.fake as FakeVaultHandle | undefined;
    if (!fake) throw new AppError(404, 'not_found', 'Not found');
    return fake;
  }

  @Post('apps')
  async register(@Body() body: unknown) {
    const fake = this.fake();
    const req = parse(RegisterRequest, body ?? {});
    const k = await fake.register({ approved: req.approved });
    return { appId: k.appId, clientId: k.clientId, code: k.code, secret: k.secret };
  }

  @Post('apps/:appId/keys')
  async newKey(@Param('appId') appId: string) {
    const k = await this.fake().newKey(appId);
    return { appId: k.appId, clientId: k.clientId, code: k.code, secret: k.secret };
  }
}
