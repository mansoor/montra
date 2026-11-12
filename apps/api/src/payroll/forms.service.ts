/**
 * Onboarding forms (PRL-02..05; ADR-0034 §3–5): W-4 and W-9 are recorded as signed and never edited; the I-9 is filled
 * in two sections, with sealed copies of the documents examined. Downloading a filled form or a copy is logged.
 */
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { newId, type PayrollI9DocumentRow, type PayrollI9Row, type Trx } from '@montra/db';
import {
  calendarDate,
  i9MayDestroy,
  i9RetainUntil,
  i9Section2Due,
  lastFour,
  maskTail,
  maskTin,
  todayIn,
  type CalendarDate,
} from '@montra/domain';
import type {
  AddI9DocumentRequest,
  CreateDe4Request,
  CreateW4Request,
  CreateW9Request,
  I9DocumentDto,
  I9Dto,
  PayrollFileDto,
  SaveI9Section1Request,
  SaveI9Section2Request,
  W4Dto,
  De4Dto,
  W9Dto,
} from '@montra/schemas';
import { AppError, notFound, unprocessable } from '../common/errors.js';
import { FieldCrypto } from '../crypto/crypto.service.js';
import { Db } from '../db/database.js';
import { detectReceiptMedia } from '../receipts/receipts.service.js';
import { STORAGE_PORT, sha256, storageKey, type StoragePort } from '../storage/storage.js';
import { employerIdentity, formatEddAccount, formatEin } from '../business/registrations.js';
import { de4Doc, i9Doc, renderFormPdf, w4Doc, w9Doc, formatTin } from './form-pdf.js';
import { PeopleService } from './people.service.js';
import { auditView, conflict, formatAddress, payrollEntity, personName, sealer, type Ctx } from './shared.js';

const dateOrNull = (v: unknown): CalendarDate | null => (v ? calendarDate(String(v).slice(0, 10)) : null);
/** Kept as long as the longest rule that can apply to them (I-9: until destroyed by the owner after retention). */
const FILE_RETENTION_YEARS = 7;

@Injectable()
export class FormsService {
  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(FieldCrypto) private readonly crypto: FieldCrypto,
    @Inject(STORAGE_PORT) private readonly storage: StoragePort,
    @Inject(PeopleService) private readonly people: PeopleService,
  ) {}

  // ----- W-4 ------------------------------------------------------------------------------------------------------

  async listW4(ctx: Ctx, personId: string): Promise<W4Dto[]> {
    return this.db.run(ctx, async (trx) => {
      const p = await this.people.row(trx, ctx, personId);
      const e = await payrollEntity(trx, ctx, p.entity_id);
      const rows = await trx
        .selectFrom('app.payroll_w4')
        .selectAll()
        .where('workspace_id', '=', ctx.workspaceId)
        .where('person_id', '=', personId)
        .orderBy('effective_date', 'desc')
        .execute();
      const today = todayIn(e.timeZone);
      const current = rows.find((r) => dateOrNull(r.effective_date)! <= today) ?? rows.at(-1);
      return rows.map((r) => ({
        id: r.id,
        personId: r.person_id,
        effectiveDate: dateOrNull(r.effective_date)!,
        legalName: r.legal_name,
        address: r.address,
        tinMasked: maskTin('ssn', r.tin_last4),
        filingStatus: r.filing_status,
        multipleJobs: r.multiple_jobs,
        dependents: String(r.dependents_minor),
        otherIncome: String(r.other_income_minor),
        deductions: String(r.deductions_minor),
        extraWithholding: String(r.extra_withholding_minor),
        exempt: r.exempt,
        signedName: r.signed_name,
        signedOn: dateOrNull(r.signed_on)!,
        current: r.id === current?.id,
      }));
    });
  }

  /** The employee's details as they stand are kept on the form, as signed. */
  async createW4(ctx: Ctx, personId: string, req: CreateW4Request): Promise<W4Dto> {
    await this.db.run(ctx, async (trx) => {
      const p = await this.people.row(trx, ctx, personId);
      await payrollEntity(trx, ctx, p.entity_id);
      if (p.kind !== 'employee') throw unprocessable('payroll.not_employee', 'A W-4 is for an employee');
      const s = sealer(this.crypto, trx, ctx);
      const ssn = p.tin_type === 'ein' ? null : await s.open('payroll_person.tin', p.tin_enc);
      const taken = await trx
        .selectFrom('app.payroll_w4')
        .select('id')
        .where('workspace_id', '=', ctx.workspaceId)
        .where('person_id', '=', personId)
        .where('effective_date', '=', req.effectiveDate)
        .executeTakeFirst();
      if (taken) {
        throw new AppError(
          409,
          'payroll.w4_exists',
          'There is already a W-4 from this date; use a later date',
        );
      }
      await trx
        .insertInto('app.payroll_w4')
        .values({
          workspace_id: ctx.workspaceId,
          id: newId(),
          entity_id: p.entity_id,
          person_id: personId,
          effective_date: req.effectiveDate,
          legal_name: personName(p),
          address: formatAddress(p),
          tin_enc: await s.seal('payroll_w4.tin', ssn),
          tin_last4: ssn ? lastFour(ssn) : null,
          filing_status: req.filingStatus,
          multiple_jobs: req.multipleJobs,
          dependents_minor: BigInt(req.dependents),
          other_income_minor: BigInt(req.otherIncome),
          deductions_minor: BigInt(req.deductions),
          extra_withholding_minor: BigInt(req.extraWithholding),
          exempt: req.exempt,
          signed_name: req.signedName,
          signed_on: req.signedOn,
          created_by: ctx.userId,
        })
        .execute();
    });
    const all = await this.listW4(ctx, personId);
    return all.find((w) => w.effectiveDate === req.effectiveDate)!;
  }

  async w4Pdf(ctx: Ctx, personId: string, w4Id: string): Promise<{ bytes: Uint8Array; fileName: string }> {
    return this.db.run(ctx, async (trx) => {
      const p = await this.people.row(trx, ctx, personId);
      const e = await payrollEntity(trx, ctx, p.entity_id);
      const w = await trx
        .selectFrom('app.payroll_w4')
        .selectAll()
        .where('workspace_id', '=', ctx.workspaceId)
        .where('person_id', '=', personId)
        .where('id', '=', w4Id)
        .executeTakeFirst();
      if (!w) throw notFound('W-4');
      const s = sealer(this.crypto, trx, ctx);
      const ssn = await s.open('payroll_w4.tin', w.tin_enc);
      const employer = await this.employer(trx, ctx, p.entity_id, e.name);
      const bytes = await renderFormPdf(
        w4Doc({
          year: Number(String(w.effective_date).slice(0, 4)),
          firstName: [p.first_name, p.middle_name?.[0]].filter(Boolean).join(' '),
          lastName: p.last_name,
          address: w.address,
          ssn: formatTin('ssn', ssn),
          filingStatus: w.filing_status,
          multipleJobs: w.multiple_jobs,
          dependents: w.dependents_minor,
          otherIncome: w.other_income_minor,
          deductions: w.deductions_minor,
          extraWithholding: w.extra_withholding_minor,
          exempt: w.exempt,
          signedName: w.signed_name,
          signedOn: dateOrNull(w.signed_on)!,
          employer: { name: employer.name, address: employer.address, ein: employer.ein },
          firstDay: dateOrNull(p.hire_date),
        }),
      );
      await auditView(trx, ctx, 'payroll.form_downloaded', 'payroll_person', personId, {
        form: 'w4',
        id: w4Id,
      });
      return { bytes, fileName: `W-4 ${p.last_name} ${String(w.effective_date).slice(0, 10)}.pdf` };
    });
  }

  // ----- DE 4 (PRL-14) -----------------------------------------------------------------------------------------

  async listDe4(ctx: Ctx, personId: string): Promise<De4Dto[]> {
    return this.db.run(ctx, async (trx) => {
      const p = await this.people.row(trx, ctx, personId);
      const e = await payrollEntity(trx, ctx, p.entity_id);
      const rows = await trx
        .selectFrom('app.payroll_de4')
        .selectAll()
        .where('workspace_id', '=', ctx.workspaceId)
        .where('person_id', '=', personId)
        .orderBy('effective_date', 'desc')
        .execute();
      const today = todayIn(e.timeZone);
      const current = rows.find((r) => dateOrNull(r.effective_date)! <= today) ?? rows.at(-1);
      return rows.map((r) => ({
        id: r.id,
        personId: r.person_id,
        effectiveDate: dateOrNull(r.effective_date)!,
        legalName: r.legal_name,
        address: r.address,
        tinMasked: maskTin('ssn', r.tin_last4),
        filingStatus: r.filing_status,
        allowances: r.allowances,
        estimatedDeductionAllowances: r.estimated_deduction_allowances,
        extraWithholding: String(r.extra_withholding_minor),
        exempt: r.exempt,
        signedName: r.signed_name,
        signedOn: dateOrNull(r.signed_on)!,
        current: r.id === current?.id,
      }));
    });
  }

  /** California's DE 4, kept as signed like a W-4; a newer one takes over from its effective date. */
  async createDe4(ctx: Ctx, personId: string, req: CreateDe4Request): Promise<De4Dto> {
    await this.db.run(ctx, async (trx) => {
      const p = await this.people.row(trx, ctx, personId);
      await payrollEntity(trx, ctx, p.entity_id);
      if (p.kind !== 'employee') throw unprocessable('payroll.not_employee', 'A DE 4 is for an employee');
      const s = sealer(this.crypto, trx, ctx);
      const ssn = p.tin_type === 'ein' ? null : await s.open('payroll_person.tin', p.tin_enc);
      const taken = await trx
        .selectFrom('app.payroll_de4')
        .select('id')
        .where('workspace_id', '=', ctx.workspaceId)
        .where('person_id', '=', personId)
        .where('effective_date', '=', req.effectiveDate)
        .executeTakeFirst();
      if (taken) {
        throw new AppError(
          409,
          'payroll.de4_exists',
          'There is already a DE 4 from this date; use a later date',
        );
      }
      await trx
        .insertInto('app.payroll_de4')
        .values({
          workspace_id: ctx.workspaceId,
          id: newId(),
          entity_id: p.entity_id,
          person_id: personId,
          effective_date: req.effectiveDate,
          legal_name: personName(p),
          address: formatAddress(p),
          tin_enc: await s.seal('payroll_de4.tin', ssn),
          tin_last4: ssn ? lastFour(ssn) : null,
          filing_status: req.filingStatus,
          allowances: req.allowances,
          estimated_deduction_allowances: req.estimatedDeductionAllowances,
          extra_withholding_minor: BigInt(req.extraWithholding),
          exempt: req.exempt,
          signed_name: req.signedName,
          signed_on: req.signedOn,
          created_by: ctx.userId,
        })
        .execute();
    });
    const all = await this.listDe4(ctx, personId);
    return all.find((w) => w.effectiveDate === req.effectiveDate)!;
  }

  async de4Pdf(ctx: Ctx, personId: string, de4Id: string): Promise<{ bytes: Uint8Array; fileName: string }> {
    return this.db.run(ctx, async (trx) => {
      const p = await this.people.row(trx, ctx, personId);
      const e = await payrollEntity(trx, ctx, p.entity_id);
      const w = await trx
        .selectFrom('app.payroll_de4')
        .selectAll()
        .where('workspace_id', '=', ctx.workspaceId)
        .where('person_id', '=', personId)
        .where('id', '=', de4Id)
        .executeTakeFirst();
      if (!w) throw notFound('DE 4');
      const ssn = await sealer(this.crypto, trx, ctx).open('payroll_de4.tin', w.tin_enc);
      const employer = await this.employer(trx, ctx, p.entity_id, e.name);
      const bytes = await renderFormPdf(
        de4Doc({
          year: Number(String(w.effective_date).slice(0, 4)),
          name: w.legal_name,
          address: w.address,
          ssn: formatTin('ssn', ssn),
          filingStatus: w.filing_status,
          allowances: w.allowances,
          estimatedDeductionAllowances: w.estimated_deduction_allowances,
          extraWithholding: w.extra_withholding_minor,
          exempt: w.exempt,
          signedName: w.signed_name,
          signedOn: dateOrNull(w.signed_on)!,
          employer: { name: employer.name, address: employer.address, account: employer.account },
        }),
      );
      await auditView(trx, ctx, 'payroll.form_downloaded', 'payroll_person', personId, {
        form: 'de4',
        id: de4Id,
      });
      return { bytes, fileName: `DE 4 ${p.last_name} ${String(w.effective_date).slice(0, 10)}.pdf` };
    });
  }

  // ----- W-9 ------------------------------------------------------------------------------------------------------

  async listW9(ctx: Ctx, personId: string): Promise<W9Dto[]> {
    return this.db.run(ctx, async (trx) => {
      const p = await this.people.row(trx, ctx, personId);
      await payrollEntity(trx, ctx, p.entity_id);
      const rows = await trx
        .selectFrom('app.payroll_w9')
        .selectAll()
        .where('workspace_id', '=', ctx.workspaceId)
        .where('person_id', '=', personId)
        .orderBy('signed_on', 'desc')
        .orderBy('created_at', 'desc')
        .execute();
      return rows.map((r, i) => ({
        id: r.id,
        personId: r.person_id,
        legalName: r.legal_name,
        businessName: r.business_name,
        taxClassification: r.tax_classification,
        otherClassification: r.other_classification,
        foreignPartners: r.foreign_partners,
        exemptPayeeCode: r.exempt_payee_code,
        fatcaCode: r.fatca_code,
        address: r.address,
        accountNumbers: r.account_numbers,
        tinType: r.tin_type,
        tinMasked: maskTin(r.tin_type, r.tin_last4)!,
        backupWithholding: r.backup_withholding,
        signedName: r.signed_name,
        signedOn: dateOrNull(r.signed_on)!,
        current: i === 0,
      }));
    });
  }

  /**
   * A W-9 also brings the contractor's record up to date: the TIN they certified is the one a 1099 uses (PRL-18).
   */
  async createW9(ctx: Ctx, personId: string, req: CreateW9Request): Promise<W9Dto> {
    const id = newId();
    await this.db.run(ctx, async (trx) => {
      const p = await this.people.row(trx, ctx, personId);
      await payrollEntity(trx, ctx, p.entity_id);
      if (p.kind !== 'contractor') throw unprocessable('payroll.not_contractor', 'A W-9 is for a contractor');
      const s = sealer(this.crypto, trx, ctx);
      await trx
        .insertInto('app.payroll_w9')
        .values({
          workspace_id: ctx.workspaceId,
          id,
          entity_id: p.entity_id,
          person_id: personId,
          legal_name: req.legalName,
          business_name: req.businessName || null,
          tax_classification: req.taxClassification,
          other_classification: req.taxClassification === 'other' ? req.otherClassification || null : null,
          foreign_partners: req.foreignPartners,
          exempt_payee_code: req.exemptPayeeCode || null,
          fatca_code: req.fatcaCode || null,
          address: req.address,
          account_numbers: req.accountNumbers || null,
          tin_type: req.tin.type,
          tin_enc: (await s.seal('payroll_w9.tin', req.tin.value))!,
          tin_last4: lastFour(req.tin.value),
          backup_withholding: req.backupWithholding,
          signed_name: req.signedName,
          signed_on: req.signedOn,
          created_by: ctx.userId,
        })
        .execute();
      await trx
        .updateTable('app.payroll_person')
        .set({
          tin_type: req.tin.type,
          tin_enc: await s.seal('payroll_person.tin', req.tin.value),
          tin_last4: lastFour(req.tin.value),
          business_name: req.businessName || p.business_name,
        })
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', personId)
        .execute();
    });
    return (await this.listW9(ctx, personId)).find((w) => w.id === id)!;
  }

  async w9Pdf(ctx: Ctx, personId: string, w9Id: string): Promise<{ bytes: Uint8Array; fileName: string }> {
    return this.db.run(ctx, async (trx) => {
      const p = await this.people.row(trx, ctx, personId);
      const e = await payrollEntity(trx, ctx, p.entity_id);
      const w = await trx
        .selectFrom('app.payroll_w9')
        .selectAll()
        .where('workspace_id', '=', ctx.workspaceId)
        .where('person_id', '=', personId)
        .where('id', '=', w9Id)
        .executeTakeFirst();
      if (!w) throw notFound('W-9');
      const tin = (await sealer(this.crypto, trx, ctx).open('payroll_w9.tin', w.tin_enc))!;
      const employer = await this.employer(trx, ctx, p.entity_id, e.name);
      const bytes = await renderFormPdf(
        w9Doc({
          legalName: w.legal_name,
          businessName: w.business_name,
          taxClassification: w.tax_classification,
          otherClassification: w.other_classification,
          foreignPartners: w.foreign_partners,
          exemptPayeeCode: w.exempt_payee_code,
          fatcaCode: w.fatca_code,
          address: w.address,
          accountNumbers: w.account_numbers,
          tinType: w.tin_type,
          tin,
          backupWithholding: w.backup_withholding,
          signedName: w.signed_name,
          signedOn: dateOrNull(w.signed_on)!,
          requester: employer,
        }),
      );
      await auditView(trx, ctx, 'payroll.form_downloaded', 'payroll_person', personId, {
        form: 'w9',
        id: w9Id,
      });
      return { bytes, fileName: `W-9 ${w.legal_name} ${String(w.signed_on).slice(0, 10)}.pdf` };
    });
  }

  // ----- I-9 ------------------------------------------------------------------------------------------------------

  async getI9(ctx: Ctx, personId: string): Promise<I9Dto | null> {
    return this.db.run(ctx, async (trx) => {
      const p = await this.people.row(trx, ctx, personId);
      await payrollEntity(trx, ctx, p.entity_id);
      const i9 = await this.i9Row(trx, ctx, personId);
      return i9 ? this.i9Dto(trx, ctx, i9) : null;
    });
  }

  /** Section 1: made on the first save. Once Section 2 is signed, Section 1 can't change (start a correction on paper). */
  async saveSection1(ctx: Ctx, personId: string, req: SaveI9Section1Request): Promise<I9Dto> {
    return this.db.run(ctx, async (trx) => {
      const p = await this.people.row(trx, ctx, personId);
      await payrollEntity(trx, ctx, p.entity_id);
      if (p.kind !== 'employee') throw unprocessable('payroll.not_employee', 'An I-9 is for an employee');
      this.checkSection1(req);
      const s = sealer(this.crypto, trx, ctx);
      const existing = await this.i9Row(trx, ctx, personId);
      if (existing?.employer_signed_on) {
        throw new AppError(
          409,
          'payroll.i9_signed',
          'Section 2 is signed, so Section 1 can no longer change',
        );
      }
      if (existing && req.version !== undefined && BigInt(req.version) !== BigInt(existing.version))
        throw conflict();
      // Secret fields that aren't sent keep their value; null clears them.
      const secret = async (column: string, value: string | null | undefined, current: Buffer | null) =>
        value === undefined ? current : await s.seal(`payroll_i9.${column}`, value || null);
      const values = {
        last_name: req.lastName,
        first_name: req.firstName,
        middle_initial: req.middleInitial || null,
        other_last_names: req.otherLastNames || null,
        address: req.address || null,
        apartment: req.apartment || null,
        city: req.city || null,
        state: req.state ?? null,
        zip: req.zip || null,
        birth_date_enc: await secret('birth_date', req.birthDate, existing?.birth_date_enc ?? null),
        ssn_enc: await secret('ssn', req.ssn, existing?.ssn_enc ?? null),
        ssn_last4: req.ssn === undefined ? (existing?.ssn_last4 ?? null) : req.ssn ? lastFour(req.ssn) : null,
        email: req.email ?? null,
        phone: req.phone || null,
        citizenship: req.citizenship,
        a_number_enc: await secret('a_number', req.aNumber, existing?.a_number_enc ?? null),
        work_until: req.citizenship === 'authorized_alien' ? (req.workUntil ?? null) : null,
        i94_number_enc: await secret('i94_number', req.i94Number, existing?.i94_number_enc ?? null),
        passport_number_enc: await secret(
          'passport_number',
          req.passportNumber,
          existing?.passport_number_enc ?? null,
        ),
        passport_country: req.passportCountry || null,
        preparer_name: req.preparerName || null,
        preparer_address: req.preparerAddress || null,
        preparer_signed_on: req.preparerName ? (req.preparerSignedOn ?? req.signedOn) : null,
        employee_signed_name: req.signedName,
        employee_signed_on: req.signedOn,
      };
      if (existing) {
        await trx
          .updateTable('app.payroll_i9')
          .set(values)
          .where('workspace_id', '=', ctx.workspaceId)
          .where('id', '=', existing.id)
          .execute();
      } else {
        await trx
          .insertInto('app.payroll_i9')
          .values({
            workspace_id: ctx.workspaceId,
            id: newId(),
            entity_id: p.entity_id,
            person_id: personId,
            created_by: ctx.userId,
            ...values,
          })
          .execute();
      }
      return this.i9Dto(trx, ctx, (await this.i9Row(trx, ctx, personId))!);
    });
  }

  /** Section 2 needs the documents first: one from List A, or one each from Lists B and C. */
  async saveSection2(ctx: Ctx, personId: string, req: SaveI9Section2Request): Promise<I9Dto> {
    return this.db.run(ctx, async (trx) => {
      const p = await this.people.row(trx, ctx, personId);
      await payrollEntity(trx, ctx, p.entity_id);
      const i9 = await this.i9Row(trx, ctx, personId);
      if (!i9?.employee_signed_on) {
        throw unprocessable('payroll.i9_section1_first', 'Section 1 must be completed and signed first');
      }
      if (BigInt(req.version) !== BigInt(i9.version)) throw conflict();
      const docs = await this.documents(trx, ctx, i9.id);
      const has = (l: string) => docs.some((d) => d.list === l);
      if (!has('A') && !(has('B') && has('C'))) {
        throw unprocessable(
          'payroll.i9_documents',
          'Record the documents examined: one from List A, or one from List B and one from List C',
        );
      }
      await trx
        .updateTable('app.payroll_i9')
        .set({
          first_day: req.firstDay,
          additional_info: req.additionalInfo || null,
          employer_signed_name: req.signedName,
          employer_title: req.title,
          employer_signed_on: req.signedOn,
          employer_business_name: req.businessName,
          employer_business_address: req.businessAddress,
        })
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', i9.id)
        .execute();
      return this.i9Dto(trx, ctx, (await this.i9Row(trx, ctx, personId))!);
    });
  }

  async addDocument(ctx: Ctx, personId: string, req: AddI9DocumentRequest): Promise<I9Dto> {
    return this.db.run(ctx, async (trx) => {
      const p = await this.people.row(trx, ctx, personId);
      await payrollEntity(trx, ctx, p.entity_id);
      const i9 = await this.i9Row(trx, ctx, personId);
      if (!i9) throw unprocessable('payroll.i9_section1_first', 'Start the I-9 with Section 1 first');
      if (i9.employer_signed_on) {
        throw new AppError(409, 'payroll.i9_signed', 'Section 2 is signed; documents can no longer be added');
      }
      const ids = [...new Set(req.fileIds)];
      if (ids.length) {
        const files = await trx
          .selectFrom('app.file')
          .select(['id', 'sealed', 'uploaded_by'])
          .where('workspace_id', '=', ctx.workspaceId)
          .where('id', 'in', ids)
          .where('deleted_at', 'is', null)
          .execute();
        if (files.length !== ids.length || files.some((f) => !f.sealed)) {
          throw unprocessable('payroll.file_not_found', 'Upload the copies through payroll first');
        }
        const { rows } = await sql<{ n: string }>`
          select count(*)::text as n from app.payroll_i9_document
           where workspace_id = ${ctx.workspaceId} and file_ids && ${ids}::uuid[]`.execute(trx);
        if (Number(rows[0]?.n ?? 0) > 0) {
          throw unprocessable('payroll.file_in_use', 'That copy is already on a document');
        }
      }
      const s = sealer(this.crypto, trx, ctx);
      await trx
        .insertInto('app.payroll_i9_document')
        .values({
          workspace_id: ctx.workspaceId,
          id: newId(),
          entity_id: p.entity_id,
          i9_id: i9.id,
          list: req.list,
          title: req.title,
          issuing_authority: req.issuingAuthority || null,
          number_enc: await s.seal('payroll_i9_document.number', req.number || null),
          number_last4: req.number ? lastFour(req.number) : null,
          expires_on: req.expiresOn ?? null,
          file_ids: ids,
          created_by: ctx.userId,
        })
        .execute();
      return this.i9Dto(trx, ctx, i9);
    });
  }

  /** Before Section 2 is signed a document can go freely; afterwards copies follow the retention rule. */
  async removeDocument(ctx: Ctx, personId: string, documentId: string): Promise<I9Dto> {
    return this.db.run(ctx, async (trx) => {
      const p = await this.people.row(trx, ctx, personId);
      const e = await payrollEntity(trx, ctx, p.entity_id);
      const i9 = await this.i9Row(trx, ctx, personId);
      if (!i9) throw notFound('I-9');
      const doc = (await this.documents(trx, ctx, i9.id)).find((d) => d.id === documentId);
      if (!doc) throw notFound('Document');
      if (i9.employer_signed_on) this.assertMayDestroy(p, todayIn(e.timeZone));
      await trx
        .deleteFrom('app.payroll_i9_document')
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', documentId)
        .execute();
      await this.destroyFiles(trx, ctx, doc.file_ids);
      return this.i9Dto(trx, ctx, i9);
    });
  }

  /** Destroys an I-9 and its copies once the retention period is over (ADR-0034 §5). */
  async destroyI9(ctx: Ctx, personId: string): Promise<void> {
    await this.db.run(ctx, async (trx) => {
      const p = await this.people.row(trx, ctx, personId);
      const e = await payrollEntity(trx, ctx, p.entity_id);
      const i9 = await this.i9Row(trx, ctx, personId);
      if (!i9) throw notFound('I-9');
      this.assertMayDestroy(p, todayIn(e.timeZone));
      const docs = await this.documents(trx, ctx, i9.id);
      await trx
        .deleteFrom('app.payroll_i9')
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', i9.id)
        .execute();
      await this.destroyFiles(
        trx,
        ctx,
        docs.flatMap((d) => d.file_ids),
      );
    });
  }

  async i9Pdf(ctx: Ctx, personId: string): Promise<{ bytes: Uint8Array; fileName: string }> {
    return this.db.run(ctx, async (trx) => {
      const p = await this.people.row(trx, ctx, personId);
      await payrollEntity(trx, ctx, p.entity_id);
      const i9 = await this.i9Row(trx, ctx, personId);
      if (!i9) throw notFound('I-9');
      const s = sealer(this.crypto, trx, ctx);
      const docs = await this.documents(trx, ctx, i9.id);
      const ssn = await s.open('payroll_i9.ssn', i9.ssn_enc);
      const bytes = await renderFormPdf(
        i9Doc({
          lastName: i9.last_name,
          firstName: i9.first_name,
          middleInitial: i9.middle_initial,
          otherLastNames: i9.other_last_names,
          address: i9.address,
          apartment: i9.apartment,
          city: i9.city,
          state: i9.state,
          zip: i9.zip,
          birthDate: await s.open('payroll_i9.birth_date', i9.birth_date_enc),
          ssn: formatTin('ssn', ssn),
          email: i9.email,
          phone: i9.phone,
          citizenship: i9.citizenship,
          aNumber: await s.open('payroll_i9.a_number', i9.a_number_enc),
          workUntil: dateOrNull(i9.work_until),
          i94Number: await s.open('payroll_i9.i94_number', i9.i94_number_enc),
          passportNumber: await s.open('payroll_i9.passport_number', i9.passport_number_enc),
          passportCountry: i9.passport_country,
          employeeSignedName: i9.employee_signed_name,
          employeeSignedOn: dateOrNull(i9.employee_signed_on),
          preparer: i9.preparer_name
            ? {
                name: i9.preparer_name,
                address: i9.preparer_address,
                signedOn: dateOrNull(i9.preparer_signed_on),
              }
            : null,
          documents: await Promise.all(
            docs.map(async (d) => ({
              list: d.list,
              title: d.title,
              issuingAuthority: d.issuing_authority,
              number: await s.open('payroll_i9_document.number', d.number_enc),
              expiresOn: dateOrNull(d.expires_on),
            })),
          ),
          firstDay: dateOrNull(i9.first_day),
          additionalInfo: i9.additional_info,
          employerSignedName: i9.employer_signed_name,
          employerTitle: i9.employer_title,
          employerSignedOn: dateOrNull(i9.employer_signed_on),
          businessName: i9.employer_business_name,
          businessAddress: i9.employer_business_address,
        }),
      );
      await auditView(trx, ctx, 'payroll.form_downloaded', 'payroll_person', personId, {
        form: 'i9',
        id: i9.id,
      });
      return { bytes, fileName: `I-9 ${i9.last_name}.pdf` };
    });
  }

  // ----- Files ----------------------------------------------------------------------------------------------------

  /** A copy of an identity document, sealed before it reaches storage (ADR-0034 §3). */
  async uploadFile(
    ctx: Ctx,
    entityId: string,
    bytes: Uint8Array,
    fileName: string,
    purpose: 'identity' | 'receipt' = 'identity',
  ): Promise<PayrollFileDto> {
    const mediaType = detectReceiptMedia(bytes);
    if (!mediaType)
      throw new AppError(415, 'upload.unsupported_type', 'Upload a PDF, or a JPEG, PNG or WebP photo');
    const id = newId();
    // A receipt for a reimbursement is ordinary paperwork; a copy of an ID is sealed (ADR-0034 §3).
    const seal = purpose === 'identity';
    const key = storageKey(ctx.workspaceId, seal ? 'payroll' : 'receipt', id);
    await this.db.run(ctx, async (trx) => {
      await payrollEntity(trx, ctx, entityId);
      if (seal) {
        const sealed = await this.crypto.sealBytes(trx, ctx.workspaceId, id, bytes);
        await this.storage.put(key, sealed, 'application/octet-stream');
      } else {
        await this.storage.put(key, bytes, mediaType);
      }
      await trx
        .insertInto('app.file')
        .values({
          workspace_id: ctx.workspaceId,
          id,
          kind: seal ? 'other' : 'receipt',
          storage_key: key,
          file_name: fileName.replace(/[\\/\0]/g, '_').slice(0, 255) || 'document',
          mime: mediaType,
          bytes: bytes.length,
          sha256: sha256(bytes),
          uploaded_by: ctx.userId,
          sealed: seal,
          retain_until: sql<string>`(current_date + make_interval(years => ${FILE_RETENTION_YEARS}))::date`,
        })
        .execute();
    });
    return { fileId: id, mediaType, bytes: bytes.length };
  }

  /** A copy, served only through the I-9 document it's on, and logged. */
  async documentFile(
    ctx: Ctx,
    personId: string,
    documentId: string,
    fileId: string,
  ): Promise<{ bytes: Uint8Array; mime: string; fileName: string }> {
    return this.db.run(ctx, async (trx) => {
      const p = await this.people.row(trx, ctx, personId);
      await payrollEntity(trx, ctx, p.entity_id);
      const i9 = await this.i9Row(trx, ctx, personId);
      const doc = i9 ? (await this.documents(trx, ctx, i9.id)).find((d) => d.id === documentId) : undefined;
      if (!doc || !doc.file_ids.includes(fileId)) throw notFound('File');
      const f = await trx
        .selectFrom('app.file')
        .select(['storage_key', 'mime', 'file_name', 'sealed'])
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', fileId)
        .executeTakeFirst();
      if (!f) throw notFound('File');
      const stored = await this.storage.get(f.storage_key);
      const bytes = f.sealed ? await this.crypto.openBytes(trx, ctx.workspaceId, fileId, stored) : stored;
      await auditView(trx, ctx, 'payroll.document_viewed', 'payroll_person', personId, {
        document: documentId,
        file: fileId,
      });
      return { bytes, mime: f.mime, fileName: f.file_name };
    });
  }

  // ----- Internals ------------------------------------------------------------------------------------------------

  private checkSection1(req: SaveI9Section1Request): void {
    if (req.citizenship === 'permanent_resident' && req.aNumber === null) {
      throw unprocessable(
        'payroll.i9_a_number',
        'A lawful permanent resident enters their USCIS or A-Number',
      );
    }
    if (req.citizenship === 'authorized_alien' && !req.aNumber && !req.i94Number && !req.passportNumber) {
      // Only checked when the request names them: saving again without the secrets keeps what was stored.
      if (req.aNumber !== undefined || req.i94Number !== undefined || req.passportNumber !== undefined) {
        throw unprocessable(
          'payroll.i9_alien_number',
          'Enter a USCIS A-Number, a Form I-94 admission number, or a foreign passport number and country',
        );
      }
    }
    if (req.passportNumber && !req.passportCountry) {
      throw unprocessable('payroll.i9_passport_country', 'Enter the passport’s country of issuance');
    }
  }

  private assertMayDestroy(p: { hire_date: unknown; end_date: unknown }, today: CalendarDate): void {
    const until = i9RetainUntil(dateOrNull(p.hire_date), dateOrNull(p.end_date));
    if (!i9MayDestroy(until, today)) {
      throw new AppError(
        409,
        'payroll.i9_retained',
        until
          ? `This I-9 and its copies must be kept until ${until}`
          : 'This I-9 and its copies must be kept while the person works here and afterwards',
      );
    }
  }

  private async destroyFiles(trx: Trx, ctx: Ctx, ids: string[]): Promise<void> {
    if (!ids.length) return;
    const files = await trx
      .deleteFrom('app.file')
      .where('workspace_id', '=', ctx.workspaceId)
      .where('id', 'in', ids)
      .where('sealed', '=', true)
      .returning('storage_key')
      .execute();
    for (const f of files) await this.storage.delete(f.storage_key);
  }

  private async employer(trx: Trx, ctx: Ctx, entityId: string, name: string) {
    const b = await trx
      .selectFrom('app.business_profile')
      .select(['legal_name', 'address'])
      .where('workspace_id', '=', ctx.workspaceId)
      .where('entity_id', '=', entityId)
      .executeTakeFirst();
    // ADR-0037: the employer's numbers are the business's registrations.
    const id = await employerIdentity(trx, ctx, entityId);
    return {
      name: b?.legal_name || name,
      address: b?.address ?? null,
      ein: formatEin(id.ein),
      account: formatEddAccount(id.caEmployerAccount),
    };
  }

  private i9Row(trx: Trx, ctx: Ctx, personId: string): Promise<PayrollI9Row | undefined> {
    return trx
      .selectFrom('app.payroll_i9')
      .selectAll()
      .where('workspace_id', '=', ctx.workspaceId)
      .where('person_id', '=', personId)
      .executeTakeFirst();
  }

  private documents(trx: Trx, ctx: Ctx, i9Id: string): Promise<PayrollI9DocumentRow[]> {
    return trx
      .selectFrom('app.payroll_i9_document')
      .selectAll()
      .where('workspace_id', '=', ctx.workspaceId)
      .where('i9_id', '=', i9Id)
      .orderBy('list')
      .orderBy('created_at')
      .execute();
  }

  private async i9Dto(trx: Trx, ctx: Ctx, r: PayrollI9Row): Promise<I9Dto> {
    const p = await this.people.row(trx, ctx, r.person_id);
    const e = await payrollEntity(trx, ctx, r.entity_id);
    const docs = await this.documents(trx, ctx, r.id);
    const fileIds = docs.flatMap((d) => d.file_ids);
    const files = fileIds.length
      ? await trx
          .selectFrom('app.file')
          .select(['id', 'file_name', 'mime', 'bytes'])
          .where('workspace_id', '=', ctx.workspaceId)
          .where('id', 'in', fileIds)
          .execute()
      : [];
    const byId = new Map(files.map((f) => [f.id, f]));
    const documents: I9DocumentDto[] = docs.map((d) => ({
      id: d.id,
      list: d.list,
      title: d.title,
      issuingAuthority: d.issuing_authority,
      numberMasked: maskTail(d.number_last4),
      expiresOn: dateOrNull(d.expires_on),
      files: d.file_ids.flatMap((id) => {
        const f = byId.get(id);
        return f ? [{ id, fileName: f.file_name, mime: f.mime, bytes: Number(f.bytes) }] : [];
      }),
    }));
    const retainUntil = i9RetainUntil(dateOrNull(p.hire_date), dateOrNull(p.end_date));
    const firstDay = dateOrNull(r.first_day) ?? dateOrNull(p.hire_date);
    return {
      id: r.id,
      personId: r.person_id,
      section1: {
        lastName: r.last_name,
        firstName: r.first_name,
        middleInitial: r.middle_initial,
        otherLastNames: r.other_last_names,
        address: r.address,
        apartment: r.apartment,
        city: r.city,
        state: r.state,
        zip: r.zip,
        hasBirthDate: r.birth_date_enc !== null,
        ssnMasked: maskTin('ssn', r.ssn_last4),
        email: r.email,
        phone: r.phone,
        citizenship: r.citizenship,
        hasANumber: r.a_number_enc !== null,
        workUntil: dateOrNull(r.work_until),
        hasI94Number: r.i94_number_enc !== null,
        hasPassportNumber: r.passport_number_enc !== null,
        passportCountry: r.passport_country,
        signedName: r.employee_signed_name,
        signedOn: dateOrNull(r.employee_signed_on),
        preparerName: r.preparer_name,
        preparerAddress: r.preparer_address,
        preparerSignedOn: dateOrNull(r.preparer_signed_on),
      },
      section2: {
        firstDay: dateOrNull(r.first_day),
        additionalInfo: r.additional_info,
        signedName: r.employer_signed_name,
        title: r.employer_title,
        signedOn: dateOrNull(r.employer_signed_on),
        businessName: r.employer_business_name,
        businessAddress: r.employer_business_address,
      },
      documents,
      status: {
        id: r.id,
        section1: r.employee_signed_on !== null,
        section2: r.employer_signed_on !== null,
        documents: docs.length,
        section2Due: firstDay ? i9Section2Due(firstDay) : null,
        retainUntil,
        mayDestroy: i9MayDestroy(retainUntil, todayIn(e.timeZone)),
      },
      version: Number(r.version),
    };
  }
}
