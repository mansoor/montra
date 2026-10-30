import { z } from 'zod';

const Env = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().default(4000),
  DATABASE_URL: z.string().default('postgres://montra_app:montra_app@localhost:5432/montra'),
  /** 'dev' accepts `Authorization: Bearer dev:<email>`; production uses Ory Kratos (Phase 1). */
  AUTH_MODE: z.enum(['dev', 'kratos']).default('dev'),
  /** Ory Kratos public API, e.g. http://kratos:4433 (AUTH_MODE=kratos). */
  KRATOS_PUBLIC_URL: z.string().url().optional(),
  /** AUTH-04: owners must use MFA (AAL2) by default; accountants always must. */
  REQUIRE_OWNER_MFA: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  /** Ory Kratos admin API (private network only), e.g. http://kratos:4434. Needed for AUTH-06/11. */
  KRATOS_ADMIN_URL: z.string().url().optional(),
  /** Shared secret Kratos sends in `x-montra-hook-secret` when calling /internal/kratos/hooks. */
  KRATOS_WEBHOOK_SECRET: z.string().min(32).optional(),
  /** How long a validated session is cached; revocation clears it immediately (AUTH-05/07). */
  SESSION_CACHE_SECONDS: z.coerce.number().int().min(0).max(300).default(15),
  /** Outgoing email: 'log' (development), 'memory' (tests), 'smtp' (Mailpit locally, SES/Postmark in production). */
  MAIL_MODE: z.enum(['log', 'memory', 'smtp']).default('log'),
  MAIL_URL: z.string().optional(),
  MAIL_FROM: z.string().default('Montra <no-reply@montra.local>'),
  /** Public web origin used in links inside emails. */
  WEB_URL: z.string().url().default('http://localhost:3000'),
  /** Base64 32-byte master key for the local KMS adapter (development); production uses AWS KMS. */
  MASTER_KEY: z.string().optional(),
});

export type AppConfig = z.infer<typeof Env>;

export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  const config = Env.parse(env);
  if (config.NODE_ENV === 'production' && config.AUTH_MODE === 'dev') {
    throw new Error('AUTH_MODE=dev is not allowed in production');
  }
  if (config.AUTH_MODE === 'kratos' && !config.KRATOS_PUBLIC_URL) {
    throw new Error('KRATOS_PUBLIC_URL is required when AUTH_MODE=kratos');
  }
  if (config.MAIL_MODE === 'smtp' && !config.MAIL_URL)
    throw new Error('MAIL_URL is required when MAIL_MODE=smtp');
  if (config.NODE_ENV === 'production' && !config.MASTER_KEY) {
    throw new Error('MASTER_KEY (or the AWS KMS adapter) is required in production');
  }
  return config;
}

export const CONFIG = Symbol('CONFIG');
