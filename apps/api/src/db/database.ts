import { Inject, Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { Kysely, PostgresDialect } from 'kysely';
import { createPool, withContext, type Database, type DbContext, type Trx } from '@montra/db';
import { CONFIG, type AppConfig } from '../config.js';

/** Owns the connection pool and runs every unit of work inside an RLS-scoped transaction (design 02 §5). */
@Injectable()
export class Db implements OnApplicationShutdown {
  readonly kysely: Kysely<Database>;

  constructor(@Inject(CONFIG) config: AppConfig) {
    this.kysely = new Kysely<Database>({
      dialect: new PostgresDialect({ pool: createPool(config.DATABASE_URL) }),
    });
  }

  run<T>(ctx: DbContext, fn: (trx: Trx) => Promise<T>): Promise<T> {
    return withContext(this.kysely, ctx, fn);
  }

  async onApplicationShutdown(): Promise<void> {
    await this.kysely.destroy();
  }
}
