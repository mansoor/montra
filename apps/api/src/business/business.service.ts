/**
 * Business profiles, customers and vendors (BIZ-01, BIZ-04, ADR-0017 §6). Payees with activity are listed from their
 * postings without a row, so the directory is always current; a row appears when someone adds details or invoices one.
 */
import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { newId, type BusinessPartyRow, type BusinessProfileRow, type Trx } from '@montra/db';
import type {
  BusinessProfileDto,
  CreatePartyRequest,
  PartyDto,
  PartyKind,
  UpdateBusinessProfileRequest,
  UpdatePartyRequest,
} from '@montra/schemas';
import { AppError, notFound, unprocessable } from '../common/errors.js';
import { payeeKeyOf } from '../categorization/categorizer.service.js';
import { Db } from '../db/database.js';
import { detectReceiptMedia } from '../receipts/receipts.service.js';
import { STORAGE_PORT, storageKey, type StoragePort } from '../storage/storage.js';
import {
  businessEntities,
  businessEntity,
  dateOf,
  TAX_COUNTRY,
  todayOf,
  type BusinessEntity,
  type Ctx,
} from './shared.js';

/** Business paperwork is kept as long as receipts: long enough for a tax question. */
export const RETENTION_YEARS = 7;

@Injectable()
export class BusinessService {
  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(STORAGE_PORT) private readonly storage: StoragePort,
  ) {}

  // ----- Profile -------------------------------------------------------------------------------------------

  async listBusinesses(ctx: Ctx): Promise<BusinessProfileDto[]> {
    return this.db.run(ctx, async (trx) => {
      const out: BusinessProfileDto[] = [];
      for (const e of await businessEntities(trx, ctx))
        out.push(this.profileDto(e, await this.readProfile(trx, ctx, e.id)));
      return out;
    });
  }

  async profile(ctx: Ctx, entityId: string): Promise<BusinessProfileDto> {
    return this.db.run(ctx, async (trx) => {
      const e = await businessEntity(trx, ctx, entityId);
      return this.profileDto(e, await this.readProfile(trx, ctx, entityId));
    });
  }

  async updateProfile(
    ctx: Ctx,
    entityId: string,
    req: UpdateBusinessProfileRequest,
  ): Promise<BusinessProfileDto> {
    return this.db.run(ctx, async (trx) => {
      const e = await businessEntity(trx, ctx, entityId);
      await this.ensureProfile(trx, ctx, entityId);
      for (const account of [req.defaultDepositAccountId, req.taxSavingsAccountId]) {
        if (account) await this.requireBankAccount(trx, ctx, account);
      }
      const row = await trx
        .updateTable('app.business_profile')
        .set({
          ...(req.legalName !== undefined ? { legal_name: req.legalName } : {}),
          ...(req.address !== undefined ? { address: req.address } : {}),
          ...(req.email !== undefined ? { email: req.email } : {}),
          ...(req.invoicePrefix !== undefined ? { invoice_prefix: req.invoicePrefix } : {}),
          ...(req.defaultTermsDays !== undefined ? { default_terms_days: req.defaultTermsDays } : {}),
          ...(req.defaultDepositAccountId !== undefined
            ? { default_deposit_account_id: req.defaultDepositAccountId }
            : {}),
          ...(req.taxRateBps !== undefined ? { tax_rate_bps: req.taxRateBps } : {}),
          ...(req.taxSavingsAccountId !== undefined
            ? { tax_savings_account_id: req.taxSavingsAccountId }
            : {}),
          ...(req.receiptThreshold !== undefined ? { receipt_threshold_minor: req.receiptThreshold } : {}),
        })
        .where('workspace_id', '=', ctx.workspaceId)
        .where('entity_id', '=', entityId)
        .returningAll()
        .executeTakeFirstOrThrow();
      return this.profileDto(e, row);
    });
  }

  /** The stored profile, or the defaults: reading doesn't write, because a read-only accountant may be reading. */
  async readProfile(trx: Trx, ctx: Ctx, entityId: string): Promise<BusinessProfileRow> {
    const row = await trx
      .selectFrom('app.business_profile')
      .selectAll()
      .where('workspace_id', '=', ctx.workspaceId)
      .where('entity_id', '=', entityId)
      .executeTakeFirst();
    return (
      row ?? {
        workspace_id: ctx.workspaceId,
        entity_id: entityId,
        legal_name: null,
        address: null,
        email: null,
        invoice_prefix: 'INV-',
        next_invoice_number: 1,
        default_terms_days: 30,
        default_deposit_account_id: null,
        tax_rate_bps: null,
        tax_savings_account_id: null,
        receipt_threshold_minor: 7500n,
        version: 1n,
        created_at: new Date(0),
        updated_at: new Date(0),
      }
    );
  }

  async ensureProfile(trx: Trx, ctx: Ctx, entityId: string): Promise<void> {
    await trx
      .insertInto('app.business_profile')
      .values({ workspace_id: ctx.workspaceId, entity_id: entityId })
      .onConflict((oc) => oc.columns(['workspace_id', 'entity_id']).doNothing())
      .execute();
  }

  async requireBankAccount(trx: Trx, ctx: Ctx, accountId: string): Promise<void> {
    const a = await trx
      .selectFrom('app.bank_account')
      .select('ledger_account_id')
      .where('workspace_id', '=', ctx.workspaceId)
      .where('ledger_account_id', '=', accountId)
      .executeTakeFirst();
    if (!a) throw unprocessable('account.not_a_bank_account', 'Choose a bank or savings account');
  }

  private profileDto(e: BusinessEntity, r: BusinessProfileRow): BusinessProfileDto {
    return {
      entityId: e.id,
      name: e.name,
      businessType: e.businessType,
      fiscalYearStartMonth: e.fiscalYearStartMonth,
      currency: e.currency as BusinessProfileDto['currency'],
      legalName: r.legal_name,
      address: r.address,
      email: r.email,
      invoicePrefix: r.invoice_prefix,
      defaultTermsDays: r.default_terms_days,
      defaultDepositAccountId: r.default_deposit_account_id,
      taxRateBps: r.tax_rate_bps,
      taxSavingsAccountId: r.tax_savings_account_id,
      receiptThreshold: String(r.receipt_threshold_minor),
      version: Number(r.version),
    };
  }

  // ----- Customers and vendors -----------------------------------------------------------------------------

  async listParties(ctx: Ctx, entityId: string, kind?: PartyKind): Promise<PartyDto[]> {
    return this.db.run(ctx, async (trx) => {
      const e = await businessEntity(trx, ctx, entityId);
      const year = todayOf(e).slice(0, 4);
      const stored = await trx
        .selectFrom('app.business_party')
        .selectAll()
        .where('workspace_id', '=', ctx.workspaceId)
        .where('entity_id', '=', entityId)
        .execute();
      const { rows: activity } = await sql<{
        key: string | null;
        linked_party: string | null;
        name: string | null;
        received: string;
        paid: string;
        last: string;
      }>`
        select t.payee_key as key, coalesce(i.party_id, b.party_id) as linked_party,
               max(coalesce(t.payee_raw, t.payee_key)) as name,
               coalesce(sum(-p.functional_amount_minor) filter (where a.type = 'income'), 0)::text as received,
               coalesce(sum(p.functional_amount_minor) filter (where a.type = 'expense'), 0)::text as paid,
               max(p.entry_date)::text as last
          from app.posting p
          join app.ledger_account a on a.workspace_id = p.workspace_id and a.id = p.ledger_account_id
          join app.journal_entry je on je.workspace_id = p.workspace_id and je.id = p.journal_entry_id
          join app.transaction t on t.workspace_id = je.workspace_id and t.id = je.transaction_id
          left join app.invoice_payment ip on ip.workspace_id = t.workspace_id and ip.transaction_id = t.id
          left join app.invoice i on i.workspace_id = ip.workspace_id and i.id = ip.invoice_id
          left join app.bill b on b.workspace_id = t.workspace_id and b.transaction_id = t.id
         where p.workspace_id = ${ctx.workspaceId} and p.entity_id = ${entityId}
           and a.type in ('income', 'expense') and a.is_category
           and p.entry_date between ${`${year}-01-01`} and ${`${year}-12-31`}
         group by t.payee_key, coalesce(i.party_id, b.party_id)`.execute(trx);

      // Whose money it is: a linked payment says outright. Otherwise a statement name seen on one, or the party's own.
      const aliases = await this.partyAliases(trx, ctx, entityId);
      const byKey = new Map(stored.filter((p) => p.payee_key).map((p) => [`${p.kind}:${p.payee_key}`, p.id]));
      const forParty = new Map<string, { total: bigint; last: string | null }>();
      const found = new Map<string, { total: bigint; last: string | null; name: string }>();
      const count = (kind: PartyKind, amount: bigint, a: (typeof activity)[number]) => {
        if (amount <= 0n) return;
        const id = a.key ? `${kind}:${a.key}` : null;
        const party = a.linked_party ?? (id ? (aliases.get(id)?.partyId ?? byKey.get(id)) : undefined);
        if (party) {
          const cur = forParty.get(party) ?? { total: 0n, last: null };
          cur.total += amount;
          if (!cur.last || a.last > cur.last) cur.last = a.last;
          forParty.set(party, cur);
        } else if (id) {
          found.set(id, { total: amount, last: a.last, name: a.name ?? '' });
        }
      };
      for (const a of activity) {
        count('customer', BigInt(a.received), a);
        count('vendor', BigInt(a.paid), a);
      }
      const out: PartyDto[] = stored.map((p) => {
        const t = forParty.get(p.id);
        return this.partyDto(p, t?.total ?? 0n, t?.last ?? null);
      });
      for (const [k, t] of found) {
        const [partyKind, ...rest] = k.split(':');
        out.push({
          id: null,
          entityId,
          kind: partyKind as PartyKind,
          name: t.name,
          payeeKey: rest.join(':'),
          email: null,
          phone: null,
          address: null,
          termsDays: null,
          notes: null,
          archived: false,
          yearTotal: String(t.total),
          lastActivity: t.last ? dateOf(t.last) : null,
          version: null,
        });
      }
      return out
        .filter((p) => !kind || p.kind === kind)
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    });
  }

  /**
   * Payee names seen on payments linked to a party. A statement rarely spells a customer the way an invoice does, so
   * linking a payment is the user saying these are the same one; later payments under that name count as theirs too.
   */
  async partyAliases(
    trx: Trx,
    ctx: Ctx,
    entityId: string,
  ): Promise<Map<string, { partyId: string; name: string }>> {
    const { rows } = await sql<{ kind: string; key: string; party_id: string; name: string }>`
      select 'customer' as kind, t.payee_key as key, py.id as party_id, py.name
        from app.invoice_payment ip
        join app.invoice i on i.workspace_id = ip.workspace_id and i.id = ip.invoice_id
        join app.business_party py on py.workspace_id = i.workspace_id and py.id = i.party_id
        join app.transaction t on t.workspace_id = ip.workspace_id and t.id = ip.transaction_id
       where ip.workspace_id = ${ctx.workspaceId} and ip.entity_id = ${entityId} and t.payee_key is not null
      union all
      select 'vendor', t.payee_key, py.id, py.name
        from app.bill b
        join app.business_party py on py.workspace_id = b.workspace_id and py.id = b.party_id
        join app.transaction t on t.workspace_id = b.workspace_id and t.id = b.transaction_id
       where b.workspace_id = ${ctx.workspaceId} and b.entity_id = ${entityId} and t.payee_key is not null`.execute(
      trx,
    );
    return new Map(rows.map((r) => [`${r.kind}:${r.key}`, { partyId: r.party_id, name: r.name }]));
  }

  /** Adding the same customer twice returns the first: found from transactions, then invoiced, it's still one. */
  async createParty(ctx: Ctx, req: CreatePartyRequest): Promise<PartyDto> {
    return this.db.run(ctx, async (trx) => {
      await businessEntity(trx, ctx, req.entityId);
      const key = req.payeeKey ?? payeeKeyOf(req.name) ?? null;
      const existing = key
        ? await trx
            .selectFrom('app.business_party')
            .selectAll()
            .where('workspace_id', '=', ctx.workspaceId)
            .where('entity_id', '=', req.entityId)
            .where('kind', '=', req.kind)
            .where('payee_key', '=', key)
            .executeTakeFirst()
        : undefined;
      if (existing) return this.partyDto(existing, 0n, null);
      const row = await trx
        .insertInto('app.business_party')
        .values({
          workspace_id: ctx.workspaceId,
          id: newId(),
          entity_id: req.entityId,
          kind: req.kind,
          name: req.name,
          payee_key: key,
          email: req.email ?? null,
          phone: req.phone ?? null,
          address: req.address ?? null,
          terms_days: req.termsDays ?? null,
          notes: req.notes ?? null,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      return this.partyDto(row, 0n, null);
    });
  }

  async updateParty(ctx: Ctx, id: string, req: UpdatePartyRequest): Promise<PartyDto> {
    return this.db.run(ctx, async (trx) => {
      const row = await trx
        .updateTable('app.business_party')
        .set({
          ...(req.name !== undefined ? { name: req.name } : {}),
          ...(req.payeeKey !== undefined ? { payee_key: req.payeeKey } : {}),
          ...(req.email !== undefined ? { email: req.email } : {}),
          ...(req.phone !== undefined ? { phone: req.phone } : {}),
          ...(req.address !== undefined ? { address: req.address } : {}),
          ...(req.termsDays !== undefined ? { terms_days: req.termsDays } : {}),
          ...(req.notes !== undefined ? { notes: req.notes } : {}),
          ...(req.archived !== undefined ? { archived_at: req.archived ? new Date() : null } : {}),
        })
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', id)
        .where('version', '=', BigInt(req.version))
        .returningAll()
        .executeTakeFirst();
      if (row) return this.partyDto(row, 0n, null);
      const exists = await this.partyRow(trx, ctx, id);
      throw exists
        ? new AppError(409, 'version.conflict', 'Someone else changed this')
        : notFound('Customer or vendor');
    });
  }

  async partyRow(trx: Trx, ctx: Ctx, id: string): Promise<BusinessPartyRow | undefined> {
    return trx
      .selectFrom('app.business_party')
      .selectAll()
      .where('workspace_id', '=', ctx.workspaceId)
      .where('id', '=', id)
      .executeTakeFirst();
  }

  private partyDto(p: BusinessPartyRow, total: bigint, last: string | null): PartyDto {
    return {
      id: p.id,
      entityId: p.entity_id,
      kind: p.kind,
      name: p.name,
      payeeKey: p.payee_key,
      email: p.email,
      phone: p.phone,
      address: p.address,
      termsDays: p.terms_days,
      notes: p.notes,
      archived: p.archived_at !== null,
      yearTotal: String(total),
      lastActivity: last ? dateOf(last) : null,
      version: Number(p.version),
    };
  }

  // ----- Tax lines (BIZ-02, AI-10) ---------------------------------------------------------------------------

  async setTaxLine(ctx: Ctx, categoryId: string, code: string | null): Promise<void> {
    await this.db.run(ctx, async (trx) => {
      if (code) {
        const line = await trx
          .selectFrom('ref.tax_line')
          .select('code')
          .where('country', '=', TAX_COUNTRY)
          .where('code', '=', code)
          .executeTakeFirst();
        if (!line) throw unprocessable('tax_line.unknown', 'That is not a tax line');
      }
      const res = await trx
        .updateTable('app.ledger_account')
        .set({ tax_line_code: code })
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', categoryId)
        .where('is_category', '=', true)
        .executeTakeFirst();
      if (!res.numUpdatedRows) throw notFound('Category');
    });
  }

  // ----- Files (bill photos; BIZ-12) ---------------------------------------------------------------------

  async uploadFile(ctx: Ctx, bytes: Uint8Array, fileName: string) {
    const mediaType = detectReceiptMedia(bytes);
    if (!mediaType)
      throw new AppError(415, 'upload.unsupported_type', 'Upload a PDF, or a JPEG, PNG or WebP photo');
    const id = await this.storeFile(ctx, bytes, fileName, mediaType);
    return { fileId: id, mediaType, bytes: bytes.length };
  }

  async storeFile(ctx: Ctx, bytes: Uint8Array, fileName: string, mime: string, trx?: Trx): Promise<string> {
    const id = newId();
    const key = storageKey(ctx.workspaceId, 'invoice', id);
    await this.storage.put(key, bytes, mime);
    const insert = (t: Trx) =>
      t
        .insertInto('app.file')
        .values({
          workspace_id: ctx.workspaceId,
          id,
          kind: 'invoice',
          storage_key: key,
          file_name: fileName.replace(/[\\/\0]/g, '_').slice(0, 255) || 'document',
          mime,
          bytes: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex'),
          uploaded_by: ctx.userId,
          retain_until: sql<string>`(current_date + make_interval(years => ${RETENTION_YEARS}))::date`,
        })
        .execute();
    if (trx) await insert(trx);
    else await this.db.run(ctx, insert);
    return id;
  }

  async fileBytes(trx: Trx, ctx: Ctx, fileId: string): Promise<{ bytes: Uint8Array; mime: string }> {
    const f = await trx
      .selectFrom('app.file')
      .select(['storage_key', 'mime'])
      .where('workspace_id', '=', ctx.workspaceId)
      .where('id', '=', fileId)
      .executeTakeFirst();
    if (!f) throw notFound('File');
    return { bytes: await this.storage.get(f.storage_key), mime: f.mime };
  }
}
