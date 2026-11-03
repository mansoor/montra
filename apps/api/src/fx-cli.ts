import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { loadConfig } from './config.js';
import { FxRatesService } from './fx/fx.service.js';

/**
 * Loads exchange rates now (CUR-05): `pnpm --filter @montra/api fx:load` fetches ECB's last 90 days (and
 * OXR's latest when OXR_APP_ID is set); `-- --full` backfills ECB's history since 1999.
 */
const app = await NestFactory.createApplicationContext(AppModule.forRoot(loadConfig(), { worker: true }), {
  logger: ['warn', 'error'],
});
try {
  const result = await app.get(FxRatesService).refresh(process.argv.includes('--full') ? 'full' : 'daily');
  console.log(JSON.stringify(result));
} finally {
  await app.close();
}
