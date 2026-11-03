import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { loadConfig } from './config.js';
import { Worker } from './jobs/queue.js';
import { ImportJobs } from './imports/import-jobs.js';
import { RulesService } from './categorization/rules.service.js';
import { InsightsService } from './categorization/insights.service.js';
import { FxRatesService } from './fx/fx.service.js';
import { ReceiptJobs } from './receipts/receipt-jobs.js';
import { RecommendationsService } from './planning/recommendations.service.js';

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
const planning = app.get(RecommendationsService);
planning.register();
const fx = app.get(FxRatesService);
fx.register(app.get(Worker));
// Catch up at start-up; each daily run queues the next one.
if (config.FX_DAILY) await fx.schedule();
// Hourly check that queues each workspace's nightly planning run after its local 03:00 (TZ-04).
await planning.schedule();
await app.get(Worker).start(['import', 'ai', 'schedule']);
