import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { UpdateNotificationPrefsRequest } from '@montra/schemas';
import { z } from 'zod';
import { AuthGuard, Ctx, dbCtx, WorkspaceGuard, type RequestContext } from '../auth/auth.js';
import { parse } from '../common/zod.js';
import { NotificationsService } from './notifications.service.js';

/** The inbox, per workspace (NOT-01). */
@Controller('v1/workspaces/:workspaceId/notifications')
@UseGuards(AuthGuard, WorkspaceGuard)
export class NotificationsController {
  constructor(@Inject(NotificationsService) private readonly notifications: NotificationsService) {}

  @Get()
  list(@Ctx() ctx: RequestContext, @Query() q: unknown) {
    const { limit, unread } = parse(
      z.object({
        limit: z.coerce.number().int().min(1).max(200).default(50),
        unread: z
          .enum(['true', 'false'])
          .optional()
          .transform((v) => v === 'true'),
      }),
      q,
    );
    return this.notifications.list(dbCtx(ctx), { limit, unreadOnly: unread });
  }

  @Get('unread-count')
  async unread(@Ctx() ctx: RequestContext) {
    return { unread: await this.notifications.unread(dbCtx(ctx)) };
  }

  @Post(':id/read')
  @HttpCode(204)
  async read(@Ctx() ctx: RequestContext, @Param('id') id: string): Promise<void> {
    await this.notifications.markRead(dbCtx(ctx), parse(z.uuid(), id));
  }

  @Post('read-all')
  @HttpCode(204)
  async readAll(@Ctx() ctx: RequestContext): Promise<void> {
    await this.notifications.markAllRead(dbCtx(ctx));
  }
}

/** Preferences follow the user across workspaces (NOT-01, NOT-03). */
@Controller('v1/me/notification-prefs')
@UseGuards(AuthGuard)
export class NotificationPrefsController {
  constructor(@Inject(NotificationsService) private readonly notifications: NotificationsService) {}

  @Get()
  get(@Ctx() ctx: RequestContext) {
    return this.notifications.getPrefs(ctx.user.id);
  }

  @Patch()
  update(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    return this.notifications.updatePrefs(ctx.user.id, parse(UpdateNotificationPrefsRequest, body));
  }
}

/**
 * One-click unsubscribe (RFC 8058, OPS-10): the mail client posts here with no session, and the token is the only credential. It can
 * do nothing else, and it always answers the same way, so it can't be used to find out whether a token exists.
 */
@Controller('v1/unsubscribe')
export class UnsubscribeController {
  constructor(@Inject(NotificationsService) private readonly notifications: NotificationsService) {}

  @Post()
  @HttpCode(200)
  @Header('cache-control', 'no-store')
  async post(@Query() q: unknown) {
    const parsed = z.object({ token: z.uuid() }).safeParse(q);
    if (parsed.success) await this.notifications.unsubscribe(parsed.data.token);
    return { unsubscribed: true };
  }
}
