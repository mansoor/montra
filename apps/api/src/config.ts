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
  /** Push notifications (NOT-01). `expo` sends through Expo's service; `log` writes to the log. */
  PUSH_MODE: z.enum(['log', 'memory', 'expo']).default('log'),
  PUSH_EXPO_URL: z.string().url().default('https://exp.host/--/api/v2/push/send'),
  /** This API's public origin, for links that must reach it directly, such as one-click unsubscribe. */
  API_URL: z.string().url().default('http://localhost:4000'),
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
  /** A backup being restored (BAK-06). */
  MAX_RESTORE_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(1024 * 1024 * 1024),
  MAX_UPLOAD_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(25 * 1024 * 1024),
  /** ADR-0020: staff and support connect with their own roles. Locally these come from DATABASE_URL's host. */
  ADMIN_DATABASE_URL: z.string().optional(),
  SUPPORT_DATABASE_URL: z.string().optional(),
  /** How many proxies sit in front of the API (Cloudflare and the load balancer in production), to find the client's address. */
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),
  /** Plans (OPS-08). `off` turns gating off, as for a self-hosted install, development and tests. */
  BILLING_MODE: z.enum(['off', 'stripe']).default('off'),
  STRIPE_API_URL: z.string().url().default('https://api.stripe.com'),
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  STRIPE_PRICE_PRO_MONTHLY: z.string().optional(),
  STRIPE_PRICE_PRO_YEARLY: z.string().optional(),
  /** Error tracking (NFR-13). Without it, errors only go to the log. */
  SENTRY_DSN: z.string().url().optional(),
  /** Bearer token for /internal/metrics. Without it, the route doesn't answer. */
  METRICS_TOKEN: z.string().min(16).optional(),
  /** Where a new question or bug report is announced (OPS-09). */
  SUPPORT_EMAIL: z.string().email().optional(),
  /** Key wrapping (NFR-01): 'local' for development and tests, 'aws' for AWS KMS. */
  KMS_MODE: z.enum(['local', 'aws']).default('local'),
  AWS_KMS_KEY_ID: z.string().optional(),
  /** FX rates (CUR-05, ADR-0014): ECB euro reference rates, no key needed. */
  FX_ECB_URL: z.string().url().default('https://www.ecb.europa.eu/stats/eurofxref'),
  /** Optional second source covering more currencies (Open Exchange Rates app id). */
  OXR_APP_ID: z.string().min(1).optional(),
  OXR_URL: z.string().url().default('https://openexchangerates.org/api'),
  /** The worker refreshes rates daily (and once at start-up). Off for hermetic runs such as e2e. */
  FX_DAILY: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
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
  // ECS needs a value in every secret, so one that isn't in use arrives empty, which means not set.
  const config = Env.parse(Object.fromEntries(Object.entries(env).filter(([, v]) => v !== '')));
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
  if (config.NODE_ENV === 'production' && config.KMS_MODE === 'local' && !config.MASTER_KEY) {
    throw new Error('MASTER_KEY (or KMS_MODE=aws) is required in production');
  }
  if (config.KMS_MODE === 'aws' && !config.AWS_KMS_KEY_ID) {
    throw new Error('AWS_KMS_KEY_ID is required when KMS_MODE=aws');
  }
  if (config.NODE_ENV === 'production' && !(config.ADMIN_DATABASE_URL && config.SUPPORT_DATABASE_URL)) {
    throw new Error('ADMIN_DATABASE_URL and SUPPORT_DATABASE_URL are required in production');
  }
  if (config.BILLING_MODE === 'stripe' && !(config.STRIPE_SECRET_KEY && config.STRIPE_WEBHOOK_SECRET)) {
    throw new Error('STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET are required when BILLING_MODE=stripe');
  }
  return config;
}

export const CONFIG = Symbol('CONFIG');
