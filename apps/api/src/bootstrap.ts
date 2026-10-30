import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from './app.module.js';
import type { AppConfig } from './config.js';

export async function createApp(config?: AppConfig): Promise<NestFastifyApplication> {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule.forRoot(config),
    new FastifyAdapter({ bodyLimit: 1_048_576 }),
    { logger: config?.NODE_ENV === 'test' ? false : ['log', 'warn', 'error'] },
  );
  app.enableShutdownHooks();
  return app;
}
