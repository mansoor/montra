import { Inject, Injectable, Logger } from '@nestjs/common';
import { CONFIG, type AppConfig } from '../config.js';

export interface PushMessage {
  token: string;
  title: string;
  /** Where tapping it leads, inside the app. */
  link: string | null;
}

/** Outgoing push (NOT-01). Returns the tokens the provider says are dead, so they can be forgotten. */
export interface PushPort {
  send(messages: readonly PushMessage[]): Promise<{ deadTokens: string[] }>;
}
export const PUSH_PORT = Symbol('PUSH_PORT');

/** Development: write it to the log. */
@Injectable()
export class LogPush implements PushPort {
  private readonly logger = new Logger('Push');
  async send(messages: readonly PushMessage[]): Promise<{ deadTokens: string[] }> {
    for (const m of messages) this.logger.log(`to=${m.token.slice(0, 12)}… "${m.title}"`);
    return { deadTokens: [] };
  }
}

/** Tests: keep messages in memory. */
@Injectable()
export class MemoryPush implements PushPort {
  readonly outbox: PushMessage[] = [];
  readonly dead = new Set<string>();
  async send(messages: readonly PushMessage[]): Promise<{ deadTokens: string[] }> {
    this.outbox.push(...messages);
    return { deadTokens: messages.filter((m) => this.dead.has(m.token)).map((m) => m.token) };
  }
}

/** Expo's push service, which holds the APNs and FCM credentials. Title only: no figures on a lock screen (ADR-0019 §5). */
@Injectable()
export class ExpoPush implements PushPort {
  constructor(@Inject(CONFIG) private readonly config: AppConfig) {}

  async send(messages: readonly PushMessage[]): Promise<{ deadTokens: string[] }> {
    if (messages.length === 0) return { deadTokens: [] };
    const res = await fetch(this.config.PUSH_EXPO_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(
        messages.map((m) => ({
          to: m.token,
          title: m.title,
          sound: 'default',
          data: m.link ? { link: m.link } : {},
        })),
      ),
    });
    if (!res.ok) throw new Error(`Expo push returned ${res.status}`);
    const body = (await res.json()) as { data?: { status: string; details?: { error?: string } }[] };
    const deadTokens = (body.data ?? []).flatMap((r, i) =>
      r.status === 'error' && r.details?.error === 'DeviceNotRegistered' ? [messages[i]!.token] : [],
    );
    return { deadTokens };
  }
}

export const pushProvider = {
  provide: PUSH_PORT,
  inject: [CONFIG],
  useFactory: (config: AppConfig): PushPort => {
    if (config.PUSH_MODE === 'expo') return new ExpoPush(config);
    if (config.PUSH_MODE === 'memory') return new MemoryPush();
    return new LogPush();
  },
};
