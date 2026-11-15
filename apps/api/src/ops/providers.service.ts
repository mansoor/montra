/**
 * The console's Providers page (ADR-0049 §5): for each outside provider, whether it's set up, its mode, what isn't
 * secret about it, and when it last worked and last failed. Keys never come here, and nothing here can change one:
 * they're in the environment (or a `_FILE`, ADR-0050), and Kratos reads its own at start.
 */
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import type {
  ProviderKeyDto,
  ProviderRowDto,
  ProvidersDto,
  SaveProviderSettingsRequest,
  TestSendDto,
} from '@montra/schemas';
import { PROVIDER_KEYS } from '@montra/schemas';
import { CONFIG, type AppConfig } from '../config.js';
import { MAIL_PORT, type MailPort } from '../mail/mail.service.js';
import { ServiceSettings } from './service-settings.js';
import { TextsService } from '../sms/texts.service.js';
import { AdminDb } from './staff.js';

type Detail = ProviderRowDto['details'][number];

/** Only the host of a URL: an SMTP URL or a Sentry DSN carries a password or key before it. */
function hostOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.port ? `${u.hostname}:${u.port}` : u.hostname;
  } catch {
    return null;
  }
}

const set = (v: unknown) => (v ? 'set' : 'missing');

@Injectable()
export class ProvidersService {
  constructor(
    @Inject(AdminDb) private readonly db: AdminDb,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(MAIL_PORT) private readonly mail: MailPort,
    @Inject(ServiceSettings) private readonly settings: ServiceSettings,
    @Inject(TextsService) private readonly texts: TextsService,
  ) {}

  async providers(staffId: string): Promise<ProvidersDto> {
    const status = await this.db.run(async (trx) => {
      const { rows } = await sql<{
        provider: ProviderKeyDto;
        last_ok_at: Date | null;
        last_failure_at: Date | null;
        last_failure: string | null;
      }>`select * from app.admin_provider_status(${staffId}::uuid)`.execute(trx);
      return new Map(rows.map((r) => [r.provider, r]));
    });
    const s = await this.settings.values();
    const c = this.config;
    const rows: Record<ProviderKeyDto, { configured: boolean; mode: string; details: (Detail | null)[] }> = {
      email: {
        configured: c.MAIL_MODE === 'smtp' && Boolean(c.MAIL_URL),
        mode: c.MAIL_MODE,
        details: [
          hostOf(c.MAIL_URL) ? { label: 'host', value: hostOf(c.MAIL_URL)! } : null,
          { label: 'sender', value: await this.settings.mailFrom() },
        ],
      },
      // ADR-0049 §6. Kratos texts its codes through its own courier channel, set where Kratos runs.
      sms: {
        configured:
          c.SMS_MODE === 'twilio' &&
          Boolean(c.TWILIO_ACCOUNT_SID && c.TWILIO_AUTH_TOKEN && c.TWILIO_MESSAGING_SERVICE_SID),
        mode: c.SMS_MODE,
        details: [
          // Twilio's account and Messaging Service ids name them; the auth token is the secret.
          c.TWILIO_ACCOUNT_SID ? { label: 'key_id', value: c.TWILIO_ACCOUNT_SID } : null,
          c.TWILIO_MESSAGING_SERVICE_SID ? { label: 'sender', value: c.TWILIO_MESSAGING_SERVICE_SID } : null,
          c.SMS_MODE === 'twilio' ? { label: 'key', value: set(c.TWILIO_AUTH_TOKEN) } : null,
          { label: 'kinds', value: s.smsKinds.join(', ') || '—' },
          { label: 'countries', value: s.smsCountries.join(', ') || '—' },
        ],
      },
      payments: {
        configured: c.BILLING_MODE === 'stripe' && Boolean(c.STRIPE_SECRET_KEY),
        mode: c.BILLING_MODE,
        details:
          c.BILLING_MODE === 'off'
            ? []
            : [
                {
                  label: 'key_mode',
                  value: c.STRIPE_SECRET_KEY?.startsWith('sk_live_')
                    ? 'live'
                    : c.STRIPE_SECRET_KEY?.startsWith('sk_test_')
                      ? 'test'
                      : set(c.STRIPE_SECRET_KEY),
                },
                { label: 'webhook', value: set(c.STRIPE_WEBHOOK_SECRET) },
              ],
      },
      errors: {
        configured: Boolean(c.SENTRY_DSN),
        mode: c.SENTRY_DSN ? 'sentry' : 'log',
        details: [
          hostOf(c.SENTRY_DSN) ? { label: 'host', value: hostOf(c.SENTRY_DSN)! } : null,
          { label: 'environment', value: c.NODE_ENV },
        ],
      },
      ai: {
        configured:
          c.AI_PROVIDER === 'fake' ||
          (c.AI_PROVIDER === 'anthropic' && Boolean(c.ANTHROPIC_API_KEY)) ||
          (c.AI_PROVIDER === 'openai_compatible' && Boolean(c.AI_BASE_URL)),
        mode: c.AI_PROVIDER,
        details: [
          c.AI_PROVIDER === 'anthropic' ? { label: 'key', value: set(c.ANTHROPIC_API_KEY) } : null,
          hostOf(c.AI_BASE_URL) ? { label: 'base_url', value: hostOf(c.AI_BASE_URL)! } : null,
          { label: 'failover', value: c.AI_FAILOVER_PROVIDER ?? '—' },
        ],
      },
      storage: {
        configured: c.STORAGE_MODE === 'local' || Boolean(c.S3_BUCKET),
        mode: c.STORAGE_MODE,
        details:
          c.STORAGE_MODE === 's3'
            ? [
                { label: 'bucket', value: c.S3_BUCKET ?? '—' },
                { label: 'region', value: c.S3_REGION },
                hostOf(c.S3_ENDPOINT) ? { label: 'endpoint', value: hostOf(c.S3_ENDPOINT)! } : null,
              ]
            : [],
      },
      keys: {
        configured:
          c.KMS_MODE === 'aws'
            ? Boolean(c.AWS_KMS_KEY_ID)
            : c.KMS_MODE === 'vault'
              ? Boolean(c.VAULT_ADDR && c.VAULT_TOKEN)
              : true,
        mode: c.KMS_MODE,
        // A KMS key's id or ARN, or Vault's key name, names the key; it isn't the key (ADR-0050 §3).
        details:
          c.KMS_MODE === 'aws'
            ? [{ label: 'key_id', value: c.AWS_KMS_KEY_ID ?? '—' }]
            : c.KMS_MODE === 'vault'
              ? [
                  hostOf(c.VAULT_ADDR) ? { label: 'endpoint', value: hostOf(c.VAULT_ADDR)! } : null,
                  { label: 'key_id', value: c.VAULT_TRANSIT_KEY },
                ]
              : [],
      },
      push: { configured: c.PUSH_MODE === 'expo', mode: c.PUSH_MODE, details: [] },
      exchange_rates: {
        configured: true,
        mode: 'ecb',
        details: [{ label: 'oxr', value: set(c.OXR_APP_ID) }],
      },
    };
    const iso = (d: Date | null | undefined) => d?.toISOString() ?? null;
    return {
      rows: PROVIDER_KEYS.map((key) => {
        const r = rows[key];
        const st = status.get(key);
        return {
          key,
          configured: r.configured,
          mode: r.mode,
          details: r.details.filter((d): d is Detail => d !== null),
          lastOkAt: iso(st?.last_ok_at),
          lastFailureAt: iso(st?.last_failure_at),
          lastFailure: st?.last_failure ?? null,
        };
      }),
      settings: s,
    };
  }

  async saveSettings(staffId: string, req: SaveProviderSettingsRequest): Promise<void> {
    const out: Record<string, string> = {};
    if (req.mailFromName !== undefined) out.mail_from_name = req.mailFromName;
    if (req.mailFromAddress !== undefined) out.mail_from_address = req.mailFromAddress;
    if (req.supportEmail !== undefined) out.support_email = req.supportEmail;
    if (req.smsKinds !== undefined) out.sms_kinds = [...new Set(req.smsKinds)].join(',');
    if (req.smsCountries !== undefined) {
      out.sms_countries = [...new Set(req.smsCountries.map((c) => c.toUpperCase()))].join(',');
    }
    await this.db.run((trx) =>
      sql`select app.admin_save_provider_settings(${staffId}::uuid, ${JSON.stringify(out)}::jsonb)`.execute(
        trx,
      ),
    );
    this.settings.forget();
  }

  /** To the owner's own address, which is the only one this sends to (ADR-0049 §5). */
  async testEmail(to: string): Promise<TestSendDto> {
    await this.mail.send({
      to,
      category: 'transactional',
      subject: 'Montra test email',
      text: [
        'This is a test from the Providers page in the Montra staff console.',
        `It was sent by the API with the sender ${await this.settings.mailFrom()}.`,
        'Sign-in codes come from Kratos’s own courier, set up separately.',
      ].join('\n\n'),
    });
    return { to };
  }

  /** To the owner's own verified number (ADR-0049 §5). */
  async testText(userId: string): Promise<TestSendDto> {
    return this.texts.test(userId);
  }
}
