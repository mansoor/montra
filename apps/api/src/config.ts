import { z } from 'zod';

const Env = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().default(4000),
  DATABASE_URL: z.string().default('postgres://montra_app:montra_app@localhost:5432/montra'),
  /** 'dev' accepts `Authorization: Bearer dev:<email>`; production uses Ory Kratos (Phase 1). */
  AUTH_MODE: z.enum(['dev', 'kratos']).default('dev'),
  /** Base64 32-byte master key for the local KMS adapter (development); production uses AWS KMS. */
  MASTER_KEY: z.string().optional(),
});

export type AppConfig = z.infer<typeof Env>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const config = Env.parse(env);
  if (config.NODE_ENV === 'production' && config.AUTH_MODE === 'dev') {
    throw new Error('AUTH_MODE=dev is not allowed in production');
  }
  if (config.NODE_ENV === 'production' && !config.MASTER_KEY) {
    throw new Error('MASTER_KEY (or the AWS KMS adapter) is required in production');
  }
  return config;
}

export const CONFIG = Symbol('CONFIG');
