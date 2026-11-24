/**
 * A business's tax account numbers, sealed at rest (BIZ-26, migration 0089): the EIN, the EDD employer account, the FTB
 * entity ID and the CDTFA seller's permit. Each is kept in `<column>_enc` (FieldCrypto, bound to the workspace and the
 * column) with its last four in `<column>_last4` for the masked display.
 *
 * Until the `business.seal_tax_ids` job has run, a row may still hold a number in its old plain column. A plain value is
 * newer than a sealed one (the API clears the plain column whenever it seals; only an older API task writes it), so it
 * wins until the job seals it.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'kysely';
import type { BusinessProfileRow, Trx } from '@montra/db';
import { maskLast4 } from '@montra/domain';
import type { BusinessRevealField } from '@montra/schemas';
import { CONFIG, type AppConfig } from '../config.js';
import { FieldCrypto } from '../crypto/crypto.service.js';
import { sealNumber } from '../crypto/sealed-numbers.js';
import { Db } from '../db/database.js';
import { Worker } from '../jobs/queue.js';

export const TAX_ID_COLUMNS = ['ein', 'ftb_entity_id', 'ca_employer_account', 'cdtfa_permit'] as const;
export type TaxIdColumn = (typeof TAX_ID_COLUMNS)[number];

/** The reveal field (the DTO's name) to the column. */
export const TAX_ID_COLUMN: Readonly<Record<BusinessRevealField, TaxIdColumn>> = {
  ein: 'ein',
  ftbEntityId: 'ftb_entity_id',
  caEmployerAccount: 'ca_employer_account',
  cdtfaPermit: 'cdtfa_permit',
};

/** FieldCrypto's associated data for a column, as the backup catalog names it. */
export const taxIdLabel = (column: TaxIdColumn) => `business_profile.${column}`;

type TaxIdRow = Pick<BusinessProfileRow, TaxIdColumn | `${TaxIdColumn}_enc` | `${TaxIdColumn}_last4`>;

/** What to write for a number (or null to clear it): sealed, its last four, and the plain column cleared. */
export async function sealTaxId(
  crypto: FieldCrypto,
  trx: Trx,
  workspaceId: string,
  column: TaxIdColumn,
  value: string | null,
): Promise<Partial<Record<keyof TaxIdRow, string | Buffer | null>>> {
  const sealed = await sealNumber(crypto, trx, workspaceId, taxIdLabel(column), value);
  return { [column]: null, [`${column}_enc`]: sealed.enc, [`${column}_last4`]: sealed.last4 };
}

/** The full number, for the Show path and the filing outputs only. Never log or return it elsewhere. */
export async function openTaxId(
  crypto: FieldCrypto,
  trx: Trx,
  workspaceId: string,
  row: Partial<TaxIdRow> | undefined,
  column: TaxIdColumn,
): Promise<string | null> {
  if (!row) return null;
  const plain = row[column];
  if (plain) return plain;
  return crypto.decrypt(trx, workspaceId, taxIdLabel(column), row[`${column}_enc`] ?? null);
}

/** The last four, from the sealed copy's or a plain value the job hasn't sealed yet. */
export function taxIdLast4(row: Partial<TaxIdRow> | undefined, column: TaxIdColumn): string | null {
  if (!row) return null;
  const plain = row[column];
  if (plain) return plain.slice(-4);
  return row[`${column}_last4`] ?? null;
}

export const maskTaxId = (row: Partial<TaxIdRow> | undefined, column: TaxIdColumn): string | null =>
  maskLast4(taxIdLast4(row, column), column === 'ein' ? 'ein' : 'other');

export interface SealResult {
  sealed: number;
  /** Businesses whose workspace has no active owner or admin to act as: left plain, counted. */
  skipped: number;
  /** True when the run stopped at its time budget with more to do; the next run is queued. */
  more: boolean;
}

const RUN_BUDGET_MS = 2 * 60_000;

/**
 * The backfill (migration 0089): seals the plain numbers left in `business_profile` and clears them, a business at a
 * time, each in its own transaction as the workspace's owner. Idempotent and resumable: it only ever looks at rows that
 * still have a plain number, so a run that stops part-way leaves each business either sealed or as it was, and the
 * next run carries on. Queued at every worker start; a run that runs out of time queues the next.
 */
@Injectable()
export class TaxIdSealing {
  private readonly logger = new Logger('TaxIdSealing');

  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(FieldCrypto) private readonly crypto: FieldCrypto,
    @Inject(Worker) private readonly worker: Worker,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  register(): void {
    this.worker.register('business.seal_tax_ids', async () => {
      const r = await this.run();
      if (r.more) await this.schedule(new Date(Date.now() + 1_000));
      return { ...r };
    });
  }

  async schedule(at: Date = new Date()): Promise<void> {
    await this.db.run({}, (trx) =>
      sql`select app.schedule_system_job('schedule', 'business.seal_tax_ids', ${at})`.execute(trx),
    );
  }

  async run(budgetMs = RUN_BUDGET_MS): Promise<SealResult> {
    const deadline = Date.now() + budgetMs;
    const batch = this.config.TAX_ID_SEAL_BATCH;
    let sealed = 0;
    let skipped = 0;
    // A business tried once in this run isn't tried again: one that can't be sealed can't keep the run going.
    const tried = new Set<string>();
    for (;;) {
      const { rows } = await this.db.run({}, (trx) =>
        sql<{ workspace_id: string; entity_id: string; user_id: string | null }>`
          select * from app.tax_ids_to_seal(${batch})`.execute(trx),
      );
      skipped = rows.filter((r) => !r.user_id).length;
      const todo = rows.filter((r) => r.user_id && !tried.has(`${r.workspace_id}:${r.entity_id}`));
      if (!todo.length) break;
      for (const r of todo) {
        if (Date.now() > deadline) return this.done(sealed, skipped, true);
        tried.add(`${r.workspace_id}:${r.entity_id}`);
        const ctx = { workspaceId: r.workspace_id, userId: r.user_id! };
        if (await this.db.run(ctx, (trx) => this.sealRow(trx, ctx.workspaceId, r.entity_id))) sealed++;
      }
      if (rows.length < batch) break;
    }
    return this.done(sealed, skipped, false);
  }

  private done(sealed: number, skipped: number, more: boolean): SealResult {
    if (sealed || skipped) {
      // Counts only: never a number, a name or an id.
      this.logger.log(
        `Sealed tax account numbers for ${sealed} businesses; ${skipped} left with no owner to act as`,
      );
    }
    return { sealed, skipped, more };
  }

  /** Seals one business's plain numbers. False when there was nothing left to seal (another run got there first). */
  async sealRow(trx: Trx, workspaceId: string, entityId: string): Promise<boolean> {
    const row = await trx
      .selectFrom('app.business_profile')
      .select([...TAX_ID_COLUMNS])
      .where('workspace_id', '=', workspaceId)
      .where('entity_id', '=', entityId)
      .forUpdate()
      .executeTakeFirst();
    if (!row) return false;
    let set = {};
    for (const column of TAX_ID_COLUMNS) {
      const plain = row[column];
      if (plain) set = { ...set, ...(await sealTaxId(this.crypto, trx, workspaceId, column, plain)) };
    }
    if (!Object.keys(set).length) return false;
    await trx
      .updateTable('app.business_profile')
      .set(set)
      .where('workspace_id', '=', workspaceId)
      .where('entity_id', '=', entityId)
      .execute();
    return true;
  }
}
