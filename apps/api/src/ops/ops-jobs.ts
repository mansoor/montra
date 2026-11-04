/** The jobs that keep an eye on the service: nightly reconciliation (risk register) and the billing sweep. */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'kysely';
import { Db } from '../db/database.js';
import { Worker } from '../jobs/queue.js';
import { BillingService } from './billing.service.js';
import { ERROR_REPORTER, type ErrorReporter } from './errors.js';

const DAY_MS = 86_400_000;

export interface ReconciliationResult {
  unbalanced_entries: number;
  read_model_gaps: number;
  sample: unknown[];
}

@Injectable()
export class OpsJobs {
  private readonly logger = new Logger('OpsJobs');

  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(Worker) private readonly worker: Worker,
    @Inject(BillingService) private readonly billing: BillingService,
    @Inject(ERROR_REPORTER) private readonly errors: ErrorReporter,
  ) {}

  /** Should always find nothing. If it finds something, that's a bug in the ledger, and someone gets woken up. */
  async reconcile(): Promise<ReconciliationResult> {
    const { rows } = await this.db.run({ actorType: 'system' }, (trx) =>
      sql<ReconciliationResult>`select * from app.reconcile_books()`.execute(trx),
    );
    const result = rows[0]!;
    if (result.unbalanced_entries > 0 || result.read_model_gaps > 0) {
      const message = `Reconciliation found ${result.unbalanced_entries} unbalanced entries and ${result.read_model_gaps} read model gaps`;
      this.logger.error(message);
      this.errors.captureMessage(message, { sample: result.sample });
    }
    return result;
  }

  register(): void {
    this.billing.register();
    this.worker.register('ops.reconcile', async () => {
      await this.scheduleReconcile(new Date(Date.now() + DAY_MS));
      const { unbalanced_entries, read_model_gaps } = await this.reconcile();
      return { unbalanced_entries, read_model_gaps };
    });
  }

  private scheduleReconcile(at: Date) {
    return this.db.run({ actorType: 'system' }, (trx) =>
      sql`select app.schedule_system_job('schedule', 'ops.reconcile', ${at})`.execute(trx),
    );
  }

  async schedule(): Promise<void> {
    // An hour from now, so that a restart doesn't mean a scan of every workspace's books.
    await this.scheduleReconcile(new Date(Date.now() + 3_600_000));
    await this.billing.schedule();
  }
}
