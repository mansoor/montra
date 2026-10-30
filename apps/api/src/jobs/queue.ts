import { hostname } from 'node:os';
import { Inject, Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import { sql } from 'kysely';
import pg from 'pg';
import type { JobTable, Trx } from '@montra/db';
import type { Selectable } from 'kysely';
import { CONFIG, type AppConfig } from '../config.js';
import { Db } from '../db/database.js';
import { AppError } from '../common/errors.js';

export type Job = Selectable<JobTable>;
type Queue = JobTable['queue'];

export interface EnqueueInput {
  workspaceId: string;
  userId: string;
  queue: Queue;
  type: string;
  payload: Record<string, unknown>;
  then?: { queue: Queue; type: string; payload: Record<string, unknown> };
  maxAttempts?: number;
}

/** A job failure that retrying cannot fix (bad file, unsupported format). */
export class PermanentJobError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'PermanentJobError';
  }
}

export interface JobContext {
  progress(percent: number): Promise<void>;
}

export type JobHandler = (job: Job, ctx: JobContext) => Promise<Record<string, unknown>>;

/** Enqueues jobs inside the caller's transaction, so a job exists exactly when its data does (ADR-0011). */
@Injectable()
export class JobQueue {
  async enqueue(trx: Trx, input: EnqueueInput): Promise<string> {
    const row = await trx
      .insertInto('app.job')
      .values({
        workspace_id: input.workspaceId,
        queue: input.queue,
        type: input.type,
        payload: JSON.stringify(input.payload),
        then_job: input.then ? JSON.stringify(input.then) : null,
        created_by: input.userId,
        ...(input.maxAttempts ? { max_attempts: input.maxAttempts } : {}),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return row.id;
  }
}

/**
 * Runs jobs from one or more queues (ADR-0011). Wakes on `montra_jobs` notifications, polls as a fallback,
 * and requeues jobs abandoned by crashed workers. Handlers set their own RLS context per job.
 */
@Injectable()
export class Worker implements OnApplicationShutdown {
  private readonly logger = new Logger('Worker');
  private readonly handlers = new Map<string, JobHandler>();
  private readonly id = `node-${hostname()}-${process.pid}`;
  private listener?: pg.Client;
  private wake?: () => void;
  private running = false;
  private stopped?: Promise<void>;

  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  register(type: string, handler: JobHandler): void {
    this.handlers.set(type, handler);
  }

  /** Claims and runs one job; returns false when the queue is empty. */
  async runOnce(queue: Queue): Promise<boolean> {
    const { rows } = await sql<Job>`select * from app.dequeue_job(${queue}, ${this.id})`.execute(
      this.db.kysely,
    );
    const job = rows[0];
    if (!job) return false;
    const handler = this.handlers.get(job.type);
    try {
      if (!handler) throw new PermanentJobError('job.unknown_type', `No handler for job type ${job.type}`);
      const result = await handler(job, {
        progress: async (p) => {
          await sql`select app.job_progress(${job.id}, ${Math.trunc(p)})`.execute(this.db.kysely);
        },
      });
      await sql`select app.complete_job(${job.id}, ${JSON.stringify(result)}::jsonb)`.execute(this.db.kysely);
    } catch (err) {
      const permanent = err instanceof PermanentJobError || (err instanceof AppError && err.status < 500);
      const code = err instanceof PermanentJobError || err instanceof AppError ? err.code : 'job.error';
      const message = `${code}: ${(err as Error).message}`;
      if (!permanent)
        this.logger.error(`job ${job.id} (${job.type}) failed: ${(err as Error).stack ?? message}`);
      await sql`select app.fail_job(${job.id}, ${message}, ${permanent})`.execute(this.db.kysely);
    }
    return true;
  }

  /** Runs jobs until the queues are empty (tests, one-off scripts). */
  async drain(queues: Queue[] = ['import'], max = 1000): Promise<number> {
    let n = 0;
    while (n < max) {
      let any = false;
      for (const q of queues) {
        if (await this.runOnce(q)) {
          any = true;
          n++;
        }
      }
      if (!any) break;
    }
    return n;
  }

  /** Long-running loop for the worker process. */
  async start(queues: Queue[]): Promise<void> {
    this.running = true;
    this.listener = new pg.Client({ connectionString: this.config.DATABASE_URL });
    this.listener.on('notification', () => this.wake?.());
    await this.listener.connect();
    await this.listener.query('LISTEN montra_jobs');
    let lastSweep = 0;
    this.stopped = (async () => {
      while (this.running) {
        if (Date.now() - lastSweep > 60_000) {
          lastSweep = Date.now();
          await sql`select app.requeue_stale_jobs()`.execute(this.db.kysely).catch(() => {});
        }
        let worked = false;
        for (const q of queues) {
          try {
            worked = (await this.runOnce(q)) || worked;
          } catch (err) {
            this.logger.error(`queue ${q}: ${(err as Error).message}`);
          }
        }
        if (!worked && this.running) {
          await new Promise<void>((resolve) => {
            const t = setTimeout(resolve, 5000);
            this.wake = () => {
              clearTimeout(t);
              resolve();
            };
          });
        }
      }
    })();
    this.logger.log(`worker ${this.id} listening on ${queues.join(', ')}`);
  }

  async onApplicationShutdown(): Promise<void> {
    this.running = false;
    this.wake?.();
    await this.stopped;
    await this.listener?.end().catch(() => {});
  }
}
