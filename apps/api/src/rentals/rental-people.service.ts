/**
 * The other people on a lease, what a lease cost to set up, and a portfolio's contacts (RNT-18, RNT-19, RNT-21;
 * ADR-0038). Co-signers and occupants never pay: rent, arrears and matching read only `lease_tenant`. A broker's fee
 * and legal fees post through the same payment links as rent, owned by the lease and tagged to its property and unit.
 */
import { Inject, Injectable } from '@nestjs/common';
import { newId, type RentalContactRow, type Trx } from '@montra/db';
import { calendarDate } from '@montra/domain';
import type {
  CreateRentalContactRequest,
  LeaseCostRequest,
  LeaseDto,
  LeasePersonRequest,
  RentalContactDto,
  RentalContactRole,
  RevealDateOfBirthResponse,
  UpdateLeasePersonRequest,
  UpdateRentalContactRequest,
} from '@montra/schemas';
import { PaymentLinks } from '../business/payment-links.service.js';
import { AppError, notFound, unprocessable } from '../common/errors.js';
import { FieldCrypto } from '../crypto/crypto.service.js';
import { Db } from '../db/database.js';
import type { SplitSpec } from '../transactions/poster.js';
import {
  auditReveal,
  insertLeasePerson,
  leasePersonRow,
  PERSON_DOB,
  portfolioContact,
} from './lease-people.js';
import { PropertiesService } from './properties.service.js';
import { categoryOnLine, rentalEntity, SCH_E, type Ctx } from './shared.js';

const conflict = () =>
  new AppError(409, 'version.conflict', 'Someone else changed this; reload and try again');

/** Where each set-up cost goes on Schedule E, and how it reads in the books. */
const COST: Record<LeaseCostRequest['kind'], { line: string; label: string }> = {
  broker_fee: { line: SCH_E.COMMISSIONS, label: 'Broker fee' },
  legal_fee: { line: SCH_E.LEGAL, label: 'Lease legal fees' },
};

@Injectable()
export class RentalPeopleService {
  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(FieldCrypto) private readonly crypto: FieldCrypto,
    @Inject(PaymentLinks) private readonly links: PaymentLinks,
    @Inject(PropertiesService) private readonly properties: PropertiesService,
  ) {}

  // ----- Co-signers and occupants (RNT-18) ---------------------------------------------------------------------

  async addPerson(ctx: Ctx, leaseId: string, req: LeasePersonRequest): Promise<LeaseDto> {
    return this.db.run(ctx, async (trx) => {
      const lease = await this.properties.leaseRow(trx, ctx, leaseId);
      await rentalEntity(trx, ctx, lease.entity_id);
      await insertLeasePerson(trx, ctx, this.crypto, lease, req);
      return this.properties.leaseDtoById(trx, ctx, leaseId);
    });
  }

  async updatePerson(ctx: Ctx, id: string, req: UpdateLeasePersonRequest): Promise<LeaseDto> {
    return this.db.run(ctx, async (trx) => {
      const p = await leasePersonRow(trx, ctx, id);
      if (BigInt(p.version) !== BigInt(req.version)) throw conflict();
      // A co-signer who is a tenant keeps their name and contact details on the tenant record.
      const own = p.tenant_id === null;
      if (own && req.name === null) throw unprocessable('lease.person_name', 'Enter a name');
      await trx
        .updateTable('app.lease_person')
        .set({
          ...(req.relationship !== undefined ? { relationship: req.relationship } : {}),
          ...(req.notes !== undefined ? { notes: req.notes } : {}),
          ...(own && req.name ? { name: req.name } : {}),
          ...(own && req.email !== undefined ? { email: req.email } : {}),
          ...(own && req.phone !== undefined ? { phone: req.phone } : {}),
          ...(own && req.mailingAddress !== undefined ? { mailing_address: req.mailingAddress } : {}),
          ...(own && req.dateOfBirth !== undefined
            ? { birth_date_enc: await this.crypto.encrypt(trx, ctx.workspaceId, PERSON_DOB, req.dateOfBirth) }
            : {}),
        })
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', id)
        .execute();
      return this.properties.leaseDtoById(trx, ctx, p.lease_id);
    });
  }

  async removePerson(ctx: Ctx, id: string): Promise<void> {
    await this.db.run(ctx, async (trx) => {
      await leasePersonRow(trx, ctx, id);
      await trx
        .deleteFrom('app.lease_person')
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', id)
        .execute();
    });
  }

  /** The full date of birth, once, logged. The caller has checked for a recent sign-in. */
  async revealPerson(ctx: Ctx, id: string): Promise<RevealDateOfBirthResponse> {
    return this.db.run(ctx, async (trx) => {
      const p = await leasePersonRow(trx, ctx, id);
      const dob = await this.crypto.decrypt(trx, ctx.workspaceId, PERSON_DOB, p.birth_date_enc);
      await auditReveal(trx, ctx, 'lease_person', id);
      return { dateOfBirth: dob ? calendarDate(dob) : null };
    });
  }

  // ----- Broker's fee and legal fees (RNT-19) -------------------------------------------------------------------

  /**
   * Posts the cost as an expense on its Schedule E line, tagged to the lease's property and unit (RNT-06): recorded as
   * paid from an account, or a bank line already in the books taken over. A leasing commission is expensed when paid;
   * spreading it over the lease term is left to the owner's accountant (ADR-0038 §3).
   */
  async addCost(ctx: Ctx, leaseId: string, req: LeaseCostRequest): Promise<LeaseDto> {
    return this.db.run(ctx, async (trx) => {
      const lease = await this.properties.leaseRow(trx, ctx, leaseId);
      const e = await rentalEntity(trx, ctx, lease.entity_id);
      const contact = req.contactId ? await portfolioContact(trx, ctx, lease.entity_id, req.contactId) : null;
      const { line, label } = COST[req.kind];
      const category = await categoryOnLine(trx, ctx, lease.entity_id, line);
      // An expense is money out: the transaction and its split are negative.
      const splitsFor = (amount: bigint): SplitSpec[] => [
        {
          accountId: category,
          amount: String(-amount),
          memberId: null,
          propertyId: lease.property_id,
          unitId: lease.unit_id,
        },
      ];
      const owner = { leaseId };
      let transactionId: string;
      let amount: bigint;
      let previous: unknown = null;
      if ('transactionId' in req) {
        const t = await trx
          .selectFrom('app.transaction')
          .select('spec')
          .where('workspace_id', '=', ctx.workspaceId)
          .where('id', '=', req.transactionId)
          .executeTakeFirst();
        if (!t) throw notFound('Transaction');
        const size = -BigInt((t.spec as { amount?: string } | null)?.amount ?? '0');
        const taken = await this.links.takeOver(trx, ctx, req.transactionId, owner, splitsFor(size), {
          sign: -1,
          currency: e.currency,
        });
        transactionId = req.transactionId;
        amount = taken.amount;
        previous = taken.previous;
      } else {
        amount = BigInt(req.amount);
        transactionId = await this.links.create(trx, ctx, {
          entityId: lease.entity_id,
          accountId: req.accountId,
          date: req.date,
          amount: -amount,
          currency: e.currency,
          payee: contact?.company_name ?? label,
          payeeKey: null,
          description: label,
          source: 'manual',
          owner,
          splits: splitsFor(amount),
        });
      }
      await trx
        .insertInto('app.lease_cost')
        .values({
          workspace_id: ctx.workspaceId,
          id: newId(),
          entity_id: lease.entity_id,
          lease_id: leaseId,
          kind: req.kind,
          contact_id: contact?.id ?? null,
          amount_minor: amount,
          transaction_id: transactionId,
          previous_spec: previous ? JSON.stringify(previous) : null,
          notes: req.notes ?? null,
          created_by: ctx.userId,
        })
        .execute();
      return this.properties.leaseDtoById(trx, ctx, leaseId);
    });
  }

  /** Removes the cost: a bank line it took over goes back as it was; one it created is voided. */
  async removeCost(ctx: Ctx, leaseId: string, costId: string): Promise<void> {
    await this.db.run(ctx, async (trx) => {
      const c = await trx
        .selectFrom('app.lease_cost')
        .selectAll()
        .where('workspace_id', '=', ctx.workspaceId)
        .where('lease_id', '=', leaseId)
        .where('id', '=', costId)
        .executeTakeFirst();
      if (!c) throw notFound('Cost');
      await trx
        .deleteFrom('app.lease_cost')
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', costId)
        .execute();
      await this.links.release(trx, ctx, c.transaction_id, c.previous_spec);
    });
  }

  // ----- Contacts (RNT-21) --------------------------------------------------------------------------------------

  async listContacts(
    ctx: Ctx,
    q: { entityId: string; propertyId?: string; role?: RentalContactRole; archived?: boolean },
  ): Promise<RentalContactDto[]> {
    return this.db.run(ctx, async (trx) => {
      await rentalEntity(trx, ctx, q.entityId);
      const rows = await trx
        .selectFrom('app.rental_contact as c')
        .selectAll('c')
        .where('c.workspace_id', '=', ctx.workspaceId)
        .where('c.entity_id', '=', q.entityId)
        .$if(!q.archived, (x) => x.where('c.archived_at', 'is', null))
        .$if(!!q.role, (x) => x.where('c.role', '=', q.role!))
        .$if(!!q.propertyId, (x) =>
          x.where(({ exists, selectFrom }) =>
            exists(
              selectFrom('app.rental_contact_property as cp')
                .select('cp.contact_id')
                .whereRef('cp.workspace_id', '=', 'c.workspace_id')
                .whereRef('cp.contact_id', '=', 'c.id')
                .where('cp.property_id', '=', q.propertyId!),
            ),
          ),
        )
        .orderBy('c.role')
        .orderBy('c.company_name')
        .execute();
      return this.contactDtos(trx, ctx, rows);
    });
  }

  async createContact(ctx: Ctx, req: CreateRentalContactRequest): Promise<RentalContactDto> {
    return this.db.run(ctx, async (trx) => {
      await rentalEntity(trx, ctx, req.entityId);
      const id = newId();
      await trx
        .insertInto('app.rental_contact')
        .values({
          workspace_id: ctx.workspaceId,
          id,
          entity_id: req.entityId,
          role: req.role,
          company_name: req.companyName,
          contact_person: req.contactPerson || null,
          website: req.website || null,
          email: req.email || null,
          phone: req.phone || null,
          account_number: req.accountNumber || null,
          notes: req.notes || null,
        })
        .execute();
      await this.linkProperties(trx, ctx, req.entityId, id, req.propertyIds);
      return this.contactDto(trx, ctx, id);
    });
  }

  async updateContact(ctx: Ctx, id: string, req: UpdateRentalContactRequest): Promise<RentalContactDto> {
    return this.db.run(ctx, async (trx) => {
      const c = await this.contactRow(trx, ctx, id);
      if (BigInt(c.version) !== BigInt(req.version)) throw conflict();
      const text = (v: string | null | undefined) => (v === undefined ? undefined : v || null);
      const set = {
        role: req.role,
        company_name: req.companyName,
        contact_person: text(req.contactPerson),
        website: text(req.website),
        email: text(req.email),
        phone: text(req.phone),
        account_number: text(req.accountNumber),
        notes: text(req.notes),
        ...(req.archived !== undefined ? { archived_at: req.archived ? new Date() : null } : {}),
      };
      await trx
        .updateTable('app.rental_contact')
        .set(Object.fromEntries(Object.entries(set).filter(([, v]) => v !== undefined)))
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', id)
        .execute();
      if (req.propertyIds) {
        await trx
          .deleteFrom('app.rental_contact_property')
          .where('workspace_id', '=', ctx.workspaceId)
          .where('contact_id', '=', id)
          .execute();
        await this.linkProperties(trx, ctx, c.entity_id, id, req.propertyIds);
      }
      return this.contactDto(trx, ctx, id);
    });
  }

  /**
   * Deletes a contact. A maintenance entry that named it keeps the name as its free-text vendor; a lease's broker and
   * a cost's payee are cleared. The transactions a cost posted are unchanged.
   */
  async deleteContact(ctx: Ctx, id: string): Promise<void> {
    await this.db.run(ctx, async (trx) => {
      const c = await this.contactRow(trx, ctx, id);
      await trx
        .updateTable('app.maintenance_log')
        .set((eb) => ({
          contact_id: null,
          vendor: eb.fn.coalesce('vendor', eb.val(c.company_name)),
        }))
        .where('workspace_id', '=', ctx.workspaceId)
        .where('contact_id', '=', id)
        .execute();
      await trx
        .updateTable('app.lease')
        .set({ broker_contact_id: null })
        .where('workspace_id', '=', ctx.workspaceId)
        .where('broker_contact_id', '=', id)
        .execute();
      await trx
        .updateTable('app.lease_cost')
        .set({ contact_id: null })
        .where('workspace_id', '=', ctx.workspaceId)
        .where('contact_id', '=', id)
        .execute();
      await trx
        .deleteFrom('app.rental_contact')
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', id)
        .execute();
    });
  }

  private async contactRow(trx: Trx, ctx: Ctx, id: string): Promise<RentalContactRow> {
    const c = await trx
      .selectFrom('app.rental_contact')
      .selectAll()
      .where('workspace_id', '=', ctx.workspaceId)
      .where('id', '=', id)
      .executeTakeFirst();
    if (!c) throw notFound('Contact');
    return c;
  }

  private async linkProperties(
    trx: Trx,
    ctx: Ctx,
    entityId: string,
    contactId: string,
    propertyIds: string[],
  ): Promise<void> {
    const ids = [...new Set(propertyIds)];
    if (ids.length === 0) return;
    const found = await trx
      .selectFrom('app.property')
      .select('id')
      .where('workspace_id', '=', ctx.workspaceId)
      .where('entity_id', '=', entityId)
      .where('id', 'in', ids)
      .execute();
    if (found.length !== ids.length)
      throw unprocessable('rental.contact_property', 'Choose properties of this portfolio');
    await trx
      .insertInto('app.rental_contact_property')
      .values(
        ids.map((property_id) => ({
          workspace_id: ctx.workspaceId,
          contact_id: contactId,
          property_id,
          entity_id: entityId,
        })),
      )
      .execute();
  }

  private async contactDto(trx: Trx, ctx: Ctx, id: string): Promise<RentalContactDto> {
    const [dto] = await this.contactDtos(trx, ctx, [await this.contactRow(trx, ctx, id)]);
    return dto!;
  }

  private async contactDtos(trx: Trx, ctx: Ctx, rows: RentalContactRow[]): Promise<RentalContactDto[]> {
    if (rows.length === 0) return [];
    const links = await trx
      .selectFrom('app.rental_contact_property as cp')
      .innerJoin('app.property as p', (j) =>
        j.onRef('p.workspace_id', '=', 'cp.workspace_id').onRef('p.id', '=', 'cp.property_id'),
      )
      .select(['cp.contact_id', 'cp.property_id'])
      .where('cp.workspace_id', '=', ctx.workspaceId)
      .where(
        'cp.contact_id',
        'in',
        rows.map((r) => r.id),
      )
      .orderBy('p.name')
      .execute();
    return rows.map((c) => ({
      id: c.id,
      entityId: c.entity_id,
      role: c.role,
      companyName: c.company_name,
      contactPerson: c.contact_person,
      website: c.website,
      email: c.email,
      phone: c.phone,
      accountNumber: c.account_number,
      notes: c.notes,
      propertyIds: links.filter((l) => l.contact_id === c.id).map((l) => l.property_id),
      archived: c.archived_at !== null,
      version: Number(c.version),
    }));
  }
}
