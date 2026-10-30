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
  /** File storage (design 02 §8): 'local' directory for development/tests, 's3' for MinIO or AWS S3. */
  STORAGE_MODE: z.enum(['local', 's3']).default('local'),
  STORAGE_DIR: z.string().default('.data/storage'),
  S3_ENDPOINT: z.string().url().optional(),
  S3_BUCKET: z.string().optional(),
  S3_REGION: z.string().default('us-east-1'),
  S3_ACCESS_KEY: z.string().optional(),
  S3_SECRET_KEY: z.string().optional(),
  /** Maximum upload size in bytes (IMP-01: statements and receipts). */
  MAX_UPLOAD_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(25 * 1024 * 1024),
  /** Public web origin used in links inside emails. */
  WEB_URL: z.string().url().default('http://localhost:3000'),
  /** Base64 32-byte master key for the local KMS adapter (development); production uses AWS KMS. */
  MASTER_KEY: z.string().optional(),

  /**
   * AI gateway (06, ADR-0012). The built-in mode uses `AI_PROVIDER` with Montra's key; `fake` is the
   * deterministic keyword provider for tests and e2e. Without a key the built-in mode degrades to rules
   * and history.
   */
  AI_PROVIDER: z.enum(['anthropic', 'fake', 'openai_compatible', 'null']).default('anthropic'),
  ANTHROPIC_API_KEY: z.string().optional(),
  /** Optional OpenAI-compatible base URL for the built-in provider (AI_PROVIDER=openai_compatible). */
  AI_BASE_URL: z.string().url().optional(),
  /** OPS-07: a second provider tried when the first fails ('fake' only makes sense in tests). */
  AI_FAILOVER_PROVIDER: z.enum(['anthropic', 'fake', 'openai_compatible']).optional(),
  AI_FAILOVER_BASE_URL: z.string().url().optional(),
  /**
   * Local mode: true when this server can reach the user's endpoint (self-hosted edition). False on the
   * hosted service: async AI work is parked for a client on the user's network.
   */
  AI_LOCAL_DIRECT: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
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
  if (config.STORAGE_MODE === 's3' && !config.S3_BUCKET)
    throw new Error('S3_BUCKET is required when STORAGE_MODE=s3');
  if (config.MAIL_MODE === 'smtp' && !config.MAIL_URL)
    throw new Error('MAIL_URL is required when MAIL_MODE=smtp');
  if (config.NODE_ENV === 'production' && !config.MASTER_KEY) {
    throw new Error('MASTER_KEY (or the AWS KMS adapter) is required in production');
  }
  return config;
}

export const CONFIG = Symbol('CONFIG');
