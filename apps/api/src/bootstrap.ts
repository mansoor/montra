import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import multipart from '@fastify/multipart';
import { AppModule } from './app.module.js';
import type { AppConfig } from './config.js';

export async function createApp(config?: AppConfig): Promise<NestFastifyApplication> {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule.forRoot(config),
    new FastifyAdapter({ bodyLimit: 1_048_576 }),
    { logger: config?.NODE_ENV === 'test' ? false : ['log', 'warn', 'error'] },
  );
  // Uploads stream through @fastify/multipart; per-request limits are applied in the uploads controller.
  await app.register(multipart as never, {
    limits: { fileSize: config?.MAX_UPLOAD_BYTES ?? 25 * 1024 * 1024, files: 1 },
  });
  app.enableShutdownHooks();
  return app;
}
