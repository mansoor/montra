'use client';

import { useState } from 'react';
import type { I9Dto, PayrollPersonDto } from '@montra/api-client';
import { browserApi } from '@/lib/browser-api';
import { digitsOnly, formatTinInput, I9_DOCUMENTS } from '@/lib/payroll';
import { DateText } from '../i18n';
import { StatusLine, useAction } from '../use-action';
import { Field, Item } from './person-details';
import { Reveal, tinText } from './reveal';

type Citizenship = NonNullable<I9Dto['section1']['citizenship']>;

/**
 * Form I-9 (PRL-04). Section 1 is the employee's, entered with them; Section 2 is the employer's, after examining the
 * original documents. Copies are sealed in storage, and the I-9 is kept until its retention date has passed.
 */
export function I9Panel({
  workspaceId,
  person,
  i9,
  business,
  today,
}: {
  workspaceId: string;
  person: PayrollPersonDto;
  i9: I9Dto | null;
  business: { name: string; address: string | null };
  today: string;
}) {
  const { run, busy, message, setMessage, t } = useAction();
  const locked = !!i9?.section2.signedOn;
  const [step, setStep] = useState<'section1' | 'document' | 'section2' | null>(
    !i9 ? 'section1' : !i9.section2.signedOn && i9.documents.length === 0 ? 'document' : null,
  );
  const s1 = i9?.section1;
  const [one, setOne] = useState({
    lastName: s1?.lastName ?? person.lastName,
    firstName: s1?.firstName ?? person.firstName,
    middleInitial: s1?.middleInitial ?? (person.middleName?.charAt(0) || ''),
    otherLastNames: s1?.otherLastNames ?? '',
    address: s1?.address ?? [person.address.line1].filter(Boolean).join(''),
    apartment: s1?.apartment ?? (person.address.line2 || ''),
    city: s1?.city ?? (person.address.city || ''),
    state: s1?.state ?? (person.address.region || ''),
    zip: s1?.zip ?? (person.address.postalCode || ''),
    birthDate: '',
    ssn: '',
    email: s1?.email ?? (person.email || ''),
    phone: s1?.phone ?? (person.phone || ''),
    citizenship: (s1?.citizenship ?? 'citizen') as Citizenship,
    aNumber: '',
    workUntil: s1?.workUntil ?? '',
    i94Number: '',
    passportNumber: '',
    passportCountry: s1?.passportCountry ?? '',
    preparerName: s1?.preparerName ?? '',
    preparerAddress: s1?.preparerAddress ?? '',
    signedName: s1?.signedName ?? `${person.firstName} ${person.lastName}`,
    signedOn: s1?.signedOn ?? today,
    attested: false,
  });
  const [doc, setDoc] = useState({
    list: 'A' as 'A' | 'B' | 'C',
    title: '',
    issuingAuthority: '',
    number: '',
    expiresOn: '',
  });
  const [files, setFiles] = useState<File[]>([]);
  const [two, setTwo] = useState({
    firstDay: i9?.section2.firstDay ?? person.hireDate ?? today,
    signedName: i9?.section2.signedName ?? '',
    title: i9?.section2.title ?? '',
    signedOn: i9?.section2.signedOn ?? today,
    businessName: i9?.section2.businessName ?? business.name,
    businessAddress: i9?.section2.businessAddress ?? (business.address ?? '').replace(/\n/g, ', '),
    additionalInfo: i9?.section2.additionalInfo ?? '',
    examinedOriginals: false,
  });

  const CITIZENSHIP: Record<Citizenship, string> = {
    citizen: t('payroll.i9.citizen'),
    noncitizen_national: t('payroll.i9.noncitizen_national'),
    permanent_resident: t('payroll.i9.permanent_resident'),
    authorized_alien: t('payroll.i9.authorized_alien'),
  };
  const LIST: Record<'A' | 'B' | 'C', string> = {
    A: t('payroll.i9.list_a'),
    B: t('payroll.i9.list_b'),
    C: t('payroll.i9.list_c'),
  };
  const secretOrKeep = (typed: string, onFile: boolean) =>
    typed.trim() ? typed.trim() : onFile ? undefined : null;

  function saveSection1() {
    void run(
      () =>
        browserApi.saveI9Section1(workspaceId, person.id, {
          lastName: one.lastName.trim(),
          firstName: one.firstName.trim(),
          middleInitial: one.middleInitial.trim() || null,
          otherLastNames: one.otherLastNames.trim() || null,
          address: one.address.trim() || null,
          apartment: one.apartment.trim() || null,
          city: one.city.trim() || null,
          state: one.state.trim() || null,
          zip: one.zip.trim() || null,
          ...(one.birthDate ? { birthDate: one.birthDate } : {}),
          ...(one.ssn.trim() ? { ssn: digitsOnly(one.ssn) } : {}),
          email: one.email.trim() || null,
          phone: one.phone.trim() || null,
          citizenship: one.citizenship,
          ...(one.citizenship === 'permanent_resident' || one.citizenship === 'authorized_alien'
            ? {
                aNumber: secretOrKeep(one.aNumber, !!s1?.hasANumber),
                i94Number: secretOrKeep(one.i94Number, !!s1?.hasI94Number),
                passportNumber: secretOrKeep(one.passportNumber, !!s1?.hasPassportNumber),
              }
            : { aNumber: null, i94Number: null, passportNumber: null }),
          workUntil: one.citizenship === 'authorized_alien' ? one.workUntil || null : null,
          passportCountry: one.passportCountry.trim() || null,
          preparerName: one.preparerName.trim() || null,
          preparerAddress: one.preparerAddress.trim() || null,
          signedName: one.signedName.trim(),
          signedOn: one.signedOn,
          attested: true,
          ...(i9 ? { version: i9.version } : {}),
        }),
      t('payroll.i9.section1_saved'),
    ).then((r) => {
      if (r) setStep(r.documents.length ? null : 'document');
    });
  }

  async function addDocument() {
    const fileIds: string[] = [];
    for (const file of files) {
      const up = await run(() => browserApi.uploadPayrollFile(workspaceId, person.entityId, file, file.name));
      if (!up) return;
      fileIds.push(up.fileId);
    }
    const r = await run(
      () =>
        browserApi.addI9Document(workspaceId, person.id, {
          list: doc.list,
          title: doc.title.trim(),
          issuingAuthority: doc.issuingAuthority.trim() || null,
          number: doc.number.trim() || null,
          expiresOn: doc.expiresOn || null,
          fileIds,
        }),
      t('payroll.i9.document_saved'),
    );
    if (r) {
      setDoc({
        list: doc.list === 'B' ? 'C' : 'A',
        title: '',
        issuingAuthority: '',
        number: '',
        expiresOn: '',
      });
      setFiles([]);
      const lists = new Set(r.documents.map((d) => d.list));
      setStep(lists.has('A') || (lists.has('B') && lists.has('C')) ? 'section2' : 'document');
    }
  }

  function saveSection2() {
    if (!i9) return;
    void run(
      () =>
        browserApi.saveI9Section2(workspaceId, person.id, {
          firstDay: two.firstDay,
          signedName: two.signedName.trim(),
          title: two.title.trim(),
          signedOn: two.signedOn,
          businessName: two.businessName.trim(),
          businessAddress: two.businessAddress.trim(),
          additionalInfo: two.additionalInfo.trim() || null,
          examinedOriginals: true,
          version: i9.version,
        }),
      t('payroll.i9.section2_saved'),
    ).then((r) => {
      if (r) setStep(null);
    });
  }

  const status = i9?.status;
  const needsNumber = one.citizenship === 'permanent_resident' || one.citizenship === 'authorized_alien';

  return (
    <section className="card space-y-4" aria-labelledby="i9-title">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="i9-title" className="text-base font-semibold">
          {t('payroll.i9.title')}
        </h2>
        {i9 && (
          <a
            className="text-sm underline"
            href={browserApi.i9PdfPath(workspaceId, person.id)}
            target="_blank"
            rel="noreferrer"
          >
            {t('payroll.pdf')}
          </a>
        )}
      </div>
      <div
        className="space-y-1 rounded-md border border-warn/40 bg-warn/10 p-3 text-sm"
        data-testid="i9-notice"
      >
        <p className="font-medium">{t('payroll.i9.examine_originals')}</p>
        <p className="text-muted">{t('payroll.i9.no_everify')}</p>
      </div>

      {status && (
        <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2 lg:grid-cols-4">
          <Item label={t('payroll.i9.section1')}>
            {status.section1 ? (
              <span className="chip chip-good">{t('payroll.i9.signed')}</span>
            ) : (
              <span className="chip chip-warn">{t('payroll.i9.not_signed')}</span>
            )}
          </Item>
          <Item label={t('payroll.i9.documents')}>{String(status.documents)}</Item>
          <Item label={t('payroll.i9.section2')}>
            {status.section2 ? (
              <span className="chip chip-good">{t('payroll.i9.signed')}</span>
            ) : status.section2Due ? (
              <span className={`chip gap-1 ${status.section2Due < today ? 'chip-bad' : 'chip-warn'}`}>
                {t('payroll.i9.due')} <DateText date={status.section2Due} />
              </span>
            ) : (
              <span className="chip chip-warn">{t('payroll.i9.not_signed')}</span>
            )}
          </Item>
          <Item label={t('payroll.i9.keep_until')}>
            {status.retainUntil ? (
              <>
                <DateText date={status.retainUntil} />
                {status.mayDestroy && <span className="chip ml-2">{t('payroll.i9.may_destroy')}</span>}
              </>
            ) : (
              <span className="text-muted">{t('payroll.i9.keep_while_employed')}</span>
            )}
          </Item>
        </dl>
      )}

      {i9 && step !== 'section1' && (
        <div className="space-y-2 text-sm">
          <p>
            {i9.section1.firstName} {i9.section1.lastName} ·{' '}
            {i9.section1.citizenship ? CITIZENSHIP[i9.section1.citizenship] : null}
          </p>
          <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-2 lg:grid-cols-3">
            <Item label={t('payroll.ssn')}>
              <Reveal
                workspaceId={workspaceId}
                personId={person.id}
                masked={i9.section1.ssnMasked}
                request={{ field: 'i9.ssn' }}
                format={tinText('ssn')}
              />
            </Item>
            <Item label={t('payroll.birth_date')}>
              <Reveal
                workspaceId={workspaceId}
                personId={person.id}
                masked={i9.section1.hasBirthDate ? '••/••/••••' : null}
                request={{ field: 'i9.birthDate' }}
              />
            </Item>
            {i9.section1.hasANumber && (
              <Item label={t('payroll.i9.a_number')}>
                <Reveal
                  workspaceId={workspaceId}
                  personId={person.id}
                  masked="•••••••••"
                  request={{ field: 'i9.aNumber' }}
                />
              </Item>
            )}
          </dl>
          {!locked && (
            <button type="button" className="text-sm underline" onClick={() => setStep('section1')}>
              {t('payroll.i9.edit_section1')}
            </button>
          )}
        </div>
      )}

      {step === 'section1' && !locked && (
        <form
          className="grid gap-3 border-t border-line pt-3 sm:grid-cols-2 lg:grid-cols-4"
          aria-label={t('payroll.i9.section1')}
          autoComplete="off"
          onSubmit={(e) => {
            e.preventDefault();
            saveSection1();
          }}
        >
          <p className="text-sm font-medium sm:col-span-2 lg:col-span-4">{t('payroll.i9.section1_intro')}</p>
          <Field label={t('payroll.last_name')}>
            <input
              className="input"
              required
              maxLength={100}
              value={one.lastName}
              onChange={(e) => setOne((x) => ({ ...x, lastName: e.target.value }))}
            />
          </Field>
          <Field label={t('payroll.first_name')}>
            <input
              className="input"
              required
              maxLength={100}
              value={one.firstName}
              onChange={(e) => setOne((x) => ({ ...x, firstName: e.target.value }))}
            />
          </Field>
          <Field label={t('payroll.i9.middle_initial')}>
            <input
              className="input"
              maxLength={1}
              value={one.middleInitial}
              onChange={(e) => setOne((x) => ({ ...x, middleInitial: e.target.value }))}
            />
          </Field>
          <Field label={t('payroll.i9.other_last_names')}>
            <input
              className="input"
              maxLength={200}
              value={one.otherLastNames}
              onChange={(e) => setOne((x) => ({ ...x, otherLastNames: e.target.value }))}
            />
          </Field>
          <Field label={t('payroll.address_line1')}>
            <input
              className="input"
              maxLength={200}
              value={one.address}
              onChange={(e) => setOne((x) => ({ ...x, address: e.target.value }))}
            />
          </Field>
          <Field label={t('payroll.i9.apartment')}>
            <input
              className="input"
              maxLength={20}
              value={one.apartment}
              onChange={(e) => setOne((x) => ({ ...x, apartment: e.target.value }))}
            />
          </Field>
          <Field label={t('payroll.city')}>
            <input
              className="input"
              maxLength={100}
              value={one.city}
              onChange={(e) => setOne((x) => ({ ...x, city: e.target.value }))}
            />
          </Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label={t('payroll.state')}>
              <input
                className="input uppercase"
                maxLength={2}
                value={one.state}
                onChange={(e) => setOne((x) => ({ ...x, state: e.target.value }))}
              />
            </Field>
            <Field label={t('payroll.zip')}>
              <input
                className="input"
                maxLength={10}
                value={one.zip}
                onChange={(e) => setOne((x) => ({ ...x, zip: e.target.value }))}
              />
            </Field>
          </div>
          <Field label={s1?.hasBirthDate ? t('payroll.i9.birth_date_replace') : t('payroll.birth_date')}>
            <input
              className="input"
              type="date"
              value={one.birthDate}
              onChange={(e) => setOne((x) => ({ ...x, birthDate: e.target.value }))}
            />
          </Field>
          <Field label={s1?.ssnMasked ? t('payroll.i9.ssn_replace') : t('payroll.i9.ssn_optional')}>
            <input
              className="input num"
              inputMode="numeric"
              autoComplete="off"
              value={one.ssn}
              placeholder={s1?.ssnMasked ?? ''}
              onChange={(e) => setOne((x) => ({ ...x, ssn: formatTinInput('ssn', e.target.value) }))}
            />
          </Field>
          <Field label={t('payroll.email')}>
            <input
              className="input"
              type="email"
              value={one.email}
              onChange={(e) => setOne((x) => ({ ...x, email: e.target.value }))}
            />
          </Field>
          <Field label={t('payroll.phone')}>
            <input
              className="input"
              maxLength={50}
              value={one.phone}
              onChange={(e) => setOne((x) => ({ ...x, phone: e.target.value }))}
            />
          </Field>
          <fieldset className="space-y-1 sm:col-span-2 lg:col-span-4">
            <legend className="field-label">{t('payroll.i9.citizenship')}</legend>
            {(Object.keys(CITIZENSHIP) as Citizenship[]).map((k) => (
              <label key={k} className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  name="citizenship"
                  checked={one.citizenship === k}
                  onChange={() => setOne((x) => ({ ...x, citizenship: k }))}
                />
                {CITIZENSHIP[k]}
              </label>
            ))}
          </fieldset>
          {needsNumber && (
            <>
              <Field label={s1?.hasANumber ? t('payroll.i9.a_number_replace') : t('payroll.i9.a_number')}>
                <input
                  className="input"
                  maxLength={20}
                  autoComplete="off"
                  value={one.aNumber}
                  onChange={(e) => setOne((x) => ({ ...x, aNumber: e.target.value }))}
                />
              </Field>
              {one.citizenship === 'authorized_alien' && (
                <>
                  <Field label={t('payroll.i9.work_until')}>
                    <input
                      className="input"
                      type="date"
                      value={one.workUntil}
                      onChange={(e) => setOne((x) => ({ ...x, workUntil: e.target.value }))}
                    />
                  </Field>
                  <Field label={t('payroll.i9.i94_number')}>
                    <input
                      className="input"
                      maxLength={20}
                      autoComplete="off"
                      value={one.i94Number}
                      onChange={(e) => setOne((x) => ({ ...x, i94Number: e.target.value }))}
                    />
                  </Field>
                  <Field label={t('payroll.i9.passport_number')}>
                    <input
                      className="input"
                      maxLength={30}
                      autoComplete="off"
                      value={one.passportNumber}
                      onChange={(e) => setOne((x) => ({ ...x, passportNumber: e.target.value }))}
                    />
                  </Field>
                  <Field label={t('payroll.i9.passport_country')}>
                    <input
                      className="input"
                      maxLength={100}
                      value={one.passportCountry}
                      onChange={(e) => setOne((x) => ({ ...x, passportCountry: e.target.value }))}
                    />
                  </Field>
                </>
              )}
            </>
          )}
          <Field label={t('payroll.i9.preparer_name')}>
            <input
              className="input"
              maxLength={300}
              value={one.preparerName}
              onChange={(e) => setOne((x) => ({ ...x, preparerName: e.target.value }))}
            />
          </Field>
          {one.preparerName.trim() && (
            <Field label={t('payroll.i9.preparer_address')}>
              <input
                className="input"
                maxLength={500}
                value={one.preparerAddress}
                onChange={(e) => setOne((x) => ({ ...x, preparerAddress: e.target.value }))}
              />
            </Field>
          )}
          <Field label={t('payroll.i9.employee_signature')}>
            <input
              className="input"
              required
              maxLength={300}
              value={one.signedName}
              onChange={(e) => setOne((x) => ({ ...x, signedName: e.target.value }))}
            />
          </Field>
          <Field label={t('payroll.signed_on')}>
            <input
              className="input"
              type="date"
              required
              value={one.signedOn}
              onChange={(e) => setOne((x) => ({ ...x, signedOn: e.target.value }))}
            />
          </Field>
          <label className="flex items-start gap-2 text-sm sm:col-span-2 lg:col-span-4">
            <input
              type="checkbox"
              required
              checked={one.attested}
              onChange={(e) => setOne((x) => ({ ...x, attested: e.target.checked }))}
            />
            {t('payroll.i9.attest_section1')}
          </label>
          <div className="flex gap-2 sm:col-span-2 lg:col-span-4">
            <button type="submit" className="btn-primary" disabled={busy || !one.attested}>
              {t('payroll.i9.save_section1')}
            </button>
            {i9 && (
              <button type="button" className="btn-ghost" onClick={() => setStep(null)}>
                {t('common.cancel')}
              </button>
            )}
          </div>
        </form>
      )}

      {i9 && (
        <div className="space-y-2 border-t border-line pt-3">
          <h3 className="text-sm font-semibold">{t('payroll.i9.documents_examined')}</h3>
          {i9.documents.length === 0 ? (
            <p className="text-sm text-muted">{t('payroll.i9.no_documents')}</p>
          ) : (
            <ul className="divide-y divide-line text-sm">
              {i9.documents.map((d) => (
                <li
                  key={d.id}
                  className="flex flex-wrap items-center justify-between gap-2 py-2"
                  data-testid="i9-document"
                >
                  <span>
                    <span className="chip mr-2">{LIST[d.list]}</span>
                    {d.title}
                    {d.issuingAuthority && ` · ${d.issuingAuthority}`}
                    {d.numberMasked && (
                      <>
                        {' · '}
                        <Reveal
                          workspaceId={workspaceId}
                          personId={person.id}
                          masked={d.numberMasked}
                          request={{ field: 'i9.document', recordId: d.id }}
                        />
                      </>
                    )}
                    {d.expiresOn && (
                      <span className="block text-xs text-muted">
                        {t('payroll.i9.expires')} <DateText date={d.expiresOn} />
                      </span>
                    )}
                  </span>
                  <span className="flex flex-wrap items-center gap-3">
                    {d.files.map((f, n) => (
                      <a
                        key={f.id}
                        className="text-sm underline"
                        href={browserApi.i9DocumentFilePath(workspaceId, person.id, d.id, f.id)}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {t('payroll.i9.copy_n', { n: n + 1 })}
                      </a>
                    ))}
                    {!locked && (
                      <button
                        type="button"
                        className="text-sm text-bad underline"
                        onClick={() =>
                          void run(
                            () => browserApi.removeI9Document(workspaceId, person.id, d.id),
                            t('payroll.i9.document_removed'),
                          )
                        }
                      >
                        {t('payroll.remove')}
                      </button>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {!locked && step !== 'document' && (
            <button type="button" className="text-sm underline" onClick={() => setStep('document')}>
              {t('payroll.i9.add_document')}
            </button>
          )}
          {!locked && step === 'document' && (
            <form
              className="grid gap-3 rounded-md border border-line p-3 sm:grid-cols-2 lg:grid-cols-3"
              aria-label={t('payroll.i9.add_document')}
              onSubmit={(e) => {
                e.preventDefault();
                void addDocument();
              }}
            >
              <p className="text-xs text-muted sm:col-span-2 lg:col-span-3">{t('payroll.i9.lists_hint')}</p>
              <Field label={t('payroll.i9.list')}>
                <select
                  className="input"
                  value={doc.list}
                  onChange={(e) => setDoc((x) => ({ ...x, list: e.target.value as 'A' | 'B' | 'C' }))}
                >
                  <option value="A">{LIST.A}</option>
                  <option value="B">{LIST.B}</option>
                  <option value="C">{LIST.C}</option>
                </select>
              </Field>
              <Field label={t('payroll.i9.document_title')}>
                <input
                  className="input"
                  required
                  maxLength={200}
                  list="i9-titles"
                  value={doc.title}
                  onChange={(e) => setDoc((x) => ({ ...x, title: e.target.value }))}
                />
                <datalist id="i9-titles">
                  {I9_DOCUMENTS[doc.list].map((title) => (
                    <option key={title} value={title} />
                  ))}
                </datalist>
              </Field>
              <Field label={t('payroll.i9.issuing_authority')}>
                <input
                  className="input"
                  maxLength={200}
                  value={doc.issuingAuthority}
                  onChange={(e) => setDoc((x) => ({ ...x, issuingAuthority: e.target.value }))}
                />
              </Field>
              <Field label={t('payroll.i9.document_number')}>
                <input
                  className="input"
                  maxLength={40}
                  autoComplete="off"
                  value={doc.number}
                  onChange={(e) => setDoc((x) => ({ ...x, number: e.target.value }))}
                />
              </Field>
              <Field label={t('payroll.i9.expiration')}>
                <input
                  className="input"
                  type="date"
                  value={doc.expiresOn}
                  onChange={(e) => setDoc((x) => ({ ...x, expiresOn: e.target.value }))}
                />
              </Field>
              <Field label={t('payroll.i9.copies')}>
                <input
                  className="input"
                  type="file"
                  multiple
                  accept="image/jpeg,image/png,image/webp,application/pdf"
                  onChange={(e) => {
                    const list = [...(e.target.files ?? [])].slice(0, 4);
                    setFiles(list);
                    if ((e.target.files?.length ?? 0) > 4)
                      setMessage({ tone: 'bad', text: t('payroll.i9.too_many_copies') });
                  }}
                />
              </Field>
              <p className="text-xs text-muted sm:col-span-2 lg:col-span-3">{t('payroll.i9.copies_hint')}</p>
              <div className="flex gap-2 sm:col-span-2 lg:col-span-3">
                <button type="submit" className="btn-primary" disabled={busy}>
                  {t('payroll.i9.save_document')}
                </button>
                <button type="button" className="btn-ghost" onClick={() => setStep(null)}>
                  {t('common.cancel')}
                </button>
              </div>
            </form>
          )}
        </div>
      )}

      {i9 && !locked && i9.documents.length > 0 && (
        <div className="space-y-2 border-t border-line pt-3">
          {step !== 'section2' ? (
            <button type="button" className="btn-secondary" onClick={() => setStep('section2')}>
              {t('payroll.i9.complete_section2')}
            </button>
          ) : (
            <form
              className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3"
              aria-label={t('payroll.i9.section2')}
              onSubmit={(e) => {
                e.preventDefault();
                saveSection2();
              }}
            >
              <p className="text-sm font-medium sm:col-span-2 lg:col-span-3">
                {t('payroll.i9.section2_intro')}
              </p>
              <Field label={t('payroll.i9.first_day')}>
                <input
                  className="input"
                  type="date"
                  required
                  value={two.firstDay}
                  onChange={(e) => setTwo((x) => ({ ...x, firstDay: e.target.value }))}
                />
              </Field>
              <Field label={t('payroll.i9.employer_name')}>
                <input
                  className="input"
                  required
                  maxLength={300}
                  value={two.signedName}
                  onChange={(e) => setTwo((x) => ({ ...x, signedName: e.target.value }))}
                />
              </Field>
              <Field label={t('payroll.i9.employer_title')}>
                <input
                  className="input"
                  required
                  maxLength={100}
                  value={two.title}
                  onChange={(e) => setTwo((x) => ({ ...x, title: e.target.value }))}
                />
              </Field>
              <Field label={t('payroll.i9.business_name')}>
                <input
                  className="input"
                  required
                  maxLength={300}
                  value={two.businessName}
                  onChange={(e) => setTwo((x) => ({ ...x, businessName: e.target.value }))}
                />
              </Field>
              <Field label={t('payroll.i9.business_address')}>
                <input
                  className="input"
                  required
                  maxLength={500}
                  value={two.businessAddress}
                  onChange={(e) => setTwo((x) => ({ ...x, businessAddress: e.target.value }))}
                />
              </Field>
              <Field label={t('payroll.signed_on')}>
                <input
                  className="input"
                  type="date"
                  required
                  value={two.signedOn}
                  onChange={(e) => setTwo((x) => ({ ...x, signedOn: e.target.value }))}
                />
              </Field>
              <label className="sm:col-span-2 lg:col-span-3">
                <span className="field-label">{t('payroll.i9.additional_info')}</span>
                <input
                  className="input"
                  maxLength={1000}
                  value={two.additionalInfo}
                  onChange={(e) => setTwo((x) => ({ ...x, additionalInfo: e.target.value }))}
                />
              </label>
              <label className="flex items-start gap-2 text-sm sm:col-span-2 lg:col-span-3">
                <input
                  type="checkbox"
                  required
                  checked={two.examinedOriginals}
                  onChange={(e) => setTwo((x) => ({ ...x, examinedOriginals: e.target.checked }))}
                />
                {t('payroll.i9.attest_section2')}
              </label>
              <div className="flex gap-2 sm:col-span-2 lg:col-span-3">
                <button type="submit" className="btn-primary" disabled={busy || !two.examinedOriginals}>
                  {t('payroll.i9.sign_section2')}
                </button>
                <button type="button" className="btn-ghost" onClick={() => setStep(null)}>
                  {t('common.cancel')}
                </button>
              </div>
            </form>
          )}
        </div>
      )}

      {locked && i9 && (
        <p className="text-sm text-muted">
          {t('payroll.i9.completed_by', { name: i9.section2.signedName ?? '' })}{' '}
          <DateText date={i9.section2.signedOn!} />
        </p>
      )}
      {status?.mayDestroy && (
        <button
          type="button"
          className="btn-ghost text-bad"
          onClick={() => {
            if (window.confirm(t('payroll.i9.destroy_confirm'))) {
              void run(() => browserApi.destroyI9(workspaceId, person.id), t('payroll.i9.destroyed'));
            }
          }}
        >
          {t('payroll.i9.destroy')}
        </button>
      )}
      <StatusLine message={message} />
    </section>
  );
}
