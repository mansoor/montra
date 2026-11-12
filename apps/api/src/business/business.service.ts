/**
 * Business profiles, customers and vendors (BIZ-01, BIZ-04, ADR-0017 §6). Payees with activity are listed from their
 * postings without a row, so the directory is always current; a row appears when someone adds details or invoices one.
 */
import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import {
  newId,
  type BusinessPartyRow,
  type BusinessProfileRow,
  type BusinessRegistrationRow,
  type Trx,
} from '@montra/db';
import { returnFormOf } from '@montra/domain';
import type {
  BusinessLogoDto,
  BusinessProfileDto,
  BusinessRevealRequest,
  BusinessRevealResponse,
  CreatePartyRequest,
  OtherRegistrationDto,
  OtherRegistrationInput,
  PartyDto,
  PartyKind,
  UpdateBusinessProfileRequest,
  UpdateOtherRegistrationRequest,
  UpdatePartyRequest,
} from '@montra/schemas';
import { AppError, notFound, unprocessable } from '../common/errors.js';
import { payeeKeyOf } from '../categorization/categorizer.service.js';
import { Db } from '../db/database.js';
import { detectReceiptMedia } from '../receipts/receipts.service.js';
import { STORAGE_PORT, storageKey, type StoragePort } from '../storage/storage.js';
import { checkLogo } from './logo.js';
import { otherRegistrationDto, otherRegistrations, registrationsDto } from './registrations.js';
import {
  businessEntities,
  businessEntity,
  taxedEntity,
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
      for (const e of await businessEntities(trx, ctx)) out.push(await this.profileDtoIn(trx, ctx, e));
      return out;
    });
  }

  async profile(ctx: Ctx, entityId: string): Promise<BusinessProfileDto> {
    return this.db.run(ctx, async (trx) => {
      const e = await taxedEntity(trx, ctx, entityId);
      return this.profileDtoIn(trx, ctx, e);
    });
  }

  async updateProfile(
    ctx: Ctx,
    entityId: string,
    req: UpdateBusinessProfileRequest,
  ): Promise<BusinessProfileDto> {
    return this.db.run(ctx, async (trx) => {
      let e = await taxedEntity(trx, ctx, entityId);
      await this.ensureProfile(trx, ctx, entityId);
      for (const account of [req.defaultDepositAccountId, req.taxSavingsAccountId]) {
        if (account) await this.requireBankAccount(trx, ctx, account);
      }
      if (req.businessType !== undefined || req.fiscalYearStartMonth !== undefined) {
        e = await this.setLegalSetup(trx, ctx, e, req);
      }
      const fa = req.filingAddress;
      const set = {
        ...(req.legalName !== undefined ? { legal_name: req.legalName } : {}),
        ...(req.address !== undefined ? { address: req.address } : {}),
        ...(req.email !== undefined ? { email: req.email } : {}),
        ...(req.invoicePrefix !== undefined ? { invoice_prefix: req.invoicePrefix } : {}),
        ...(req.defaultTermsDays !== undefined ? { default_terms_days: req.defaultTermsDays } : {}),
        ...(req.defaultDepositAccountId !== undefined
          ? { default_deposit_account_id: req.defaultDepositAccountId }
          : {}),
        ...(req.taxRateBps !== undefined ? { tax_rate_bps: req.taxRateBps } : {}),
        ...(req.taxSavingsAccountId !== undefined ? { tax_savings_account_id: req.taxSavingsAccountId } : {}),
        ...(req.receiptThreshold !== undefined ? { receipt_threshold_minor: req.receiptThreshold } : {}),
        ...(req.domain !== undefined ? { domain: req.domain } : {}),
        // ADR-0037: legal setup and registrations.
        ...(req.sCorpElectionDate !== undefined ? { s_corp_election_date: req.sCorpElectionDate } : {}),
        ...(req.ein !== undefined ? { ein: req.ein } : {}),
        ...(req.irsName !== undefined ? { irs_name: req.irsName } : {}),
        ...(req.naicsCode !== undefined ? { naics_code: req.naicsCode } : {}),
        ...(req.formationState !== undefined ? { formation_state: req.formationState } : {}),
        ...(req.sosEntityNumber !== undefined ? { sos_entity_number: req.sosEntityNumber } : {}),
        ...(req.formationDate !== undefined ? { formation_date: req.formationDate } : {}),
        ...(req.ftbEntityId !== undefined ? { ftb_entity_id: req.ftbEntityId } : {}),
        ...(req.caEmployerAccount !== undefined ? { ca_employer_account: req.caEmployerAccount } : {}),
        ...(req.cdtfaPermit !== undefined ? { cdtfa_permit: req.cdtfaPermit } : {}),
        ...(req.registeredAgentName !== undefined ? { registered_agent_name: req.registeredAgentName } : {}),
        ...(req.registeredAgentAddress !== undefined
          ? { registered_agent_address: req.registeredAgentAddress }
          : {}),
        ...(req.dbaName !== undefined ? { dba_name: req.dbaName } : {}),
        ...(req.dbaCounty !== undefined ? { dba_county: req.dbaCounty } : {}),
        ...(req.dbaExpiresOn !== undefined ? { dba_expires_on: req.dbaExpiresOn } : {}),
        ...(req.cityLicenseNumber !== undefined ? { city_license_number: req.cityLicenseNumber } : {}),
        ...(req.cityLicenseExpiresOn !== undefined
          ? { city_license_expires_on: req.cityLicenseExpiresOn }
          : {}),
        ...(fa !== undefined
          ? {
              filing_line1: fa?.line1 ?? null,
              filing_line2: fa?.line2 ?? null,
              filing_city: fa?.city ?? null,
              filing_state: fa?.state ?? null,
              filing_zip: fa?.zip ?? null,
            }
          : {}),
      };
      // A change to the type or fiscal year alone leaves the profile row as it is.
      if (Object.keys(set).length) {
        await trx
          .updateTable('app.business_profile')
          .set(set)
          .where('workspace_id', '=', ctx.workspaceId)
          .where('entity_id', '=', entityId)
          .execute();
      }
      return this.profileDtoIn(trx, ctx, e);
    });
  }

  /**
   * ADR-0037 §1–2: the entity type and fiscal year are on the entity, which only an owner may change (the same rule as
   * Settings → Books). A rental portfolio has no entity type.
   */
  private async setLegalSetup(
    trx: Trx,
    ctx: Ctx,
    e: BusinessEntity,
    req: UpdateBusinessProfileRequest,
  ): Promise<BusinessEntity> {
    if (req.businessType !== undefined && e.type !== 'business') {
      throw unprocessable('business.not_a_business', 'Only a business has an entity type');
    }
    const res = await trx
      .updateTable('app.entity')
      .set({
        ...(req.businessType !== undefined ? { business_type: req.businessType } : {}),
        ...(req.fiscalYearStartMonth !== undefined
          ? { fiscal_year_start_month: req.fiscalYearStartMonth }
          : {}),
      })
      .where('workspace_id', '=', ctx.workspaceId)
      .where('id', '=', e.id)
      .executeTakeFirst();
    if (!res.numUpdatedRows) {
      throw new AppError(
        403,
        'business.owner_only',
        'Only an owner can change the entity type or fiscal year',
      );
    }
    return {
      ...e,
      ...(req.businessType !== undefined ? { businessType: req.businessType } : {}),
      ...(req.fiscalYearStartMonth !== undefined ? { fiscalYearStartMonth: req.fiscalYearStartMonth } : {}),
    };
  }

  // ----- Registrations (BIZ-22..24, ADR-0037) -----------------------------------------------------------------------

  /** One full tax account number, written to the audit log. The caller has checked for a recent sign-in. */
  async reveal(ctx: Ctx, entityId: string, req: BusinessRevealRequest): Promise<BusinessRevealResponse> {
    return this.db.run(ctx, async (trx) => {
      await businessEntity(trx, ctx, entityId);
      const r = await this.readProfile(trx, ctx, entityId);
      const value = {
        ein: r.ein,
        ftbEntityId: r.ftb_entity_id,
        caEmployerAccount: r.ca_employer_account,
        cdtfaPermit: r.cdtfa_permit,
      }[req.field];
      await trx
        .insertInto('app.audit_log')
        .values({
          workspace_id: ctx.workspaceId,
          actor_user_id: ctx.userId,
          action: 'business.revealed',
          subject_type: 'business_profile',
          subject_id: entityId,
          diff: JSON.stringify({ field: req.field }),
        })
        .execute();
      return { field: req.field, value };
    });
  }

  async addRegistration(
    ctx: Ctx,
    entityId: string,
    req: OtherRegistrationInput,
  ): Promise<OtherRegistrationDto> {
    return this.db.run(ctx, async (trx) => {
      await businessEntity(trx, ctx, entityId);
      const row = await trx
        .insertInto('app.business_registration')
        .values({
          workspace_id: ctx.workspaceId,
          entity_id: entityId,
          label: req.label,
          number: req.number ?? null,
          issuer: req.issuer ?? null,
          expires_on: req.expiresOn ?? null,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      return otherRegistrationDto(row);
    });
  }

  async updateRegistration(
    ctx: Ctx,
    entityId: string,
    id: string,
    req: UpdateOtherRegistrationRequest,
  ): Promise<OtherRegistrationDto> {
    return this.db.run(ctx, async (trx) => {
      await businessEntity(trx, ctx, entityId);
      const before = await this.registrationRow(trx, ctx, entityId, id);
      if (Number(before.version) !== req.version) {
        throw new AppError(409, 'version.conflict', 'Someone else changed this; reload and try again');
      }
      const row = await trx
        .updateTable('app.business_registration')
        .set({
          ...(req.label !== undefined ? { label: req.label } : {}),
          ...(req.number !== undefined ? { number: req.number } : {}),
          ...(req.issuer !== undefined ? { issuer: req.issuer } : {}),
          ...(req.expiresOn !== undefined ? { expires_on: req.expiresOn } : {}),
        })
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirstOrThrow();
      return otherRegistrationDto(row);
    });
  }

  async removeRegistration(ctx: Ctx, entityId: string, id: string): Promise<void> {
    await this.db.run(ctx, async (trx) => {
      await businessEntity(trx, ctx, entityId);
      await this.registrationRow(trx, ctx, entityId, id);
      await trx
        .deleteFrom('app.business_registration')
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', id)
        .execute();
    });
  }

  private async registrationRow(
    trx: Trx,
    ctx: Ctx,
    entityId: string,
    id: string,
  ): Promise<BusinessRegistrationRow> {
    const row = await trx
      .selectFrom('app.business_registration')
      .selectAll()
      .where('workspace_id', '=', ctx.workspaceId)
      .where('entity_id', '=', entityId)
      .where('id', '=', id)
      .executeTakeFirst();
    if (!row) throw notFound('Registration');
    return row;
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
        logo_file_id: null,
        domain: null,
        s_corp_election_date: null,
        ein: null,
        irs_name: null,
        naics_code: null,
        formation_state: null,
        sos_entity_number: null,
        formation_date: null,
        ftb_entity_id: null,
        ca_employer_account: null,
        cdtfa_permit: null,
        registered_agent_name: null,
        registered_agent_address: null,
        dba_name: null,
        dba_county: null,
        dba_expires_on: null,
        city_license_number: null,
        city_license_expires_on: null,
        filing_line1: null,
        filing_line2: null,
        filing_city: null,
        filing_state: null,
        filing_zip: null,
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

  private async profileDtoIn(trx: Trx, ctx: Ctx, e: BusinessEntity): Promise<BusinessProfileDto> {
    return this.profileDto(
      e,
      await this.readProfile(trx, ctx, e.id),
      await otherRegistrations(trx, ctx, e.id),
    );
  }

  private profileDto(
    e: BusinessEntity,
    r: BusinessProfileRow,
    other: BusinessRegistrationRow[],
  ): BusinessProfileDto {
    return {
      entityId: e.id,
      name: e.name,
      businessType: e.businessType,
      fiscalYearStartMonth: e.fiscalYearStartMonth,
      returnForm: e.type === 'business' ? returnFormOf(e.businessType) : null,
      sCorpElectionDate: r.s_corp_election_date ? dateOf(r.s_corp_election_date) : null,
      registrations: registrationsDto(r, other),
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
      logoFileId: r.logo_file_id,
      domain: r.domain,
      version: Number(r.version),
    };
  }

  // ----- Logo (ADR-0032) -------------------------------------------------------------------------------------

  /** Replaces the logo. The old file is marked deleted: a logo isn't paperwork, so it isn't kept for seven years. */
  async setLogo(ctx: Ctx, entityId: string, bytes: Uint8Array, fileName: string): Promise<BusinessLogoDto> {
    const check = await checkLogo(bytes);
    if (!check.ok) {
      throw check.reason === 'type'
        ? new AppError(415, 'logo.unsupported_type', 'Upload the logo as a PNG or JPEG image')
        : check.reason === 'size'
          ? new AppError(413, 'logo.too_large', 'The logo can be up to 1 MB')
          : unprocessable('logo.too_many_pixels', 'The logo can be up to 4096 pixels on each side');
    }
    const { mediaType, width, height } = check.image;
    // Check access before storing anything: without write access to the business, nothing is kept.
    await this.db.run(ctx, async (trx) => {
      await businessEntity(trx, ctx, entityId);
      await this.ensureProfile(trx, ctx, entityId);
    });
    const id = newId();
    const key = storageKey(ctx.workspaceId, 'logo', id);
    await this.storage.put(key, bytes, mediaType);
    await this.db.run(ctx, async (trx) => {
      await trx
        .insertInto('app.file')
        .values({
          workspace_id: ctx.workspaceId,
          id,
          kind: 'logo',
          storage_key: key,
          file_name: fileName.replace(/[\\/\0]/g, '_').slice(0, 255) || 'logo',
          mime: mediaType,
          bytes: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex'),
          uploaded_by: ctx.userId,
        })
        .execute();
      await this.replaceLogo(trx, ctx, entityId, id);
    });
    return { fileId: id, mediaType, bytes: bytes.length, width, height };
  }

  async removeLogo(ctx: Ctx, entityId: string): Promise<void> {
    await this.db.run(ctx, async (trx) => {
      await businessEntity(trx, ctx, entityId);
      await this.replaceLogo(trx, ctx, entityId, null);
    });
  }

  private async replaceLogo(trx: Trx, ctx: Ctx, entityId: string, fileId: string | null): Promise<void> {
    const before = await trx
      .selectFrom('app.business_profile')
      .select('logo_file_id')
      .where('workspace_id', '=', ctx.workspaceId)
      .where('entity_id', '=', entityId)
      .forUpdate()
      .executeTakeFirst();
    const res = await trx
      .updateTable('app.business_profile')
      .set({ logo_file_id: fileId })
      .where('workspace_id', '=', ctx.workspaceId)
      .where('entity_id', '=', entityId)
      .executeTakeFirst();
    if (!res.numUpdatedRows) throw notFound('Business');
    if (before?.logo_file_id && before.logo_file_id !== fileId) {
      await trx
        .updateTable('app.file')
        .set({ deleted_at: new Date() })
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', before.logo_file_id)
        .execute();
    }
  }

  /** The logo's bytes, for the settings, the invoice page and the PDF; null without one. */
  async logo(ctx: Ctx, entityId: string): Promise<{ bytes: Uint8Array; mime: string } | null> {
    return this.db.run(ctx, async (trx) => {
      await taxedEntity(trx, ctx, entityId);
      return this.logoIn(trx, ctx, entityId);
    });
  }

  async logoIn(trx: Trx, ctx: Ctx, entityId: string): Promise<{ bytes: Uint8Array; mime: string } | null> {
    const row = await trx
      .selectFrom('app.business_profile')
      .select('logo_file_id')
      .where('workspace_id', '=', ctx.workspaceId)
      .where('entity_id', '=', entityId)
      .executeTakeFirst();
    return row?.logo_file_id ? this.fileBytes(trx, ctx, row.logo_file_id) : null;
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
