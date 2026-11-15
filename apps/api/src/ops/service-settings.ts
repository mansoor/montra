/**
 * Provider settings that aren't secret, which owners change in the console (ADR-0049 §5): the API's sender and the
 * support address, which kinds of text are on, and the countries texts may go to. Kept in `app.system_setting`; an
 * empty value falls back to the environment. Read often, so held for half a minute.
 */
import { Inject, Injectable } from '@nestjs/common';
import { CONFIG, type AppConfig } from '../config.js';
import { Db } from '../db/database.js';

export const SMS_KINDS = ['codes', 'security', 'reminders'] as const;
export type SmsKind = (typeof SMS_KINDS)[number];

const KEYS = ['mail_from_name', 'mail_from_address', 'support_email', 'sms_kinds', 'sms_countries'] as const;
type Key = (typeof KEYS)[number];
const TTL_MS = 30_000;
/** Until an owner says otherwise, texts go only to US numbers (ADR-0049 §6: against SMS pumping). */
export const DEFAULT_SMS_COUNTRIES = ['US'] as const;

export interface ServiceSettingsValues {
  mailFromName: string;
  mailFromAddress: string;
  supportEmail: string;
  smsKinds: SmsKind[];
  smsCountries: string[];
}

/** `Name <address>` from MAIL_FROM, or just the address. */
export function splitFrom(from: string): { name: string; address: string } {
  const m = /^\s*(.*?)\s*<([^>]+)>\s*$/.exec(from);
  return m ? { name: m[1]!.replace(/^"|"$/g, ''), address: m[2]! } : { name: '', address: from.trim() };
}

@Injectable()
export class ServiceSettings {
  private cache: { at: number; values: Partial<Record<Key, string>> } | null = null;

  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  /** After the console saves, so the next email already uses it. */
  forget(): void {
    this.cache = null;
  }

  private async raw(): Promise<Partial<Record<Key, string>>> {
    if (this.cache && Date.now() - this.cache.at < TTL_MS) return this.cache.values;
    const rows = await this.db.run({}, (trx) =>
      trx
        .selectFrom('app.system_setting')
        .select(['key', 'value'])
        .where('key', 'in', [...KEYS])
        .execute(),
    );
    // An empty sender or support address means the environment's; an empty list of texts or countries means none.
    const values = Object.fromEntries(
      rows.filter((r) => r.value !== '' || r.key.startsWith('sms_')).map((r) => [r.key, r.value]),
    );
    this.cache = { at: Date.now(), values };
    return values;
  }

  /** What's saved, with the environment's values where nothing is. */
  async values(): Promise<ServiceSettingsValues> {
    const v = await this.raw();
    const env = splitFrom(this.config.MAIL_FROM);
    const list = (s: string | undefined) =>
      s
        ? s
            .split(',')
            .map((x) => x.trim())
            .filter(Boolean)
        : [];
    return {
      mailFromName: v.mail_from_name ?? env.name,
      mailFromAddress: v.mail_from_address ?? env.address,
      supportEmail: v.support_email ?? this.config.SUPPORT_EMAIL ?? '',
      smsKinds:
        v.sms_kinds === undefined
          ? [...SMS_KINDS]
          : list(v.sms_kinds).filter((k): k is SmsKind => (SMS_KINDS as readonly string[]).includes(k)),
      smsCountries:
        v.sms_countries === undefined
          ? [...DEFAULT_SMS_COUNTRIES]
          : list(v.sms_countries).map((c) => c.toUpperCase()),
    };
  }

  /** The From header for the API's own email. */
  async mailFrom(): Promise<string> {
    const v = await this.values();
    return v.mailFromName ? `${v.mailFromName} <${v.mailFromAddress}>` : v.mailFromAddress;
  }

  async supportEmail(): Promise<string | null> {
    return (await this.values()).supportEmail || null;
  }
}
