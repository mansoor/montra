import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { loadConfig } from './config.js';
import { Worker } from './jobs/queue.js';
import { OpsJobs } from './ops/ops-jobs.js';
import { ImportJobs } from './imports/import-jobs.js';
import { RulesService } from './categorization/rules.service.js';
import { InsightsService } from './categorization/insights.service.js';
import { FxRatesService } from './fx/fx.service.js';
import { ReceiptJobs } from './receipts/receipt-jobs.js';
import { BackupService } from './data/backup.service.js';
import { OwnershipService } from './data/ownership.service.js';
import { RestoreService } from './data/restore.service.js';
import { NotificationJobs } from './notifications/notification-jobs.service.js';
import { RecommendationsService } from './planning/recommendations.service.js';
import { PayslipJobs } from './payslips/payslip-jobs.js';

/** Worker entrypoint (ADR-0002): the same modules as the API, without the HTTP server. */
const config = loadConfig();
const app = await NestFactory.createApplicationContext(AppModule.forRoot(config, { worker: true }), {
  logger: ['log', 'warn', 'error'],
});
app.enableShutdownHooks();
app.get(ImportJobs).register();
app.get(RulesService).register();
app.get(InsightsService).register();
app.get(ReceiptJobs).register();
app.get(PayslipJobs).register();
const planning = app.get(RecommendationsService);
planning.register();
const notifications = app.get(NotificationJobs);
notifications.register();
app.get(BackupService).register();
app.get(RestoreService).register();
const retention = app.get(OwnershipService);
retention.register();
const fx = app.get(FxRatesService);
fx.register(app.get(Worker));
// Catch up at start-up; each daily run queues the next one.
if (config.FX_DAILY) await fx.schedule();
// Hourly check that queues each workspace's nightly planning run after its local 03:00 (TZ-04).
await planning.schedule();
// Sends what's waiting every few minutes (NOT-01), holding it through quiet hours.
await notifications.schedule();
// Hourly: expired archives, files past retention, accounts past their 30 days, and scheduled backups (BAK-05, BAK-09).
await retention.schedule();
// Nightly reconciliation of every workspace's books, and the hourly check for lapsed plans.
const ops = app.get(OpsJobs);
ops.register();
await ops.schedule();
await app.get(Worker).start(['import', 'ai', 'schedule', 'report']);
