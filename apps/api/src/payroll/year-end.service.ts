/**
 * Year-end forms (PRL-17..20; ADR-0034 §7b): W-2s and the W-3 from the year's approved paychecks, 1099-NECs and the 1096
 * from paid bills to contractors, and SSA's EFW2 wage file. Worked out each time from the records, never stored. The
 * people's copies carry truncated SSNs and TINs; the full numbers leave only on the employer's copies and the EFW2 file,
 * each logged.
 */
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import {
  efw2File,
  efw2Problems,
  necThreshold,
  yearEndDue,
  type Efw2Input,
  type W2Boxes,
} from '@montra/domain';
import type { PayrollPersonRow, Trx } from '@montra/db';
import type { W2BoxesDto, YearEndDto } from '@montra/schemas';
import { AppError } from '../common/errors.js';
import { FieldCrypto } from '../crypto/crypto.service.js';
import { Db } from '../db/database.js';
import type { BusinessEntity } from '../business/shared.js';
import { formatTin } from './form-pdf.js';
import { basesFor, PayrollTaxesService, type PaidCheck } from './payroll-taxes.service.js';
import { auditView, formatAddress, payrollEntity, personName, sealer, type Ctx } from './shared.js';
import { combinedPdf, form1096Doc, necDoc, w2Doc, w3Doc, type Party } from './year-end-pdf.js';

const ZERO: W2Boxes = {
  box1: 0n,
  box2: 0n,
  box3: 0n,
  box4: 0n,
  box5: 0n,
  box6: 0n,
  box12D: 0n,
  retirementPlan: false,
  caSdi: 0n,
  caWages: 0n,
  caTax: 0n,
};

const boxesDto = (b: W2Boxes): W2BoxesDto => ({
  box1: String(b.box1),
  box2: String(b.box2),
  box3: String(b.box3),
  box4: String(b.box4),
  box5: String(b.box5),
  box6: String(b.box6),
  box12D: String(b.box12D),
  retirementPlan: b.retirementPlan,
  caSdi: String(b.caSdi),
  caWages: String(b.caWages),
  caTax: String(b.caTax),
});

function addBoxes(a: W2Boxes, b: W2Boxes): W2Boxes {
  return {
    box1: a.box1 + b.box1,
    box2: a.box2 + b.box2,
    box3: a.box3 + b.box3,
    box4: a.box4 + b.box4,
    box5: a.box5 + b.box5,
    box6: a.box6 + b.box6,
    box12D: a.box12D + b.box12D,
    retirementPlan: a.retirementPlan || b.retirementPlan,
    caSdi: a.caSdi + b.caSdi,
    caWages: a.caWages + b.caWages,
    caTax: a.caTax + b.caTax,
  };
}

const truncated = (last4: string | null) => (last4 ? `XXX-XX-${last4}` : null);
const ein = (v: string | null | undefined) => (v ? `${v.slice(0, 2)}-${v.slice(2)}` : null);
const eddAccount = (v: string | null | undefined) =>
  v ? `${v.slice(0, 3)}-${v.slice(3, 7)}-${v.slice(7)}` : null;

interface Employer {
  name: string;
  address: string | null;
  settings: Awaited<ReturnType<PayrollTaxesService['settings']>>;
  raw: {
    ein: string | null;
    caAccount: string | null;
    filing: { line1: string; line2: string | null; city: string; state: string; zip: string } | null;
  };
}

interface W2Person {
  person: PayrollPersonRow;
  boxes: W2Boxes;
  paychecks: number;
  ca: boolean;
}

interface NecPerson {
  person: PayrollPersonRow;
  amount: bigint;
  payments: number;
  w9: {
    legal_name: string;
    business_name: string | null;
    address: string;
    tin_type: string;
    tin_last4: string;
    id: string;
  } | null;
}

@Injectable()
export class YearEndService {
  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(FieldCrypto) private readonly crypto: FieldCrypto,
    @Inject(PayrollTaxesService) private readonly taxes: PayrollTaxesService,
  ) {}

  async summary(ctx: Ctx, entityId: string, year: number): Promise<YearEndDto> {
    const settings = await this.taxes.settings(ctx, entityId);
    // SSA's SSN rules need the full numbers, so the check runs on them; the summary never returns them.
    const efw2 = await this.efw2Data(ctx, entityId, year, false);
    return this.db.run(ctx, async (trx) => {
      const e = await payrollEntity(trx, ctx, entityId);
      const employer = await this.employer(trx, ctx, e, settings);
      const w2s = await this.w2People(trx, ctx, entityId, year);
      const necs = await this.necPeople(trx, ctx, entityId, year);
      const threshold = necThreshold(year);
      const due = necs.filter((n) => n.amount >= threshold.amount);
      const notes: string[] = [];
      if (!threshold.known) {
        notes.push(
          `Montra doesn’t have the ${year} 1099-NEC threshold yet (it’s indexed for inflation from 2027), so ${year - 1}’s is used.`,
        );
      }
      if (w2s.some((w) => w.boxes.box12D > 0n)) {
        notes.push(
          'Before-tax retirement deductions are reported as box 12 code D, a 401(k). Change it if your plan is a different kind.',
        );
      }
      for (const n of due)
        if (!n.w9) notes.push(`${personName(n.person)} has no W-9: get one before filing their 1099-NEC.`);
      return {
        entityId,
        year,
        employer: {
          name: employer.name,
          ein: ein(employer.raw.ein),
          caEmployerAccount: eddAccount(employer.raw.caAccount),
        },
        w2s: w2s.map((w) => ({
          personId: w.person.id,
          name: personName(w.person),
          tinMasked: truncated(w.person.tin_last4),
          boxes: boxesDto(w.boxes),
          paychecks: w.paychecks,
        })),
        w3: { forms: w2s.length, boxes: boxesDto(w2s.reduce((t, w) => addBoxes(t, w.boxes), ZERO)) },
        necThreshold: { amount: String(threshold.amount), known: threshold.known },
        necs: necs.map((n) => ({
          personId: n.person.id,
          name: n.w9 ? n.w9.business_name || n.w9.legal_name : personName(n.person),
          tinMasked: truncated(n.w9?.tin_last4 ?? n.person.tin_last4),
          nonemployeeCompensation: String(n.amount),
          payments: n.payments,
          required: n.amount >= threshold.amount,
          hasW9: n.w9 !== null,
        })),
        form1096: { forms: due.length, total: String(due.reduce((t, n) => t + n.amount, 0n)) },
        dueDate: yearEndDue(year),
        efw2Problems: efw2.problems,
        notes,
      };
    });
  }

  /** An employee's copies B, C and 2, with the SSN truncated. */
  async w2EmployeePdf(ctx: Ctx, entityId: string, year: number, personId: string) {
    const settings = await this.taxes.settings(ctx, entityId);
    return this.db.run(ctx, async (trx) => {
      const e = await payrollEntity(trx, ctx, entityId);
      const employer = await this.employer(trx, ctx, e, settings);
      const w = (await this.w2People(trx, ctx, entityId, year)).find((x) => x.person.id === personId);
      if (!w) throw new AppError(404, 'not_found', 'No W-2 for this person and year');
      const employee: Party = {
        name: personName(w.person),
        address: formatAddress(w.person),
        tin: truncated(w.person.tin_last4),
      };
      const docs = (['B', 'C', '2'] as const).map((copy) =>
        w2Doc({
          year,
          copy,
          employer: this.party(employer),
          employee,
          boxes: w.boxes,
          state: w.ca ? 'CA' : null,
        }),
      );
      await auditView(trx, ctx, 'payroll.form_downloaded', 'payroll_person', personId, { form: 'w2', year });
      return { bytes: await combinedPdf(docs), fileName: `W-2 ${year} ${w.person.last_name}.pdf` };
    });
  }

  /** Copy D of every W-2, with full SSNs, and the W-3. */
  async w2EmployerPdf(ctx: Ctx, entityId: string, year: number) {
    const settings = await this.taxes.settings(ctx, entityId);
    return this.db.run(ctx, async (trx) => {
      const e = await payrollEntity(trx, ctx, entityId);
      const employer = await this.employer(trx, ctx, e, settings);
      const w2s = await this.w2People(trx, ctx, entityId, year);
      if (!w2s.length) throw new AppError(404, 'not_found', 'No W-2s for this year');
      const s = sealer(this.crypto, trx, ctx);
      const docs = [];
      for (const w of w2s) {
        const ssn = await s.open('payroll_person.tin', w.person.tin_enc);
        docs.push(
          w2Doc({
            year,
            copy: 'D',
            employer: this.party(employer),
            employee: {
              name: personName(w.person),
              address: formatAddress(w.person),
              tin: formatTin('ssn', ssn),
            },
            boxes: w.boxes,
            state: w.ca ? 'CA' : null,
          }),
        );
      }
      docs.push(
        w3Doc({
          year,
          employer: this.party(employer),
          forms: w2s.length,
          boxes: w2s.reduce((t, w) => addBoxes(t, w.boxes), ZERO),
        }),
      );
      await auditView(trx, ctx, 'payroll.form_downloaded', 'entity', entityId, { form: 'w2_employer', year });
      return { bytes: await combinedPdf(docs), fileName: `W-2 and W-3 ${year} employer copies.pdf` };
    });
  }

  /** A contractor's copies B and 2, with the TIN truncated. */
  async necRecipientPdf(ctx: Ctx, entityId: string, year: number, personId: string) {
    const settings = await this.taxes.settings(ctx, entityId);
    return this.db.run(ctx, async (trx) => {
      const e = await payrollEntity(trx, ctx, entityId);
      const employer = await this.employer(trx, ctx, e, settings);
      const n = (await this.necPeople(trx, ctx, entityId, year)).find((x) => x.person.id === personId);
      if (!n || n.amount === 0n)
        throw new AppError(404, 'not_found', 'No payments to this contractor in the year');
      const recipient = this.recipient(n, n.w9 ? truncated(n.w9.tin_last4) : truncated(n.person.tin_last4));
      const docs = (['B', '2'] as const).map((copy) =>
        necDoc(this.necCopy(year, copy, employer, recipient, n.amount)),
      );
      await auditView(trx, ctx, 'payroll.form_downloaded', 'payroll_person', personId, {
        form: '1099nec',
        year,
      });
      return { bytes: await combinedPdf(docs), fileName: `1099-NEC ${year} ${n.person.last_name}.pdf` };
    });
  }

  /** Copy C of each 1099-NEC that's due, with full TINs, and the 1096 worksheet. */
  async necPayerPdf(ctx: Ctx, entityId: string, year: number) {
    const settings = await this.taxes.settings(ctx, entityId);
    return this.db.run(ctx, async (trx) => {
      const e = await payrollEntity(trx, ctx, entityId);
      const employer = await this.employer(trx, ctx, e, settings);
      const threshold = necThreshold(year).amount;
      const due = (await this.necPeople(trx, ctx, entityId, year)).filter((n) => n.amount >= threshold);
      if (!due.length) throw new AppError(404, 'not_found', 'No 1099-NECs are due for this year');
      const s = sealer(this.crypto, trx, ctx);
      const docs = [];
      for (const n of due) {
        const tin = n.w9
          ? formatTin(
              n.w9.tin_type as 'ssn',
              await s.open('payroll_w9.tin', (await this.w9Tin(trx, ctx, n.w9.id)) ?? null),
            )
          : formatTin(
              (n.person.tin_type ?? 'ssn') as 'ssn',
              await s.open('payroll_person.tin', n.person.tin_enc),
            );
        docs.push(necDoc(this.necCopy(year, 'C', employer, this.recipient(n, tin), n.amount)));
      }
      docs.push(
        form1096Doc({
          year,
          payer: {
            ...this.party(employer),
            phone: employer.settings.contactPhone,
            contact: employer.settings.contactName,
            email: employer.settings.contactEmail,
          },
          forms: due.length,
          total: due.reduce((t, n) => t + n.amount, 0n),
        }),
      );
      await auditView(trx, ctx, 'payroll.form_downloaded', 'entity', entityId, {
        form: '1099nec_payer',
        year,
      });
      return { bytes: await combinedPdf(docs), fileName: `1099-NEC and 1096 ${year} payer copies.pdf` };
    });
  }

  /** The EFW2 file for SSA Business Services Online, refused while anything in it would be rejected. */
  async efw2(ctx: Ctx, entityId: string, year: number): Promise<{ text: string; fileName: string }> {
    const { problems, input } = await this.efw2Data(ctx, entityId, year, true);
    if (problems.length) {
      throw new AppError(
        422,
        'payroll.efw2_problems',
        problems.map((p) => `${p.where}: ${p.message}`).join(' '),
      );
    }
    await this.db.run(ctx, (trx) =>
      auditView(trx, ctx, 'payroll.form_downloaded', 'entity', entityId, { form: 'efw2', year }),
    );
    return { text: efw2File(input!), fileName: `W2REPORT ${year}.txt` };
  }

  // ----- Internals --------------------------------------------------------------------------------------------------

  private async efw2Data(ctx: Ctx, entityId: string, year: number, forFile: boolean) {
    const settings = await this.taxes.settings(ctx, entityId);
    return this.db.run(ctx, async (trx) => {
      const e = await payrollEntity(trx, ctx, entityId);
      const employer = await this.employer(trx, ctx, e, settings);
      const w2s = await this.w2People(trx, ctx, entityId, year);
      const s = sealer(this.crypto, trx, ctx);
      const ssns = new Map<string, string>();
      for (const w of w2s)
        ssns.set(w.person.id, (await s.open('payroll_person.tin', w.person.tin_enc)) ?? '');
      const input = this.efw2Input(employer, w2s, year, (p) => ssns.get(p.id) ?? '');
      const problems = w2s.length
        ? efw2Problems(input).map((p) => ({
            where: typeof p.where === 'number' ? personName(w2s[p.where]!.person) : p.where,
            message: p.message,
          }))
        : [{ where: 'employer', message: 'There are no W-2s for this year.' }];
      return { problems, input: forFile ? input : null };
    });
  }

  private efw2Input(
    employer: Employer,
    w2s: W2Person[],
    year: number,
    ssnOf: (p: PayrollPersonRow) => string,
  ): Efw2Input {
    const f = employer.raw.filing;
    const address = f ?? { line1: '', line2: null, city: '', state: '', zip: '' };
    return {
      year,
      submitter: {
        ein: employer.raw.ein ?? '',
        userId: employer.settings.ssaUserId ?? '',
        name: employer.name,
        address,
        contactName: employer.settings.contactName ?? '',
        contactPhone: employer.settings.contactPhone ?? '',
        contactEmail: employer.settings.contactEmail ?? '',
      },
      employer: { ein: employer.raw.ein ?? '', name: employer.name, address },
      employees: w2s.map((w) => ({
        ssn: ssnOf(w.person),
        first: w.person.first_name,
        middle: w.person.middle_name,
        last: w.person.last_name,
        address: w.person.address_line1
          ? {
              line1: w.person.address_line1,
              line2: w.person.address_line2,
              city: w.person.city ?? '',
              state: w.person.region ?? '',
              zip: w.person.postal_code ?? '',
            }
          : null,
        boxes: w.boxes,
      })),
    };
  }

  private async employer(
    trx: Trx,
    ctx: Ctx,
    e: BusinessEntity,
    settings: Employer['settings'],
  ): Promise<Employer> {
    const profile = await trx
      .selectFrom('app.business_profile')
      .select(['legal_name', 'address'])
      .where('workspace_id', '=', ctx.workspaceId)
      .where('entity_id', '=', e.id)
      .executeTakeFirst();
    const f = settings.filingAddress;
    return {
      name: profile?.legal_name || e.name,
      address: f
        ? [[f.line1, f.line2].filter(Boolean).join(', '), `${f.city}, ${f.state} ${f.zip}`].join('\n')
        : (profile?.address ?? null),
      settings,
      raw: { ein: settings.ein, caAccount: settings.caEmployerAccount, filing: f },
    };
  }

  private party(employer: Employer): Party & { caAccount: string | null } {
    return {
      name: employer.name,
      address: employer.address,
      tin: ein(employer.raw.ein),
      caAccount: eddAccount(employer.raw.caAccount),
    };
  }

  private recipient(n: NecPerson, tin: string | null): Party {
    return n.w9
      ? { name: [n.w9.legal_name, n.w9.business_name].filter(Boolean).join('\n'), address: n.w9.address, tin }
      : { name: personName(n.person), address: formatAddress(n.person), tin };
  }

  private necCopy(year: number, copy: 'B' | '2' | 'C', employer: Employer, recipient: Party, amount: bigint) {
    return {
      year,
      copy,
      payer: { ...this.party(employer), phone: employer.settings.contactPhone },
      recipient,
      amount,
      state: 'CA' as const,
      stateAccount: eddAccount(employer.raw.caAccount),
    };
  }

  private async w9Tin(trx: Trx, ctx: Ctx, id: string): Promise<Buffer | null> {
    const r = await trx
      .selectFrom('app.payroll_w9')
      .select('tin_enc')
      .where('workspace_id', '=', ctx.workspaceId)
      .where('id', '=', id)
      .executeTakeFirst();
    return r?.tin_enc ?? null;
  }

  /** Each employee paid in the year, with their W-2 boxes. */
  private async w2People(trx: Trx, ctx: Ctx, entityId: string, year: number): Promise<W2Person[]> {
    const checks = await this.taxes.paidChecks(trx, ctx, entityId, year);
    if (!checks.length) return [];
    const bases = basesFor(checks, year);
    const people = await trx
      .selectFrom('app.payroll_person')
      .selectAll()
      .where('workspace_id', '=', ctx.workspaceId)
      .where('id', 'in', [...new Set(checks.map((c) => c.personId))])
      .execute();
    const byPerson = new Map<string, PaidCheck[]>();
    for (const c of checks) byPerson.set(c.personId, [...(byPerson.get(c.personId) ?? []), c]);
    const out: W2Person[] = [];
    for (const p of people.sort((a, b) => personName(a).localeCompare(personName(b)))) {
      const mine = byPerson.get(p.id) ?? [];
      const tax = (code: string) => mine.reduce((t, c) => t + (c.taxes.get(code) ?? 0n), 0n);
      const sum = (f: (c: PaidCheck) => bigint) => mine.reduce((t, c) => t + f(c), 0n);
      const ca = mine.filter((c) => c.workState === 'CA');
      out.push({
        person: p,
        paychecks: mine.length,
        ca: ca.length > 0,
        boxes: {
          box1: sum((c) => bases.get(c)!.income),
          box2: tax('fit'),
          box3: sum((c) => bases.get(c)!.ss),
          box4: tax('ss'),
          box5: sum((c) => bases.get(c)!.employment),
          box6: tax('medicare') + tax('addl_medicare'),
          box12D: sum((c) => c.wages.retirement),
          retirementPlan: sum((c) => c.wages.retirement) > 0n,
          caSdi: tax('ca_sdi'),
          caWages: ca.reduce((t, c) => t + bases.get(c)!.income, 0n),
          caTax: tax('ca_pit'),
        },
      });
    }
    return out;
  }

  /** Each contractor paid through bills in the year, by payment date; card payments are on a 1099-K instead. */
  private async necPeople(trx: Trx, ctx: Ctx, entityId: string, year: number): Promise<NecPerson[]> {
    const { rows } = await sql<{ party_id: string; amount: string; payments: number }>`
      select b.party_id, sum(b.amount_minor)::text as amount, count(*)::int as payments
        from app.bill b
        join app.transaction t on t.workspace_id = b.workspace_id and t.id = b.transaction_id
        left join app.bank_account ba
          on ba.workspace_id = t.workspace_id and ba.ledger_account_id = (t.spec->>'accountId')::uuid
       where b.workspace_id = ${ctx.workspaceId} and b.entity_id = ${entityId} and b.status = 'paid'
         and t.deleted_at is null and t.status = 'posted'
         and t.txn_date between ${`${year}-01-01`}::date and ${`${year}-12-31`}::date
         and coalesce(ba.kind, '') <> 'credit_card'
       group by b.party_id`.execute(trx);
    if (!rows.length) return [];
    const people = await trx
      .selectFrom('app.payroll_person')
      .selectAll()
      .where('workspace_id', '=', ctx.workspaceId)
      .where('entity_id', '=', entityId)
      .where('kind', '=', 'contractor')
      .where(
        'vendor_party_id',
        'in',
        rows.map((r) => r.party_id),
      )
      .execute();
    const out: NecPerson[] = [];
    for (const p of people.sort((a, b) => personName(a).localeCompare(personName(b)))) {
      const r = rows.find((x) => x.party_id === p.vendor_party_id)!;
      const w9 = await trx
        .selectFrom('app.payroll_w9')
        .select(['id', 'legal_name', 'business_name', 'address', 'tin_type', 'tin_last4'])
        .where('workspace_id', '=', ctx.workspaceId)
        .where('person_id', '=', p.id)
        .orderBy('signed_on', 'desc')
        .executeTakeFirst();
      out.push({ person: p, amount: BigInt(r.amount), payments: r.payments, w9: w9 ?? null });
    }
    return out;
  }
}
