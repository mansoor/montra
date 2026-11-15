/**
 * The last success and failure of each outside provider, for the console's Providers page (ADR-0049 §5). Recorded as
 * calls happen, at most every few minutes for a success, so the page says whether email, payments or AI work without
 * anyone having to try them. Only a short, scrubbed message is kept: never a key, an address or a body.
 */
import { Inject, Injectable, Logger, type Provider, type Type } from '@nestjs/common';
import { sql } from 'kysely';
import type { ProviderKeyDto } from '@montra/schemas';
import { Db } from '../db/database.js';

export type ProviderKey = ProviderKeyDto;

const OK_EVERY_MS = 5 * 60_000;
const FAILURE_EVERY_MS = 30_000;

/** Enough to tell what kind of failure it was. Anything that looks like an address, a token or a URL is cut. */
export function scrubDetail(message: string): string {
  return message
    .replace(/[^\s@]+@[^\s@]+/g, '…')
    .replace(/https?:\/\/\S+/g, '…')
    .replace(/\b[A-Za-z0-9_-]{24,}\b/g, '…')
    .slice(0, 200);
}

@Injectable()
export class ProviderHealth {
  private readonly logger = new Logger('ProviderHealth');
  private readonly lastOk = new Map<ProviderKey, number>();
  private readonly lastFailure = new Map<ProviderKey, number>();

  constructor(@Inject(Db) private readonly db: Db) {}

  ok(key: ProviderKey): void {
    const now = Date.now();
    if (now - (this.lastOk.get(key) ?? 0) < OK_EVERY_MS) return;
    this.lastOk.set(key, now);
    void this.note(key, true, null);
  }

  failed(key: ProviderKey, error: unknown): void {
    const now = Date.now();
    if (now - (this.lastFailure.get(key) ?? 0) < FAILURE_EVERY_MS) return;
    this.lastFailure.set(key, now);
    // A success after this failure should show, however recent the last one was.
    this.lastOk.delete(key);
    const message = error instanceof Error ? error.message : String(error);
    void this.note(key, false, scrubDetail(message));
  }

  private async note(key: ProviderKey, ok: boolean, detail: string | null): Promise<void> {
    try {
      await this.db.run({ actorType: 'system' }, (trx) =>
        sql`select app.note_provider(${key}, ${ok}, ${detail})`.execute(trx),
      );
    } catch (e) {
      this.logger.warn(`Couldn't note ${key}: ${(e as Error).message}`);
    }
  }
}

const LIFECYCLE = new Set([
  'onModuleInit',
  'onApplicationBootstrap',
  'onModuleDestroy',
  'beforeApplicationShutdown',
  'onApplicationShutdown',
]);

/** Wraps a port so each call's outcome is noted. Values that aren't methods pass through, so tests still see them. */
export function track<T extends object>(inner: T, key: ProviderKey, health: ProviderHealth): T {
  return new Proxy(inner, {
    get(target, prop, receiver) {
      // Nest calls these on the real instance already; the tracked one mustn't run them twice.
      if (typeof prop === 'string' && LIFECYCLE.has(prop)) return undefined;
      const value = Reflect.get(target, prop, receiver) as unknown;
      if (typeof value !== 'function' || prop === 'constructor') return value;
      return (...args: unknown[]) => {
        let result: unknown;
        try {
          result = (value as (...a: unknown[]) => unknown).apply(target, args);
        } catch (e) {
          health.failed(key, e);
          throw e;
        }
        if (result instanceof Promise) {
          return result.then(
            (v) => {
              health.ok(key);
              return v;
            },
            (e: unknown) => {
              health.failed(key, e);
              throw e;
            },
          );
        }
        return result;
      };
    },
  });
}

/**
 * Registers a port's real provider under a private token, and the port itself as that provider, tracked. `off`
 * leaves it untracked, for a port that only refuses, such as billing with plans switched off.
 */
export function trackedProvider(
  token: symbol,
  key: ProviderKey,
  base: { useClass: Type } | { useFactory: (...args: never[]) => unknown; inject?: unknown[] } | Provider,
  off = false,
): Provider[] {
  const shape = base as object;
  if (off) return [{ ...shape, provide: token } as Provider];
  const inner = Symbol(`${String(token.description)}:untracked`);
  return [
    { ...shape, provide: inner } as Provider,
    {
      provide: token,
      inject: [inner, ProviderHealth],
      useFactory: (port: object, health: ProviderHealth) => track(port, key, health),
    },
  ];
}
