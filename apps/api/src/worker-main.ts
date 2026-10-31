import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { loadConfig } from './config.js';
import { Worker } from './jobs/queue.js';
import { ImportJobs } from './imports/import-jobs.js';
import { RulesService } from './categorization/rules.service.js';
import { InsightsService } from './categorization/insights.service.js';

/** Worker entrypoint (ADR-0002): the same modules as the API, without the HTTP server. */
const config = loadConfig();
const app = await NestFactory.createApplicationContext(AppModule.forRoot(config, { worker: true }), {
  logger: ['log', 'warn', 'error'],
});
app.enableShutdownHooks();
app.get(ImportJobs).register();
app.get(RulesService).register();
app.get(InsightsService).register();
await app.get(Worker).start(['import', 'ai']);
