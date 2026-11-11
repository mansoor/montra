/**
 * Employees and contractors (PRL-01, PRL-05; ADR-0034). Personal data is sealed on the way in, masked on the way out,
 * and a full value is only returned by `reveal`, which writes to the audit log.
 */
import { Inject, Injectable } from '@nestjs/common';
import { newId, type PayrollPersonRow, type Trx } from '@montra/db';
import {
  calendarDate,
  employmentStatus,
  i9MayDestroy,
  i9RetainUntil,
  i9Section2Due,
  lastFour,
  maskTin,
  todayIn,
  type CalendarDate,
} from '@montra/domain';
import type {
  CreatePersonRequest,
  OnboardingDto,
  PayrollPersonDto,
  PersonKind,
  RevealRequest,
  RevealResponse,
  UpdatePersonRequest,
} from '@montra/schemas';
import { AppError, notFound, unprocessable } from '../common/errors.js';
import { payeeKeyOf } from '../categorization/categorizer.service.js';
import { FieldCrypto } from '../crypto/crypto.service.js';
import { Db } from '../db/database.js';
import { auditView, conflict, payrollEntity, personName, sealer, type Ctx } from './shared.js';

const dateOrNull = (v: unknown): CalendarDate | null => (v ? calendarDate(String(v).slice(0, 10)) : null);

@Injectable()
export class PeopleService {
  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(FieldCrypto) private readonly crypto: FieldCrypto,
  ) {}

  async list(ctx: Ctx, entityId: string, kind?: PersonKind): Promise<PayrollPersonDto[]> {
    return this.db.run(ctx, async (trx) => {
      const e = await payrollEntity(trx, ctx, entityId);
      const rows = await trx
        .selectFrom('app.payroll_person')
        .selectAll()
        .where('workspace_id', '=', ctx.workspaceId)
        .where('entity_id', '=', entityId)
        .$if(!!kind, (q) => q.where('kind', '=', kind!))
        .orderBy('last_name')
        .orderBy('first_name')
        .execute();
      const today = todayIn(e.timeZone);
      const onboarding = await this.onboarding(
        trx,
        ctx,
        rows.map((r) => r.id),
        today,
      );
      return rows.map((r) => this.dto(r, onboarding.get(r.id)!, today));
    });
  }

  async get(ctx: Ctx, id: string): Promise<PayrollPersonDto> {
    return this.db.run(ctx, (trx) => this.getIn(trx, ctx, id));
  }

  async getIn(trx: Trx, ctx: Ctx, id: string): Promise<PayrollPersonDto> {
    const r = await this.row(trx, ctx, id);
    const e = await payrollEntity(trx, ctx, r.entity_id);
    const today = todayIn(e.timeZone);
    const onboarding = await this.onboarding(trx, ctx, [r.id], today);
    return this.dto(r, onboarding.get(r.id)!, today);
  }

  /** The row, under RLS: without write access to its business, it doesn't exist. */
  async row(trx: Trx, ctx: Ctx, id: string): Promise<PayrollPersonRow> {
    const r = await trx
      .selectFrom('app.payroll_person')
      .selectAll()
      .where('workspace_id', '=', ctx.workspaceId)
      .where('id', '=', id)
      .executeTakeFirst();
    if (!r) throw notFound('Person');
    return r;
  }

  async create(ctx: Ctx, req: CreatePersonRequest): Promise<PayrollPersonDto> {
    return this.db.run(ctx, async (trx) => {
      await payrollEntity(trx, ctx, req.entityId);
      this.checkDates(req.hireDate ?? null, req.endDate ?? null);
      const id = newId();
      const vendor =
        req.kind === 'contractor'
          ? await this.vendorFor(trx, ctx, req.entityId, req.vendorPartyId ?? null, {
              name: req.businessName || `${req.firstName} ${req.lastName}`,
              email: req.email ?? null,
              phone: req.phone ?? null,
            })
          : null;
      if (req.kind === 'employee' && req.vendorPartyId) {
        throw unprocessable('payroll.vendor_for_employee', 'Only a contractor is paid as a vendor');
      }
      const s = sealer(this.crypto, trx, ctx);
      await trx
        .insertInto('app.payroll_person')
        .values({
          workspace_id: ctx.workspaceId,
          id,
          entity_id: req.entityId,
          kind: req.kind,
          first_name: req.firstName,
          middle_name: req.middleName || null,
          last_name: req.lastName,
          business_name: req.businessName || null,
          email: req.email ?? null,
          phone: req.phone || null,
          ...this.addressColumns(req.address),
          ...(await this.tinColumns(s, req.tin ?? null)),
          birth_date_enc: await s.seal('payroll_person.birth_date', req.birthDate ?? null),
          hire_date: req.hireDate ?? null,
          end_date: req.endDate ?? null,
          pay_type: req.payType ?? null,
          rate_minor: req.rate != null ? BigInt(req.rate) : null,
          work_state: req.workState ?? null,
          ...(await this.bankColumns(s, req.bank ?? null)),
          vendor_party_id: vendor,
          notes: req.notes || null,
          created_by: ctx.userId,
        })
        .execute();
      return this.getIn(trx, ctx, id);
    });
  }

  async update(ctx: Ctx, id: string, req: UpdatePersonRequest): Promise<PayrollPersonDto> {
    return this.db.run(ctx, async (trx) => {
      const r = await this.row(trx, ctx, id);
      await payrollEntity(trx, ctx, r.entity_id);
      if (BigInt(req.version) !== BigInt(r.version)) throw conflict();
      const hire = req.hireDate !== undefined ? req.hireDate : dateOrNull(r.hire_date);
      const end = req.endDate !== undefined ? req.endDate : dateOrNull(r.end_date);
      this.checkDates(hire, end);
      if (req.vendorPartyId && r.kind !== 'contractor') {
        throw unprocessable('payroll.vendor_for_employee', 'Only a contractor is paid as a vendor');
      }
      if (req.vendorPartyId) await this.vendorFor(trx, ctx, r.entity_id, req.vendorPartyId, null);
      const s = sealer(this.crypto, trx, ctx);
      const set: Record<string, unknown> = {};
      const copy = (key: keyof UpdatePersonRequest, column: string, map = (v: unknown) => v) => {
        if (req[key] !== undefined) set[column] = map(req[key]);
      };
      copy('firstName', 'first_name');
      copy('middleName', 'middle_name', (v) => v || null);
      copy('lastName', 'last_name');
      copy('businessName', 'business_name', (v) => v || null);
      copy('email', 'email');
      copy('phone', 'phone', (v) => v || null);
      copy('hireDate', 'hire_date');
      copy('endDate', 'end_date');
      copy('payType', 'pay_type');
      copy('rate', 'rate_minor', (v) => (v == null ? null : BigInt(v as string)));
      copy('workState', 'work_state');
      copy('notes', 'notes', (v) => v || null);
      copy('vendorPartyId', 'vendor_party_id');
      if (req.address !== undefined) Object.assign(set, this.addressColumns(req.address));
      if (req.tin !== undefined) Object.assign(set, await this.tinColumns(s, req.tin));
      if (req.birthDate !== undefined)
        set.birth_date_enc = await s.seal('payroll_person.birth_date', req.birthDate);
      if (req.bank !== undefined) Object.assign(set, await this.bankColumns(s, req.bank));
      if (Object.keys(set).length) {
        const res = await trx
          .updateTable('app.payroll_person')
          .set(set)
          .where('workspace_id', '=', ctx.workspaceId)
          .where('id', '=', id)
          .where('version', '=', BigInt(req.version))
          .executeTakeFirst();
        if (res.numUpdatedRows === 0n) throw conflict();
      }
      return this.getIn(trx, ctx, id);
    });
  }

  /**
   * Removes someone added by mistake. Refused while an I-9 must still be kept (ADR-0034 §5): end their employment instead.
   */
  async remove(ctx: Ctx, id: string): Promise<void> {
    await this.db.run(ctx, async (trx) => {
      const r = await this.row(trx, ctx, id);
      const e = await payrollEntity(trx, ctx, r.entity_id);
      const i9 = await trx
        .selectFrom('app.payroll_i9')
        .select('id')
        .where('workspace_id', '=', ctx.workspaceId)
        .where('person_id', '=', id)
        .executeTakeFirst();
      if (i9) {
        const until = i9RetainUntil(dateOrNull(r.hire_date), dateOrNull(r.end_date));
        if (!i9MayDestroy(until, todayIn(e.timeZone))) {
          throw new AppError(
            409,
            'payroll.i9_retained',
            until
              ? `Their I-9 must be kept until ${until}`
              : 'Their I-9 must be kept while they work here and afterwards: set an end date instead',
          );
        }
      }
      await trx
        .deleteFrom('app.payroll_person')
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', id)
        .execute();
    });
  }

  /** One full value, logged (PRL-05). The caller has checked for a recent sign-in. */
  async reveal(ctx: Ctx, personId: string, req: RevealRequest): Promise<RevealResponse> {
    return this.db.run(ctx, async (trx) => {
      const p = await this.row(trx, ctx, personId);
      await payrollEntity(trx, ctx, p.entity_id);
      const s = sealer(this.crypto, trx, ctx);
      const form = () => {
        if (!req.recordId) throw unprocessable('payroll.record_required', 'Say which form this is on');
        return req.recordId;
      };
      let value: string | null;
      switch (req.field) {
        case 'tin':
          value = await s.open('payroll_person.tin', p.tin_enc);
          break;
        case 'birthDate':
          value = await s.open('payroll_person.birth_date', p.birth_date_enc);
          break;
        case 'bankRouting':
          value = await s.open('payroll_person.bank_routing', p.bank_routing_enc);
          break;
        case 'bankAccount':
          value = await s.open('payroll_person.bank_account', p.bank_account_enc);
          break;
        case 'w4.tin': {
          const w = await trx
            .selectFrom('app.payroll_w4')
            .select('tin_enc')
            .where('workspace_id', '=', ctx.workspaceId)
            .where('person_id', '=', personId)
            .where('id', '=', form())
            .executeTakeFirst();
          if (!w) throw notFound('W-4');
          value = await s.open('payroll_w4.tin', w.tin_enc);
          break;
        }
        case 'w9.tin': {
          const w = await trx
            .selectFrom('app.payroll_w9')
            .select('tin_enc')
            .where('workspace_id', '=', ctx.workspaceId)
            .where('person_id', '=', personId)
            .where('id', '=', form())
            .executeTakeFirst();
          if (!w) throw notFound('W-9');
          value = await s.open('payroll_w9.tin', w.tin_enc);
          break;
        }
        case 'i9.document': {
          const d = await trx
            .selectFrom('app.payroll_i9_document as d')
            .innerJoin('app.payroll_i9 as i', (j) =>
              j.onRef('i.workspace_id', '=', 'd.workspace_id').onRef('i.id', '=', 'd.i9_id'),
            )
            .select('d.number_enc')
            .where('d.workspace_id', '=', ctx.workspaceId)
            .where('i.person_id', '=', personId)
            .where('d.id', '=', form())
            .executeTakeFirst();
          if (!d) throw notFound('Document');
          value = await s.open('payroll_i9_document.number', d.number_enc);
          break;
        }
        default: {
          const column = {
            'i9.ssn': 'ssn',
            'i9.birthDate': 'birth_date',
            'i9.aNumber': 'a_number',
            'i9.i94Number': 'i94_number',
            'i9.passportNumber': 'passport_number',
          }[req.field];
          const i9 = await trx
            .selectFrom('app.payroll_i9')
            .select(['ssn_enc', 'birth_date_enc', 'a_number_enc', 'i94_number_enc', 'passport_number_enc'])
            .where('workspace_id', '=', ctx.workspaceId)
            .where('person_id', '=', personId)
            .executeTakeFirst();
          if (!i9) throw notFound('I-9');
          value = await s.open(`payroll_i9.${column}`, i9[`${column}_enc` as keyof typeof i9]);
        }
      }
      await auditView(trx, ctx, 'payroll.revealed', 'payroll_person', personId, {
        field: req.field,
        ...(req.recordId ? { recordId: req.recordId } : {}),
      });
      return { value };
    });
  }

  // ----- Internals ------------------------------------------------------------------------------------------------

  private checkDates(hire: CalendarDate | null, end: CalendarDate | null): void {
    if (hire && end && end < hire) {
      throw unprocessable('payroll.end_before_hire', 'The end date is before the hire date');
    }
  }

  private addressColumns(a: CreatePersonRequest['address']) {
    return {
      address_line1: a?.line1 || null,
      address_line2: a?.line2 || null,
      city: a?.city || null,
      region: a?.region || null,
      postal_code: a?.postalCode || null,
      country: a?.country ?? 'US',
    };
  }

  private async tinColumns(s: ReturnType<typeof sealer>, tin: CreatePersonRequest['tin'] | null) {
    return {
      tin_type: tin?.type ?? null,
      tin_enc: await s.seal('payroll_person.tin', tin?.value ?? null),
      tin_last4: tin ? lastFour(tin.value) : null,
    };
  }

  private async bankColumns(s: ReturnType<typeof sealer>, bank: CreatePersonRequest['bank'] | null) {
    return {
      bank_routing_enc: await s.seal('payroll_person.bank_routing', bank?.routing ?? null),
      bank_account_enc: await s.seal('payroll_person.bank_account', bank?.account ?? null),
      bank_account_type: bank?.accountType ?? null,
      bank_last4: bank ? lastFour(bank.account) : null,
    };
  }

  /** The vendor a contractor is paid as (PRL-10): the one given, or one found or made from their name. */
  private async vendorFor(
    trx: Trx,
    ctx: Ctx,
    entityId: string,
    vendorPartyId: string | null,
    fresh: { name: string; email: string | null; phone: string | null } | null,
  ): Promise<string> {
    if (vendorPartyId) {
      const v = await trx
        .selectFrom('app.business_party')
        .select(['id', 'kind'])
        .where('workspace_id', '=', ctx.workspaceId)
        .where('entity_id', '=', entityId)
        .where('id', '=', vendorPartyId)
        .executeTakeFirst();
      if (!v || v.kind !== 'vendor')
        throw unprocessable('payroll.vendor_not_found', 'Choose a vendor of this business');
      return v.id;
    }
    const name = fresh!.name.slice(0, 200);
    const key = payeeKeyOf(name) ?? null;
    if (key) {
      const existing = await trx
        .selectFrom('app.business_party')
        .select('id')
        .where('workspace_id', '=', ctx.workspaceId)
        .where('entity_id', '=', entityId)
        .where('kind', '=', 'vendor')
        .where('payee_key', '=', key)
        .executeTakeFirst();
      if (existing) return existing.id;
    }
    const id = newId();
    await trx
      .insertInto('app.business_party')
      .values({
        workspace_id: ctx.workspaceId,
        id,
        entity_id: entityId,
        kind: 'vendor',
        name,
        payee_key: key,
        email: fresh!.email,
        phone: fresh!.phone,
      })
      .execute();
    return id;
  }

  /** Where each person stands with their forms, for a list in three queries. */
  private async onboarding(
    trx: Trx,
    ctx: Ctx,
    ids: string[],
    today: CalendarDate,
  ): Promise<Map<string, OnboardingDto>> {
    const out = new Map<string, OnboardingDto>(ids.map((id) => [id, { w4: null, w9: null, i9: null }]));
    if (!ids.length) return out;
    const [w4s, w9s, i9s, people] = await Promise.all([
      trx
        .selectFrom('app.payroll_w4')
        .select(['id', 'person_id', 'effective_date', 'filing_status', 'exempt'])
        .where('workspace_id', '=', ctx.workspaceId)
        .where('person_id', 'in', ids)
        .orderBy('effective_date')
        .execute(),
      trx
        .selectFrom('app.payroll_w9')
        .select(['id', 'person_id', 'signed_on'])
        .where('workspace_id', '=', ctx.workspaceId)
        .where('person_id', 'in', ids)
        .orderBy('signed_on')
        .orderBy('created_at')
        .execute(),
      trx
        .selectFrom('app.payroll_i9 as i')
        .select((eb) => [
          'i.id',
          'i.person_id',
          'i.employee_signed_on',
          'i.employer_signed_on',
          'i.first_day',
          eb
            .selectFrom('app.payroll_i9_document as d')
            .select((x) => x.fn.countAll<string>().as('n'))
            .whereRef('d.workspace_id', '=', 'i.workspace_id')
            .whereRef('d.i9_id', '=', 'i.id')
            .as('documents'),
        ])
        .where('i.workspace_id', '=', ctx.workspaceId)
        .where('i.person_id', 'in', ids)
        .execute(),
      trx
        .selectFrom('app.payroll_person')
        .select(['id', 'hire_date', 'end_date'])
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', 'in', ids)
        .execute(),
    ]);
    // The latest W-4 in force today, or else the first one still to come (rows are in date order).
    for (const w of w4s) {
      const o = out.get(w.person_id)!;
      const date = dateOrNull(w.effective_date)!;
      if (!o.w4 || date <= today) {
        o.w4 = { id: w.id, effectiveDate: date, filingStatus: w.filing_status, exempt: w.exempt };
      }
    }
    for (const w of w9s) out.get(w.person_id)!.w9 = { id: w.id, signedOn: dateOrNull(w.signed_on)! };
    const dates = new Map(people.map((p) => [p.id, p]));
    for (const i of i9s) {
      const p = dates.get(i.person_id)!;
      const retainUntil = i9RetainUntil(dateOrNull(p.hire_date), dateOrNull(p.end_date));
      const firstDay = dateOrNull(i.first_day) ?? dateOrNull(p.hire_date);
      out.get(i.person_id)!.i9 = {
        id: i.id,
        section1: i.employee_signed_on !== null,
        section2: i.employer_signed_on !== null,
        documents: Number(i.documents ?? 0),
        section2Due: firstDay ? i9Section2Due(firstDay) : null,
        retainUntil,
        mayDestroy: i9MayDestroy(retainUntil, today),
      };
    }
    return out;
  }

  private dto(r: PayrollPersonRow, onboarding: OnboardingDto, today: CalendarDate): PayrollPersonDto {
    const hire = dateOrNull(r.hire_date);
    const end = dateOrNull(r.end_date);
    return {
      id: r.id,
      entityId: r.entity_id,
      kind: r.kind,
      firstName: r.first_name,
      middleName: r.middle_name,
      lastName: r.last_name,
      displayName: r.kind === 'contractor' && r.business_name ? r.business_name : personName(r),
      businessName: r.business_name,
      email: r.email,
      phone: r.phone,
      address: {
        line1: r.address_line1,
        line2: r.address_line2,
        city: r.city,
        region: r.region,
        postalCode: r.postal_code,
        country: r.country,
      },
      tinType: r.tin_type,
      tinMasked: maskTin(r.tin_type, r.tin_last4),
      hasBirthDate: r.birth_date_enc !== null,
      hireDate: hire,
      endDate: end,
      status: employmentStatus(hire, end, today),
      payType: r.pay_type,
      rate: r.rate_minor !== null ? String(r.rate_minor) : null,
      workState: r.work_state,
      bank:
        r.bank_last4 && r.bank_account_type
          ? { accountType: r.bank_account_type, last4: r.bank_last4 }
          : null,
      vendorPartyId: r.vendor_party_id,
      notes: r.notes,
      onboarding,
      version: Number(r.version),
    };
  }
}
