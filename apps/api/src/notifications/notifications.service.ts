/**
 * Notifications (NOT-01..03, OPS-10; ADR-0019 §5, §6). Written once for each member under their own RLS, then delivered per channel:
 * off by preference, held through quiet hours, in-app only past the daily cap. Email and push say what happened and where; the only
 * figures that leave are in the weekly digest's email, which a user can turn off, and push never carries one.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'kysely';
import { newId, type NotificationChannelStatus, type Trx } from '@montra/db';
import { channelOutcome, deliveryTime, localClock, type QuietHours } from '@montra/domain';
import {
  NOTIFICATION_TYPES,
  type ChannelPrefs,
  type NotificationDto,
  type NotificationListDto,
  type NotificationPrefsDto,
  type NotificationType,
  type UpdateNotificationPrefsRequest,
} from '@montra/schemas';
import { AppError, notFound } from '../common/errors.js';
import { CONFIG, type AppConfig } from '../config.js';
import { Db } from '../db/database.js';
import { MAIL_PORT, type MailPort } from '../mail/mail.service.js';
import { PUSH_PORT, type PushPort } from './push.js';

type Ctx = { workspaceId: string; userId: string };

/** Sensible until someone says otherwise: everything in-app; what needs acting on by email or push too. */
const on = (email: boolean, push: boolean): ChannelPrefs => ({ inApp: true, email, push });
export const DEFAULT_CHANNELS: Record<NotificationType, ChannelPrefs> = {
  bill_due: on(true, true),
  low_balance: on(true, true),
  overspend_pace: on(false, true),
  large_transaction: on(false, true),
  rent_overdue: on(true, true),
  lease_expiring: on(true, true),
  import_reminder: on(false, true),
  monthly_review: on(true, false),
  tax_due: on(true, true),
  reminder: on(true, true),
  suggestion: on(false, false),
  weekly_digest: on(true, false),
  backup_ready: on(true, false),
};

/** Asked for by the person it goes to, so unsubscribing from notifications and the daily cap don't apply. */
const REQUESTED: ReadonlySet<NotificationType> = new Set(['backup_ready']);

export interface NewNotification {
  type: NotificationType;
  dedupeKey: string;
  title: string;
  body?: string;
  /** Inside the app: `/w/<id>/...`. */
  link?: string | null;
}

interface Prefs {
  channels: Record<NotificationType, ChannelPrefs>;
  quiet: QuietHours | null;
  dailyCap: number;
  digestWeekday: number;
  largeTransaction: bigint;
  lowBalanceDays: number;
  importReminderDays: number;
  unsubscribed: boolean;
  unsubscribeToken: string | null;
  timeZone: string;
  version: number;
}

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger('Notifications');

  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(MAIL_PORT) private readonly mail: MailPort,
    @Inject(PUSH_PORT) private readonly push: PushPort,
  ) {}

  // ----- Inbox ----------------------------------------------------------------------------------------------

  async list(ctx: Ctx, opts: { limit: number; unreadOnly?: boolean }): Promise<NotificationListDto> {
    return this.db.run(ctx, async (trx) => {
      const rows = await trx
        .selectFrom('app.notification')
        .selectAll()
        .where('workspace_id', '=', ctx.workspaceId)
        .where('user_id', '=', ctx.userId)
        .$if(!!opts.unreadOnly, (q) => q.where('read_at', 'is', null))
        .orderBy('created_at', 'desc')
        .limit(opts.limit)
        .execute();
      return { data: rows.map(dto), unread: await this.unreadIn(trx, ctx) };
    });
  }

  private async unreadIn(trx: Trx, ctx: Ctx): Promise<number> {
    const { n } = await trx
      .selectFrom('app.notification')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('workspace_id', '=', ctx.workspaceId)
      .where('user_id', '=', ctx.userId)
      .where('read_at', 'is', null)
      .executeTakeFirstOrThrow();
    return Number(n);
  }

  async unread(ctx: Ctx): Promise<number> {
    return this.db.run(ctx, (trx) => this.unreadIn(trx, ctx));
  }

  async markRead(ctx: Ctx, id: string): Promise<void> {
    await this.db.run(ctx, async (trx) => {
      const res = await trx
        .updateTable('app.notification')
        .set({ read_at: new Date() })
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', id)
        .where('read_at', 'is', null)
        .executeTakeFirst();
      if (!res.numUpdatedRows) {
        const exists = await trx
          .selectFrom('app.notification')
          .select('id')
          .where('workspace_id', '=', ctx.workspaceId)
          .where('id', '=', id)
          .executeTakeFirst();
        if (!exists) throw notFound('Notification');
      }
    });
  }

  async markAllRead(ctx: Ctx): Promise<void> {
    await this.db.run(ctx, (trx) =>
      trx
        .updateTable('app.notification')
        .set({ read_at: new Date() })
        .where('workspace_id', '=', ctx.workspaceId)
        .where('user_id', '=', ctx.userId)
        .where('read_at', 'is', null)
        .execute(),
    );
  }

  // ----- Preferences ------------------------------------------------------------------------------------------

  async prefsIn(trx: Trx, userId: string): Promise<Prefs> {
    const [row, user] = await Promise.all([
      trx.selectFrom('app.notification_pref').selectAll().where('user_id', '=', userId).executeTakeFirst(),
      trx.selectFrom('app.app_user').select('time_zone').where('id', '=', userId).executeTakeFirst(),
    ]);
    const channels = { ...DEFAULT_CHANNELS };
    for (const t of NOTIFICATION_TYPES) {
      const stored = row?.channels?.[t];
      if (stored) channels[t] = stored;
    }
    // Reading doesn't write, so someone who has never opened settings has the column defaults.
    const start = row ? row.quiet_start : 22 * 60;
    const end = row ? row.quiet_end : 7 * 60;
    return {
      channels,
      quiet: start === null || end === null ? null : { start, end },
      dailyCap: row?.daily_cap ?? 5,
      digestWeekday: row?.digest_weekday ?? 1,
      largeTransaction: BigInt(row?.large_transaction_minor ?? 50000),
      lowBalanceDays: row?.low_balance_days ?? 14,
      importReminderDays: row?.import_reminder_days ?? 9,
      unsubscribed: row?.email_unsubscribed_at != null,
      unsubscribeToken: row?.unsubscribe_token ?? null,
      timeZone: user?.time_zone ?? 'UTC',
      version: Number(row?.version ?? 0),
    };
  }

  private prefsDto(p: Prefs): NotificationPrefsDto {
    return {
      channels: p.channels,
      quietStart: p.quiet?.start ?? null,
      quietEnd: p.quiet?.end ?? null,
      dailyCap: p.dailyCap,
      digestWeekday: p.digestWeekday,
      largeTransaction: String(p.largeTransaction),
      lowBalanceDays: p.lowBalanceDays,
      importReminderDays: p.importReminderDays,
      emailUnsubscribed: p.unsubscribed,
      version: p.version,
    };
  }

  async getPrefs(userId: string): Promise<NotificationPrefsDto> {
    return this.db.run({ userId }, async (trx) => this.prefsDto(await this.prefsIn(trx, userId)));
  }

  async updatePrefs(userId: string, req: UpdateNotificationPrefsRequest): Promise<NotificationPrefsDto> {
    return this.db.run({ userId }, async (trx) => {
      const current = await this.prefsIn(trx, userId);
      const channels = { ...current.channels, ...req.channels };
      const values = {
        channels: JSON.stringify(channels),
        quiet_start: req.quietStart === undefined ? (current.quiet?.start ?? null) : req.quietStart,
        quiet_end: req.quietEnd === undefined ? (current.quiet?.end ?? null) : req.quietEnd,
        daily_cap: req.dailyCap ?? current.dailyCap,
        digest_weekday: req.digestWeekday ?? current.digestWeekday,
        large_transaction_minor: req.largeTransaction ?? String(current.largeTransaction),
        low_balance_days: req.lowBalanceDays ?? current.lowBalanceDays,
        import_reminder_days: req.importReminderDays ?? current.importReminderDays,
        email_unsubscribed_at:
          req.emailUnsubscribed === undefined
            ? current.unsubscribed
              ? new Date()
              : null
            : req.emailUnsubscribed
              ? new Date()
              : null,
      };
      await trx
        .insertInto('app.notification_pref')
        .values({ user_id: userId, ...values })
        .onConflict((oc) => oc.column('user_id').doUpdateSet(values))
        .execute();
      return this.prefsDto(await this.prefsIn(trx, userId));
    });
  }

  /** One-click unsubscribe (RFC 8058, OPS-10). The token is all it takes, because the mail client has no session. */
  async unsubscribe(token: string): Promise<boolean> {
    const { rows } = await this.db.run({}, (trx) =>
      sql<{ done: boolean }>`select app.unsubscribe_notifications(${token}::uuid) as done`.execute(trx),
    );
    return rows[0]?.done === true;
  }

  // ----- Writing --------------------------------------------------------------------------------------------------

  /** Writes one, once. Returns false if it was already written, or every channel for it is off. */
  async create(trx: Trx, ctx: Ctx, n: NewNotification, prefs: Prefs, now = new Date()): Promise<boolean> {
    const channels = prefs.channels[n.type];
    if (!channels.inApp && !channels.email && !channels.push) return false;
    const res = await trx
      .insertInto('app.notification')
      .values({
        workspace_id: ctx.workspaceId,
        id: newId(),
        user_id: ctx.userId,
        type: n.type,
        title: n.title.slice(0, 200),
        body: (n.body ?? '').slice(0, 1000),
        link: n.link ?? null,
        dedupe_key: n.dedupeKey,
        deliver_after: deliveryTime(now, prefs.timeZone, prefs.quiet),
        // Not wanted in the app, so it goes out but doesn't wait in the inbox.
        read_at: channels.inApp ? null : now,
      })
      .onConflict((oc) => oc.columns(['workspace_id', 'user_id', 'dedupe_key']).doNothing())
      .executeTakeFirst();
    return Boolean(res.numInsertedOrUpdatedRows);
  }

  // ----- Delivering -----------------------------------------------------------------------------------------------

  /** Sends everything due. One person's failure doesn't hold up anyone else's. */
  async deliverWaiting(limit = 200, now = new Date()): Promise<number> {
    const { rows } = await this.db.run({}, (trx) =>
      sql<{
        workspace_id: string;
        user_id: string;
      }>`select * from app.notifications_waiting(${limit})`.execute(trx),
    );
    let sent = 0;
    for (const r of rows) {
      try {
        sent += await this.deliverFor({ workspaceId: r.workspace_id, userId: r.user_id }, now);
      } catch (e) {
        this.logger.warn(`Delivery failed for a user in ${r.workspace_id}: ${(e as Error).message}`);
      }
    }
    return sent;
  }

  private async deliverFor(ctx: Ctx, now: Date): Promise<number> {
    const { waiting, prefs, email, tokens, sentToday } = await this.db.run(ctx, async (trx) => {
      // An email carries an unsubscribe link, so the row holding its token has to exist by now.
      await sql`select app.ensure_notification_pref(${ctx.userId}::uuid)`.execute(trx);
      const p = await this.prefsIn(trx, ctx.userId);
      const today = localClock(now, p.timeZone).date;
      const [rows, user, devices, count] = await Promise.all([
        trx
          .selectFrom('app.notification')
          .selectAll()
          .where('workspace_id', '=', ctx.workspaceId)
          .where('user_id', '=', ctx.userId)
          .where('deliver_after', '<=', sql<Date>`now()`)
          .where((eb) => eb.or([eb('email_status', 'is', null), eb('push_status', 'is', null)]))
          .orderBy('created_at')
          .execute(),
        trx.selectFrom('app.app_user').select('email').where('id', '=', ctx.userId).executeTakeFirst(),
        trx.selectFrom('app.push_device').select('token').where('user_id', '=', ctx.userId).execute(),
        // Across workspaces it'd be more exact, but RLS keeps this to one, and few people have several.
        sql<{ n: string }>`
          select count(*)::text as n from app.notification
           where workspace_id = ${ctx.workspaceId} and user_id = ${ctx.userId}
             and (email_status = 'sent' or push_status = 'sent')
             and (created_at at time zone ${p.timeZone})::date = ${today}::date`.execute(trx),
      ]);
      return {
        waiting: rows,
        prefs: p,
        email: user?.email ?? null,
        tokens: devices.map((d) => d.token),
        sentToday: Number(count.rows[0]?.n ?? 0),
      };
    });
    let sentCount = sentToday;
    let sent = 0;
    for (const n of waiting) {
      const type = n.type as NotificationType;
      const requested = REQUESTED.has(type);
      const channels = prefs.channels[type];
      const cap = requested ? Number.MAX_SAFE_INTEGER : prefs.dailyCap;
      const emailOutcome = channelOutcome({
        enabled: channels.email && (requested || !prefs.unsubscribed),
        hasDestination: Boolean(email),
        sentToday: sentCount,
        cap,
      });
      const pushOutcome = channelOutcome({
        enabled: channels.push,
        hasDestination: tokens.length > 0,
        sentToday: sentCount,
        cap,
      });
      let emailStatus: NotificationChannelStatus = emailOutcome === 'send' ? 'sent' : emailOutcome;
      let pushStatus: NotificationChannelStatus = pushOutcome === 'send' ? 'sent' : pushOutcome;
      if (emailOutcome === 'send') {
        try {
          await this.sendEmail(email!, n, prefs, requested);
        } catch (e) {
          emailStatus = 'failed';
          this.logger.warn(`Email failed: ${(e as Error).message}`);
        }
      }
      if (pushOutcome === 'send') {
        try {
          const { deadTokens } = await this.push.send(
            tokens.map((token) => ({ token, title: n.title, link: n.link })),
          );
          if (deadTokens.length) await this.forgetDevices(ctx.userId, deadTokens);
        } catch (e) {
          pushStatus = 'failed';
          this.logger.warn(`Push failed: ${(e as Error).message}`);
        }
      }
      if (emailStatus === 'sent' || pushStatus === 'sent') {
        sentCount++;
        sent++;
      }
      await this.db.run(ctx, (trx) =>
        trx
          .updateTable('app.notification')
          .set({ email_status: emailStatus, push_status: pushStatus })
          .where('workspace_id', '=', ctx.workspaceId)
          .where('id', '=', n.id)
          .execute(),
      );
    }
    return sent;
  }

  private async sendEmail(
    to: string,
    n: { title: string; body: string; link: string | null },
    prefs: Prefs,
    requested: boolean,
  ): Promise<void> {
    const web = this.config.WEB_URL;
    const unsubscribeUrl = prefs.unsubscribeToken
      ? `${web}/unsubscribe?token=${prefs.unsubscribeToken}`
      : null;
    const oneClick = prefs.unsubscribeToken
      ? `${this.config.API_URL}/v1/unsubscribe?token=${prefs.unsubscribeToken}`
      : null;
    const lines = [
      n.body,
      n.link ? `Open Montra: ${web}${n.link}` : `Open Montra: ${web}`,
      '',
      requested || !unsubscribeUrl
        ? 'You asked for this.'
        : `Turn off notification emails: ${unsubscribeUrl}`,
    ];
    await this.mail.send({
      to,
      subject: n.title,
      text: lines.filter((l, i) => l || i > 0).join('\n'),
      category: requested ? 'transactional' : 'notification',
      ...(!requested && oneClick
        ? {
            headers: {
              'List-Unsubscribe': `<${oneClick}>`,
              'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
            },
          }
        : {}),
    });
  }

  private async forgetDevices(userId: string, tokens: string[]): Promise<void> {
    await this.db.run({ userId }, (trx) =>
      trx.deleteFrom('app.push_device').where('user_id', '=', userId).where('token', 'in', tokens).execute(),
    );
  }

  /** Refuses what can't be delivered right now rather than dropping it silently. */
  assertType(type: string): asserts type is NotificationType {
    if (!(NOTIFICATION_TYPES as readonly string[]).includes(type)) {
      throw new AppError(400, 'notification.type', 'Unknown notification type');
    }
  }
}

function dto(r: {
  id: string;
  type: string;
  title: string;
  body: string;
  link: string | null;
  read_at: Date | null;
  created_at: Date;
}): NotificationDto {
  return {
    id: r.id,
    type: r.type as NotificationType,
    title: r.title,
    body: r.body,
    link: r.link,
    read: r.read_at !== null,
    createdAt: r.created_at.toISOString(),
  };
}
