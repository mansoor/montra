/**
 * Tax forms received (ADR-0052): typing a form in, listing a year's forms, changing, deleting to the Trash, and
 * waivers for expected forms that won't come. Row-level security decides who sees and writes a form (§8.4): the
 * person it's for, owners and admins, and accountants while the owner's setting is on. Reading files, matching and the
 * checks against the books come in later PRs.
 */
import { Inject, Injectable } from '@nestjs/common';
import { newId, type TaxFormRow, type TaxFormTargetRow, type TaxFormWaiverRow, type Trx } from '@montra/db';
import { normalizeTaxFormBoxes, TaxFormBoxesError, type TaxFormKind } from '@montra/domain';
import type {
  CreateTaxFormRequest,
  CreateTaxFormWaiverRequest,
  TaxFormDto,
  TaxFormReason,
  TaxFormStatus,
  TaxFormWaiverDto,
  TaxYearDto,
  UpdateTaxFormRequest,
} from '@montra/schemas';
import { Db } from '../db/database.js';
import { AppError, forbidden, notFound, unprocessable } from '../common/errors.js';

type Ctx = { workspaceId: string; userId: string };

/** Everyone but viewers handles tax forms; row-level security narrows it to the forms each can read (§8.4). */
export const TAX_FORM_WRITERS = ['owner', 'admin', 'partner', 'member', 'accountant'] as const;

type Target = { employerId: string } | { accountId: string };

const conflict = () =>
  new AppError(409, 'version.conflict', 'Someone else changed this form; reload and try again');

@Injectable()
export class TaxFormsService {
  constructor(@Inject(Db) private readonly db: Db) {}

  /** A year's forms (not those in the Trash) and its waivers. */
  async year(ctx: Ctx, year: number): Promise<TaxYearDto> {
    return this.db.run(ctx, async (trx) => {
      const forms = await trx
        .selectFrom('app.tax_form')
        .selectAll()
        .where('workspace_id', '=', ctx.workspaceId)
        .where('tax_year', '=', year)
        .where('deleted_at', 'is', null)
        .orderBy('kind')
        .orderBy('issuer_name')
        .orderBy('created_at')
        .execute();
      const targets = await this.targetsOf(
        trx,
        ctx,
        forms.map((f) => f.id),
      );
      const waivers = await trx
        .selectFrom('app.tax_form_waiver')
        .selectAll()
        .where('workspace_id', '=', ctx.workspaceId)
        .where('tax_year', '=', year)
        .orderBy('kind')
        .orderBy('created_at')
        .execute();
      return {
        year,
        forms: forms.map((f) => toDto(f, targets.get(f.id) ?? [])),
        waivers: waivers.map(waiverDto),
      };
    });
  }

  async get(ctx: Ctx, id: string): Promise<TaxFormDto> {
    return this.db.run(ctx, (trx) => this.read(trx, ctx, id));
  }

  /** A form typed in, with no file (TAX-01). */
  async create(ctx: Ctx, req: CreateTaxFormRequest): Promise<TaxFormDto> {
    return this.db.run(ctx, async (trx) => {
      const boxes = checkedBoxes(req.kind, req.boxes);
      const placed = await this.place(trx, ctx, req.kind, req.targets ?? [], req.personMemberId);
      checkIssuerTin(req.issuerEin ?? null, req.issuerTinLast4 ?? null);
      const supersedesId = req.supersedesId ?? null;
      if (supersedesId) await this.checkSupersedes(trx, ctx, supersedesId, req.kind, null);
      const id = newId();
      const { status, reason } = typedStatus(placed.targets.length > 0, placed.personMemberId !== null);
      await trx
        .insertInto('app.tax_form')
        .values({
          workspace_id: ctx.workspaceId,
          id,
          entity_id: placed.entityId,
          tax_year: req.taxYear,
          kind: req.kind,
          corrected: req.corrected ?? false,
          supersedes_id: supersedesId,
          issuer_name: req.issuerName ?? null,
          issuer_ein: req.issuerEin ?? null,
          issuer_tin_last4: req.issuerTinLast4 ?? null,
          person_tin_last4: req.personTinLast4 ?? null,
          account_last4: req.accountLast4 ?? null,
          person_member_id: placed.personMemberId,
          boxes: JSON.stringify(boxes),
          status,
          reason,
          source: 'typed',
          created_by: ctx.userId,
          // Typed in by a person: the reading is theirs.
          confirmed_by: status === 'confirmed' ? ctx.userId : null,
          confirmed_at: status === 'confirmed' ? new Date() : null,
        })
        .execute();
      await this.writeTargets(trx, ctx, id, placed.targets);
      if (supersedesId) await this.supersede(trx, ctx, supersedesId);
      return this.read(trx, ctx, id);
    });
  }

  /** Changes what a form says or what it's matched to. The boxes replace the old ones whole. */
  async update(ctx: Ctx, id: string, req: UpdateTaxFormRequest): Promise<TaxFormDto> {
    return this.db.run(ctx, async (trx) => {
      const form = await this.row(trx, ctx, id);
      if (form.deleted_at) throw notFound('Tax form');
      if (BigInt(form.version) !== BigInt(req.version)) throw conflict();
      const boxes = req.boxes !== undefined ? checkedBoxes(form.kind, req.boxes) : undefined;
      const current = await this.targetsOf(trx, ctx, [id]);
      const targets: Target[] =
        req.targets ??
        (current.get(id) ?? []).map((t) =>
          t.employer_id ? { employerId: t.employer_id } : { accountId: t.account_id! },
        );
      const person = req.personMemberId !== undefined ? req.personMemberId : form.person_member_id;
      const placed = await this.place(trx, ctx, form.kind, targets, person);
      const issuerEin = req.issuerEin !== undefined ? req.issuerEin : form.issuer_ein;
      const issuerTinLast4 = req.issuerTinLast4 !== undefined ? req.issuerTinLast4 : form.issuer_tin_last4;
      checkIssuerTin(issuerEin, issuerTinLast4);
      const supersedesId = req.supersedesId !== undefined ? req.supersedesId : form.supersedes_id;
      if (supersedesId && supersedesId !== form.supersedes_id)
        await this.checkSupersedes(trx, ctx, supersedesId, form.kind, id);

      let status: TaxFormStatus = form.status;
      let reason: string | null = form.reason;
      if (req.dismissed === true) {
        status = 'dismissed';
      } else if (form.status !== 'superseded' && form.status !== 'reading') {
        // Typed forms are confirmed once they're matched; others stay as their reading left them until PR 3.
        if (form.source === 'typed' || form.status === 'dismissed') {
          ({ status, reason } = typedStatus(placed.targets.length > 0, placed.personMemberId !== null));
        }
      }
      const confirmedNow = status === 'confirmed' && form.status !== 'confirmed';
      const updated = await trx
        .updateTable('app.tax_form')
        .set({
          entity_id: placed.entityId,
          tax_year: req.taxYear ?? form.tax_year,
          corrected: req.corrected ?? form.corrected,
          supersedes_id: supersedesId,
          issuer_name: req.issuerName !== undefined ? req.issuerName : form.issuer_name,
          issuer_ein: issuerEin,
          issuer_tin_last4: issuerTinLast4,
          person_tin_last4: req.personTinLast4 !== undefined ? req.personTinLast4 : form.person_tin_last4,
          account_last4: req.accountLast4 !== undefined ? req.accountLast4 : form.account_last4,
          person_member_id: placed.personMemberId,
          ...(boxes !== undefined ? { boxes: JSON.stringify(boxes) } : {}),
          status,
          reason,
          ...(confirmedNow ? { confirmed_by: ctx.userId, confirmed_at: new Date() } : {}),
          ...(status !== 'confirmed' ? { confirmed_by: null, confirmed_at: null } : {}),
        })
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', id)
        .where('version', '=', form.version)
        .executeTakeFirst();
      // Changed meanwhile, or readable but not writable (a viewer's own form).
      if (!updated.numUpdatedRows) {
        const now = await this.row(trx, ctx, id);
        throw BigInt(now.version) !== BigInt(form.version) ? conflict() : forbidden();
      }
      if (req.targets !== undefined) {
        await trx
          .deleteFrom('app.tax_form_target')
          .where('workspace_id', '=', ctx.workspaceId)
          .where('tax_form_id', '=', id)
          .execute();
        await this.writeTargets(trx, ctx, id, placed.targets);
      }
      if (supersedesId && supersedesId !== form.supersedes_id) await this.supersede(trx, ctx, supersedesId);
      return this.read(trx, ctx, id);
    });
  }

  /** To the Trash for 30 days (BAK-06); restored from Settings → Your data. */
  async remove(ctx: Ctx, id: string): Promise<void> {
    await this.db.run(ctx, async (trx) => {
      const form = await this.row(trx, ctx, id);
      if (form.deleted_at) return;
      const res = await trx
        .updateTable('app.tax_form')
        .set({ deleted_at: new Date() })
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', id)
        .executeTakeFirst();
      if (!res.numUpdatedRows) throw forbidden();
    });
  }

  /** An expected form that won't come (§7.1). A W-2's is for its employer's member; an account's for whom it names. */
  async createWaiver(ctx: Ctx, req: CreateTaxFormWaiverRequest): Promise<TaxFormWaiverDto> {
    return this.db.run(ctx, async (trx) => {
      let entityId: string;
      let person: string | null;
      if (req.employerId) {
        const employer = await this.employer(trx, ctx, req.employerId);
        entityId = employer.entity_id;
        person = employer.member_id;
        if (req.personMemberId && req.personMemberId !== person) {
          throw unprocessable('tax_form.person_conflict', 'A W-2 is for its employer’s person');
        }
      } else {
        const account = await this.account(trx, ctx, req.accountId!);
        entityId = account.entity_id;
        person = req.personMemberId !== undefined ? req.personMemberId : account.default_member_id;
      }
      if (person) await this.member(trx, ctx, person);
      const id = newId();
      await trx
        .insertInto('app.tax_form_waiver')
        .values({
          workspace_id: ctx.workspaceId,
          id,
          entity_id: entityId,
          tax_year: req.taxYear,
          kind: req.kind,
          employer_id: req.employerId ?? null,
          account_id: req.accountId ?? null,
          person_member_id: person,
          reason: req.reason,
          note: req.note ?? null,
          created_by: ctx.userId,
        })
        .execute();
      const row = await trx
        .selectFrom('app.tax_form_waiver')
        .selectAll()
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', id)
        .executeTakeFirstOrThrow();
      return waiverDto(row);
    });
  }

  async removeWaiver(ctx: Ctx, id: string): Promise<void> {
    await this.db.run(ctx, async (trx) => {
      const res = await trx
        .deleteFrom('app.tax_form_waiver')
        .where('workspace_id', '=', ctx.workspaceId)
        .where('id', '=', id)
        .executeTakeFirst();
      if (!res.numDeletedRows) throw notFound('Waiver');
    });
  }

  // ----- Inside a transaction -------------------------------------------------------------------------------------

  private async row(trx: Trx, ctx: Ctx, id: string): Promise<TaxFormRow> {
    const form = await trx
      .selectFrom('app.tax_form')
      .selectAll()
      .where('workspace_id', '=', ctx.workspaceId)
      .where('id', '=', id)
      .executeTakeFirst();
    if (!form) throw notFound('Tax form');
    return form;
  }

  private async read(trx: Trx, ctx: Ctx, id: string): Promise<TaxFormDto> {
    const form = await this.row(trx, ctx, id);
    const targets = await this.targetsOf(trx, ctx, [id]);
    return toDto(form, targets.get(id) ?? []);
  }

  private async targetsOf(trx: Trx, ctx: Ctx, ids: string[]): Promise<Map<string, TaxFormTargetRow[]>> {
    const byForm = new Map<string, TaxFormTargetRow[]>();
    if (ids.length === 0) return byForm;
    const rows = await trx
      .selectFrom('app.tax_form_target')
      .selectAll()
      .where('workspace_id', '=', ctx.workspaceId)
      .where('tax_form_id', 'in', ids)
      .orderBy('id')
      .execute();
    for (const r of rows) byForm.set(r.tax_form_id, [...(byForm.get(r.tax_form_id) ?? []), r]);
    return byForm;
  }

  private async writeTargets(trx: Trx, ctx: Ctx, formId: string, targets: Target[]): Promise<void> {
    if (targets.length === 0) return;
    await trx
      .insertInto('app.tax_form_target')
      .values(
        targets.map((t) => ({
          workspace_id: ctx.workspaceId,
          // Time-ordered ids keep the targets in the order they were given.
          id: newId(),
          tax_form_id: formId,
          employer_id: 'employerId' in t ? t.employerId : null,
          account_id: 'accountId' in t ? t.accountId : null,
        })),
      )
      .execute();
  }

  /**
   * Where a form goes (§3, §4): its books from what it's matched to (the personal books until then), and its person,
   * which for a W-2 is the employer's member unless the request names the same person.
   */
  private async place(
    trx: Trx,
    ctx: Ctx,
    kind: TaxFormKind,
    targets: Target[],
    personMemberId: string | null | undefined,
  ): Promise<{ entityId: string; personMemberId: string | null; targets: Target[] }> {
    const unique = dedupe(targets);
    const employers = unique.filter((t): t is { employerId: string } => 'employerId' in t);
    const accounts = unique.filter((t): t is { accountId: string } => 'accountId' in t);
    if (kind === 'w2' ? accounts.length > 0 || employers.length > 1 : employers.length > 0) {
      throw unprocessable(
        'tax_form.target_kind',
        kind === 'w2' ? 'A W-2 is matched to one employer' : 'A 1099 or 1098 is matched to accounts',
      );
    }
    const books = new Set<string>();
    let person = personMemberId ?? null;
    if (employers[0]) {
      const employer = await this.employer(trx, ctx, employers[0].employerId);
      books.add(employer.entity_id);
      if (personMemberId === undefined || personMemberId === null) person = employer.member_id;
      else if (personMemberId !== employer.member_id) {
        throw unprocessable('tax_form.person_conflict', 'A W-2 is for its employer’s person');
      }
    }
    for (const t of accounts) books.add((await this.account(trx, ctx, t.accountId)).entity_id);
    if (books.size > 1) {
      throw unprocessable('tax_form.targets_books', 'The accounts of one form belong to the same books');
    }
    if (person) await this.member(trx, ctx, person);
    const entityId = [...books][0] ?? (await this.personalBooks(trx, ctx));
    return { entityId, personMemberId: person, targets: unique };
  }

  private async employer(trx: Trx, ctx: Ctx, id: string) {
    const employer = await trx
      .selectFrom('app.employer')
      .select(['id', 'entity_id', 'member_id'])
      .where('workspace_id', '=', ctx.workspaceId)
      .where('id', '=', id)
      .executeTakeFirst();
    if (!employer) throw notFound('Employer');
    return employer;
  }

  private async account(trx: Trx, ctx: Ctx, id: string) {
    const account = await trx
      .selectFrom('app.ledger_account as a')
      .innerJoin('app.bank_account as b', (j) =>
        j.onRef('b.workspace_id', '=', 'a.workspace_id').onRef('b.ledger_account_id', '=', 'a.id'),
      )
      .select(['a.id', 'a.entity_id', 'b.default_member_id'])
      .where('a.workspace_id', '=', ctx.workspaceId)
      .where('a.id', '=', id)
      .executeTakeFirst();
    if (!account) throw notFound('Account');
    return account;
  }

  private async member(trx: Trx, ctx: Ctx, id: string): Promise<void> {
    const member = await trx
      .selectFrom('app.family_member')
      .select('id')
      .where('workspace_id', '=', ctx.workspaceId)
      .where('id', '=', id)
      .executeTakeFirst();
    if (!member) throw notFound('Family member');
  }

  private async personalBooks(trx: Trx, ctx: Ctx): Promise<string> {
    const books = await trx
      .selectFrom('app.entity')
      .select('id')
      .where('workspace_id', '=', ctx.workspaceId)
      .where('type', '=', 'personal')
      .where('archived_at', 'is', null)
      .orderBy('created_at')
      .orderBy('id')
      .executeTakeFirst();
    if (!books) throw forbidden('You can’t add tax forms to the personal books');
    return books.id;
  }

  private async checkSupersedes(
    trx: Trx,
    ctx: Ctx,
    supersedesId: string,
    kind: TaxFormKind,
    selfId: string | null,
  ): Promise<void> {
    if (supersedesId === selfId) throw unprocessable('tax_form.supersedes', 'A form can’t replace itself');
    const old = await this.row(trx, ctx, supersedesId).catch(() => null);
    if (!old || old.deleted_at) throw notFound('The form it corrects');
    if (old.kind !== kind)
      throw unprocessable('tax_form.supersedes', 'A corrected form replaces one of its kind');
  }

  /** The form a corrected one replaces stays visible, marked superseded (§6). */
  private async supersede(trx: Trx, ctx: Ctx, id: string): Promise<void> {
    await trx
      .updateTable('app.tax_form')
      .set({ status: 'superseded', reason: null })
      .where('workspace_id', '=', ctx.workspaceId)
      .where('id', '=', id)
      .execute();
  }
}

// ----- Pure helpers --------------------------------------------------------------------------------------------------

/** A typed form needs a person only once it's matched and its person is known. */
function typedStatus(
  matched: boolean,
  personKnown: boolean,
): { status: TaxFormStatus; reason: TaxFormReason | null } {
  if (!matched) return { status: 'review', reason: 'no_match' };
  if (!personKnown) return { status: 'review', reason: 'no_person' };
  return { status: 'confirmed', reason: null };
}

function checkedBoxes(kind: TaxFormKind, boxes: unknown): Record<string, unknown> {
  try {
    return normalizeTaxFormBoxes(kind, boxes);
  } catch (err) {
    if (err instanceof TaxFormBoxesError) {
      throw new AppError(422, 'tax_form.boxes', 'Check the boxes', [
        { path: `boxes.${err.path}`, message: err.message },
      ]);
    }
    throw err;
  }
}

function checkIssuerTin(ein: string | null, last4: string | null): void {
  if (ein && last4) {
    throw unprocessable('tax_form.issuer_tin', 'An issuer has an EIN or an SSN-shaped TIN, not both');
  }
}

function dedupe(targets: Target[]): Target[] {
  const seen = new Set<string>();
  return targets.filter((t) => {
    const key = 'employerId' in t ? `e:${t.employerId}` : `a:${t.accountId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

function toDto(f: TaxFormRow, targets: TaxFormTargetRow[]): TaxFormDto {
  return {
    id: f.id,
    entityId: f.entity_id,
    taxYear: f.tax_year,
    kind: f.kind,
    corrected: f.corrected,
    supersedesId: f.supersedes_id,
    issuerName: f.issuer_name,
    issuerEin: f.issuer_ein,
    issuerTinLast4: f.issuer_tin_last4,
    personTinLast4: f.person_tin_last4,
    accountLast4: f.account_last4,
    personMemberId: f.person_member_id,
    targets: targets.map((t) => ({ employerId: t.employer_id, accountId: t.account_id })),
    // Stored canonical by `normalizeTaxFormBoxes`; the kind decides which boxes they are.
    boxes: f.boxes,
    fileIds: f.file_ids,
    pages: f.pages,
    status: f.status,
    reason: f.reason as TaxFormReason | null,
    source: f.source,
    createdBy: f.created_by,
    confirmedBy: f.confirmed_by,
    confirmedAt: iso(f.confirmed_at),
    deletedAt: iso(f.deleted_at),
    createdAt: f.created_at.toISOString(),
    updatedAt: f.updated_at.toISOString(),
    version: Number(f.version),
  } as TaxFormDto;
}

function waiverDto(w: TaxFormWaiverRow): TaxFormWaiverDto {
  return {
    id: w.id,
    entityId: w.entity_id,
    taxYear: w.tax_year,
    kind: w.kind,
    employerId: w.employer_id,
    accountId: w.account_id,
    personMemberId: w.person_member_id,
    reason: w.reason,
    note: w.note,
    createdBy: w.created_by,
    createdAt: w.created_at.toISOString(),
  };
}
