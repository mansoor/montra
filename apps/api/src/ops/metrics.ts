/** What monitoring scrapes (NFR-13, OPS-07, ADR-0020 §10). Everything but request timing is counted in the database. */
import { createHash, timingSafeEqual } from 'node:crypto';
import {
  Inject,
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { sql } from 'kysely';
import { Counter, Gauge, Histogram, Registry } from 'prom-client';
import { isVersionBelow } from '@montra/domain';
import type { Observable } from 'rxjs';
import { AppError } from '../common/errors.js';
import { CONFIG, type AppConfig } from '../config.js';
import { Db } from '../db/database.js';

export const METRICS_CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';

const sha = (s: string) => createHash('sha256').update(s).digest();

@Injectable()
export class MetricsService {
  private readonly registry = new Registry();
  private readonly duration = new Histogram({
    name: 'montra_http_request_duration_seconds',
    help: 'API request duration',
    labelNames: ['method', 'route', 'status'],
    buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10],
    registers: [this.registry],
  });
  private readonly requests = new Counter({
    name: 'montra_http_requests_total',
    help: 'API requests',
    labelNames: ['method', 'route', 'status'],
    registers: [this.registry],
  });
  private readonly queueLag = new Gauge({
    name: 'montra_job_queue_lag_seconds',
    help: 'Age of the oldest job waiting to run',
    labelNames: ['queue'],
    registers: [this.registry],
  });
  private readonly jobFailures = new Gauge({
    name: 'montra_job_failures_total',
    help: 'Jobs that failed for good',
    labelNames: ['queue', 'type'],
    registers: [this.registry],
  });
  private readonly aiCalls = new Gauge({
    name: 'montra_ai_calls_total',
    help: 'AI calls by outcome',
    labelNames: ['provider', 'task', 'outcome'],
    registers: [this.registry],
  });
  private readonly aiAccepted = new Gauge({
    name: 'montra_ai_suggestions_accepted_ratio',
    help: 'Share of AI suggestions accepted without an edit, over 30 days',
    registers: [this.registry],
  });
  private readonly importFailures = new Gauge({
    name: 'montra_import_failures_total',
    help: 'Failed imports by bank format',
    labelNames: ['institution', 'file_type'],
    registers: [this.registry],
  });
  private readonly importParse = new Gauge({
    name: 'montra_import_parse_p95_seconds',
    help: 'Import parse time over 24 hours, 95th percentile, including time in the queue',
    registers: [this.registry],
  });
  private readonly reconciliation = new Gauge({
    name: 'montra_reconciliation_failures',
    help: 'Problems found by the last nightly reconciliation',
    registers: [this.registry],
  });
  private readonly reconciliationAge = new Gauge({
    name: 'montra_reconciliation_age_seconds',
    help: 'How long ago reconciliation last ran',
    registers: [this.registry],
  });
  private readonly backupFailures = new Gauge({
    name: 'montra_backup_job_failures_total',
    help: 'Backups that failed',
    registers: [this.registry],
  });

  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  /** Off unless a token is set, and the comparison takes the same time whatever was sent. */
  authorized(header: string | undefined): boolean {
    const token = this.config.METRICS_TOKEN;
    if (!token || !header) return false;
    return timingSafeEqual(sha(header), sha(`Bearer ${token}`));
  }

  attach(fastify: FastifyInstance): void {
    fastify.addHook('onResponse', async (req: FastifyRequest, reply) => {
      // The route's pattern and not the URL, which has ids in it and would make a series per workspace.
      const route = req.routeOptions.url ?? 'unmatched';
      if (route === '/internal/metrics') return;
      const labels = { method: req.method, route, status: String(reply.statusCode) };
      this.requests.inc(labels);
      this.duration.observe(labels, reply.elapsedTime / 1000);
    });
  }

  async render(): Promise<string> {
    await this.db.run({ actorType: 'system' }, async (trx) => {
      const queue = await sql<{ queue: string; lag_seconds: number }>`
        select queue, lag_seconds from app.metrics_queue()`.execute(trx);
      this.queueLag.reset();
      for (const r of queue.rows) this.queueLag.set({ queue: r.queue }, Number(r.lag_seconds));

      const failed = await sql<{ queue: string; type: string; failed: string }>`
        select * from app.metrics_job_failures()`.execute(trx);
      this.jobFailures.reset();
      for (const r of failed.rows) this.jobFailures.set({ queue: r.queue, type: r.type }, Number(r.failed));

      const ai = await sql<{ provider: string; task: string; outcome: string; calls: string }>`
        select * from app.metrics_ai()`.execute(trx);
      this.aiCalls.reset();
      for (const r of ai.rows) {
        this.aiCalls.set({ provider: r.provider, task: r.task, outcome: r.outcome }, Number(r.calls));
      }

      const accepted = await sql<{ ratio: number }>`select app.metrics_ai_accepted() as ratio`.execute(trx);
      this.aiAccepted.set(Number(accepted.rows[0]?.ratio ?? 0));

      const imports = await sql<{ institution: string; file_type: string; failed: string }>`
        select * from app.metrics_import_failures()`.execute(trx);
      this.importFailures.reset();
      for (const r of imports.rows) {
        this.importFailures.set({ institution: r.institution, file_type: r.file_type }, Number(r.failed));
      }

      const parse = await sql<{ p95: number }>`select app.metrics_import_parse() as p95`.execute(trx);
      this.importParse.set(Number(parse.rows[0]?.p95 ?? 0));

      const ops = await sql<{
        reconciliation_failures: string;
        backup_failures: string;
        last_reconciled: Date | null;
      }>`
        select * from app.metrics_ops()`.execute(trx);
      const o = ops.rows[0];
      this.reconciliation.set(Number(o?.reconciliation_failures ?? 0));
      this.backupFailures.set(Number(o?.backup_failures ?? 0));
      this.reconciliationAge.set(o?.last_reconciled ? (Date.now() - o.last_reconciled.getTime()) / 1000 : 0);
    });
    return this.registry.metrics();
  }
}

const VERSION_CACHE_MS = 60_000;

/** OPS-04: too old a phone app gets 426 and shows an update screen. Web requests don't send these headers. */
@Injectable()
export class AppVersionInterceptor implements NestInterceptor {
  private cached: { at: number; ios: string; android: string } | null = null;

  constructor(@Inject(Db) private readonly db: Db) {}

  private async minimums() {
    if (this.cached && Date.now() - this.cached.at < VERSION_CACHE_MS) return this.cached;
    const rows = await this.db.run({ actorType: 'system' }, (trx) =>
      trx.selectFrom('app.system_setting').select(['key', 'value']).execute(),
    );
    const get = (k: string) => rows.find((r) => r.key === k)?.value ?? '0.0.0';
    this.cached = {
      at: Date.now(),
      ios: get('min_app_version_ios'),
      android: get('min_app_version_android'),
    };
    return this.cached;
  }

  /** For tests, and for right after staff change it in this process. */
  forget(): void {
    this.cached = null;
  }

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    const req = context.switchToHttp().getRequest<FastifyRequest>();
    const version = req.headers['x-app-version'];
    const platform = req.headers['x-app-platform'];
    if (typeof version === 'string' && (platform === 'ios' || platform === 'android')) {
      const min = await this.minimums();
      if (isVersionBelow(version, min[platform])) {
        throw new AppError(426, 'app.update_required', 'Please update Montra to keep using it');
      }
    }
    return next.handle();
  }
}
