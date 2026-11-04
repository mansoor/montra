/** Staff get their own connection, with their own database role (ADR-0020 §6). */
import {
  Inject,
  Injectable,
  type CanActivate,
  type ExecutionContext,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { Kysely, PostgresDialect, sql } from 'kysely';
import type { FastifyRequest } from 'fastify';
import { createPool, setContext, type Database, type Trx } from '@montra/db';
import type { StaffRole } from '@montra/schemas';
import type { RequestContext } from '../auth/auth.js';
import { AppError, forbidden } from '../common/errors.js';
import { CONFIG, type AppConfig } from '../config.js';
import { Db } from '../db/database.js';

/** Locally and in CI each role has the app's host and a password equal to its name. Production sets the URL. */
export function roleUrl(databaseUrl: string, role: string): string {
  const url = new URL(databaseUrl);
  url.username = role;
  url.password = role;
  return url.toString();
}

/** The console's connection: `montra_admin`, which has no grant on any financial table. */
@Injectable()
export class AdminDb implements OnApplicationShutdown {
  readonly kysely: Kysely<Database>;

  constructor(@Inject(CONFIG) config: AppConfig) {
    this.kysely = new Kysely<Database>({
      dialect: new PostgresDialect({
        pool: createPool(config.ADMIN_DATABASE_URL ?? roleUrl(config.DATABASE_URL, 'montra_admin'), {
          max: 3,
        }),
      }),
    });
  }

  run<T>(fn: (trx: Trx) => Promise<T>): Promise<T> {
    return this.kysely.transaction().execute(fn);
  }

  async onApplicationShutdown(): Promise<void> {
    await this.kysely.destroy();
  }
}

/** A support session's connection: `montra_support`, always read-only, seeing the workspace as whoever granted it. */
@Injectable()
export class SupportDb implements OnApplicationShutdown {
  readonly kysely: Kysely<Database>;

  constructor(@Inject(CONFIG) config: AppConfig) {
    this.kysely = new Kysely<Database>({
      dialect: new PostgresDialect({
        pool: createPool(config.SUPPORT_DATABASE_URL ?? roleUrl(config.DATABASE_URL, 'montra_support'), {
          max: 3,
        }),
      }),
    });
  }

  run<T>(workspaceId: string, grantedBy: string, fn: (trx: Trx) => Promise<T>): Promise<T> {
    return this.kysely
      .transaction()
      .setAccessMode('read only')
      .execute(async (trx) => {
        await setContext(trx, { workspaceId, userId: grantedBy, actorType: 'support' });
        return fn(trx);
      });
  }

  async onApplicationShutdown(): Promise<void> {
    await this.kysely.destroy();
  }
}

export type StaffRequest = FastifyRequest & { montra?: RequestContext; staffRole?: StaffRole };

/** Runs after AuthGuard. Someone who isn't staff sees what they'd see for a page that doesn't exist. */
@Injectable()
export class StaffGuard implements CanActivate {
  constructor(@Inject(Db) private readonly db: Db) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<StaffRequest>();
    const ctx = req.montra;
    if (!ctx) throw new AppError(404, 'not_found', 'Not found');
    const { rows } = await this.db.run({ userId: ctx.user.id }, (trx) =>
      sql<{ role: StaffRole | null }>`select app.staff_role(${ctx.user.id}::uuid) as role`.execute(trx),
    );
    const role = rows[0]?.role;
    if (!role) throw new AppError(404, 'not_found', 'Not found');
    if (ctx.user.aal !== 'aal2') {
      throw new AppError(403, 'mfa.required', 'Sign in with your second factor to open the console');
    }
    req.staffRole = role;
    return true;
  }
}

export function requireAdmin(req: StaffRequest): void {
  if (req.staffRole !== 'admin') throw forbidden('This needs the admin role');
}
