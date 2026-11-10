/** Support access, asking for help, and what's announced (OPS-02, OPS-03, OPS-09). */
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import type { DbContext } from '@montra/db';
import type {
  ClientErrorRequest,
  CreateSupportGrantRequest,
  CreateSupportRequest,
  StatusDto,
  SupportGrantDto,
  SystemNoticeDto,
} from '@montra/schemas';
import { AppError, notFound, unprocessable } from '../common/errors.js';
import { CONFIG, type AppConfig } from '../config.js';
import { Db } from '../db/database.js';
import { MAIL_PORT, type MailPort } from '../mail/mail.service.js';
import { JOB_STALL_MS } from '../jobs/queue.js';
import { ERROR_REPORTER, type ErrorReporter } from './errors.js';

type Ctx = DbContext & { workspaceId: string; userId: string };

/** More than this in a day is someone's script, not someone's question. */
const REQUESTS_PER_DAY = 20;
const STATUS_CACHE_MS = 15_000;

const isImage = (b: Buffer) =>
  (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) ||
  (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff);

@Injectable()
export class SupportService {
  /** Client errors in the current minute, across everyone: a broken release mustn't flood the error tracker. */
  private errorWindow = { minute: 0, count: 0 };

  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(MAIL_PORT) private readonly mail: MailPort,
    @Inject(ERROR_REPORTER) private readonly errors: ErrorReporter,
  ) {}

  async listGrants(ctx: Ctx): Promise<SupportGrantDto[]> {
    return this.db.run(ctx, async (trx) => {
      const rows = await trx
        .selectFrom('app.support_grant')
        .selectAll()
        .where('workspace_id', '=', ctx.workspaceId)
        .orderBy('created_at', 'desc')
        .limit(20)
        .execute();
      const now = Date.now();
      return rows.map((r) => ({
        id: r.id,
        expiresAt: r.expires_at.toISOString(),
        revokedAt: r.revoked_at?.toISOString() ?? null,
        reason: r.reason,
        createdAt: r.created_at.toISOString(),
        active: !r.revoked_at && r.expires_at.getTime() > now,
      }));
    });
  }

  async createGrant(ctx: Ctx, req: CreateSupportGrantRequest): Promise<SupportGrantDto> {
    const expires = new Date(Date.now() + req.hours * 3_600_000);
    return this.db.run(ctx, async (trx) => {
      const row = await trx
        .insertInto('app.support_grant')
        .values({
          workspace_id: ctx.workspaceId,
          granted_by: ctx.userId,
          reason: req.reason,
          expires_at: expires,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      return {
        id: row.id,
        expiresAt: row.expires_at.toISOString(),
        revokedAt: null,
        reason: row.reason,
        createdAt: row.created_at.toISOString(),
        active: true,
      };
    });
  }

  async revokeGrant(ctx: Ctx, id: string): Promise<void> {
    await this.db.run(ctx, async (trx) => {
      const done = await trx
        .updateTable('app.support_grant')
        .set({ revoked_at: new Date() })
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', id)
        .where('revoked_at', 'is', null)
        .executeTakeFirst();
      if (!done.numUpdatedRows) throw notFound('Access');
    });
  }

  async createRequest(userId: string, email: string, req: CreateSupportRequest): Promise<{ id: string }> {
    const screenshot = req.screenshot ? Buffer.from(req.screenshot, 'base64') : null;
    if (screenshot && !isImage(screenshot))
      throw unprocessable('support.bad_screenshot', 'A screenshot has to be a PNG or JPEG');
    const row = await this.db.run({ userId }, async (trx) => {
      const { n } = await trx
        .selectFrom('app.support_request')
        .select((eb) => eb.fn.countAll<string>().as('n'))
        .where('user_id', '=', userId)
        .where('created_at', '>', new Date(Date.now() - 86_400_000))
        .executeTakeFirstOrThrow();
      if (Number(n) >= REQUESTS_PER_DAY)
        throw new AppError(429, 'support.too_many', 'Please wait for a reply before sending more');
      // A workspace named here has to be one of theirs. RLS on the row can't check that for them.
      if (req.workspaceId) {
        const member = await trx
          .selectFrom('app.workspace_member')
          .select('user_id')
          .where('workspace_id', '=', req.workspaceId)
          .where('user_id', '=', userId)
          .where('status', '=', 'active')
          .executeTakeFirst();
        if (!member) throw notFound('Workspace');
      }
      return trx
        .insertInto('app.support_request')
        .values({
          user_id: userId,
          workspace_id: req.workspaceId ?? null,
          kind: req.kind,
          subject: req.subject,
          body: req.body,
          context: JSON.stringify(req.context ?? {}),
          screenshot,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
    });
    if (this.config.SUPPORT_EMAIL) {
      // Only that there is one. What it says stays in the console, behind the staff sign-in.
      await this.mail
        .send({
          to: this.config.SUPPORT_EMAIL,
          subject: `New ${req.kind === 'bug' ? 'bug report' : 'question'} ${row.id}`,
          text: `From ${email}. Read it in the staff console: ${this.config.WEB_URL}/admin/support`,
          category: 'transactional',
        })
        .catch(() => undefined);
    }
    return { id: row.id };
  }

  async listRequests(userId: string) {
    return this.db.run({ userId }, async (trx) => {
      const rows = await trx
        .selectFrom('app.support_request')
        .select(['id', 'kind', 'subject', 'status', 'created_at'])
        .where('user_id', '=', userId)
        .orderBy('created_at', 'desc')
        .limit(50)
        .execute();
      return rows.map((r) => ({ ...r, created_at: undefined, createdAt: r.created_at.toISOString() }));
    });
  }

  reportClientError(userId: string, req: ClientErrorRequest): void {
    const minute = Math.floor(Date.now() / 60_000);
    if (this.errorWindow.minute !== minute) this.errorWindow = { minute, count: 0 };
    if (++this.errorWindow.count > 60) return;
    this.errors.captureMessage(`[${req.source}] ${req.message}`, {
      userId,
      path: req.path?.split('?')[0],
      stack: req.stack,
    });
  }
}

/**
 * Each worker's state from its queues' lag (seconds the oldest ready job has waited). The doc-worker runs the
 * `doc` queue; the API's job worker runs the rest.
 */
export function workerStates(queues: { queue: string; lag_seconds: number }[]): StatusDto['workers'] {
  const delayed = (q: { lag_seconds: number }) => Number(q.lag_seconds) * 1000 > JOB_STALL_MS;
  return {
    documents: queues.some((q) => q.queue === 'doc' && delayed(q)) ? 'delayed' : 'ok',
    jobs: queues.some((q) => q.queue !== 'doc' && delayed(q)) ? 'delayed' : 'ok',
  };
}

@Injectable()
export class StatusService {
  private cached: { at: number; value: StatusDto } | null = null;

  constructor(@Inject(Db) private readonly db: Db) {}

  async current(): Promise<StatusDto> {
    const now = Date.now();
    if (this.cached && now - this.cached.at < STATUS_CACHE_MS) return this.cached.value;
    const value = await this.read().catch(
      // If the database can't be reached that's the answer, rather than an error page on the status page.
      (): StatusDto => ({
        status: 'down',
        checkedAt: new Date().toISOString(),
        notices: [],
        workers: { documents: 'ok', jobs: 'ok' },
      }),
    );
    this.cached = { at: now, value };
    return value;
  }

  /** Forgets the last answer, for tests and for right after staff post something. */
  forget(): void {
    this.cached = null;
  }

  private async read(): Promise<StatusDto> {
    const notices = await this.db.run({}, async (trx) =>
      trx
        .selectFrom('app.system_notice')
        .selectAll()
        .where('show_from', '<=', sql<Date>`now()`)
        .where((eb) => eb.or([eb('ends_at', 'is', null), eb('ends_at', '>', sql<Date>`now()`)]))
        .orderBy('created_at', 'desc')
        .limit(20)
        .execute(),
    );
    const { rows: queues } = await this.db.run({}, (trx) =>
      sql<{ queue: string; lag_seconds: number }>`select queue, lag_seconds from app.metrics_queue()`.execute(
        trx,
      ),
    );
    const now = Date.now();
    const started = (n: (typeof notices)[number]) => !n.starts_at || n.starts_at.getTime() <= now;
    const status = notices.some((n) => n.kind === 'incident' && started(n))
      ? 'incident'
      : notices.some((n) => n.kind === 'maintenance' && n.starts_at && n.starts_at.getTime() <= now)
        ? 'maintenance'
        : 'operational';
    return {
      status,
      checkedAt: new Date().toISOString(),
      notices: notices.map((n): SystemNoticeDto => ({
        id: n.id,
        kind: n.kind as SystemNoticeDto['kind'],
        title: n.title,
        body: n.body,
        startsAt: n.starts_at?.toISOString() ?? null,
        endsAt: n.ends_at?.toISOString() ?? null,
      })),
      workers: workerStates(queues),
    };
  }
}
