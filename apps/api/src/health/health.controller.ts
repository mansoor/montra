import { Controller, Get, Inject } from '@nestjs/common';
import { sql } from 'kysely';
import { Db } from '../db/database.js';

@Controller()
export class HealthController {
  constructor(@Inject(Db) private readonly db: Db) {}

  @Get('healthz')
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('readyz')
  async ready(): Promise<{ status: 'ok'; database: 'ok' }> {
    await sql`select 1`.execute(this.db.kysely);
    return { status: 'ok', database: 'ok' };
  }
}
