import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import { AppModule } from './app.module.js';
import type { AppConfig } from './config.js';
import { MetricsService } from './ops/metrics.js';

export async function createApp(config?: AppConfig): Promise<NestFastifyApplication> {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule.forRoot(config),
    new FastifyAdapter({ bodyLimit: 1_048_576, trustProxy: (config?.TRUST_PROXY_HOPS ?? 0) as never }),
    // The raw body is for checking the payment provider's signature.
    { logger: config?.NODE_ENV === 'test' ? false : ['log', 'warn', 'error'], rawBody: true },
  );
  // Uploads stream through @fastify/multipart; per-request limits are applied in the uploads controller.
  await app.register(multipart as never, {
    limits: { fileSize: config?.MAX_UPLOAD_BYTES ?? 25 * 1024 * 1024, files: 1 },
  });
  // This serves JSON and files, never pages, so nothing should run in a browser from here.
  await app.register(helmet as never, {
    contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
    crossOriginResourcePolicy: { policy: 'same-site' },
    hsts: { maxAge: 31_536_000, includeSubDomains: true },
  });
  app.get(MetricsService).attach(app.getHttpAdapter().getInstance() as never);
  app.enableShutdownHooks();
  return app;
}
