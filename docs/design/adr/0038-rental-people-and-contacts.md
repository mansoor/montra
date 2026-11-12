# ADR-0038: Rentals: tenant details, the people on a lease, lease set-up costs and property contacts

- Status: accepted
- Date: 2026-11-12

## Context

Rentals (ADR-0018, RNT-01..14) kept a tenant's name, email, phone and notes. A lease linked several tenants through
`lease_tenant`, all of whom were treated as payers: the rent roll and arrears name them, and matching links a bank line
that names one of them. Properties had no contacts, and the maintenance log's vendor was free text.

The owner asked for:

- fuller tenant details, co-signers and other household members on the agreement, and which property a tenant rents;
- the broker and the broker's fee, and legal fees for lease documents, recorded as expenses;
- confirmation that property tax, insurance, a home warranty and HOA dues reach Schedule E;
- contacts per property: property manager, handyman, insurer, home warranty, HOA, gardener, broker, attorney and the
  utilities (water, electricity, gas, garbage, internet).

The scope is the US, as for the rest of Rentals. This is RNT-17..22 and migration 0038.

## Decision

### 1. Tenant details, and what isn't collected (RNT-17)

A tenant gains:

- a second phone and a mailing address;
- an emergency contact: name, relationship and phone;
- employer and monthly income, optional, as screening notes (income in minor units, like all money);
- a vehicle or plate, as free text;
- a date of birth, optional.

**No Social Security number is collected.** Montra doesn't screen tenants or pull credit (RNT-16 is a "could have" for
the future), and an SSN kept only "in case" is a liability for the owner with no use in the app. A landlord who runs a
screening service keeps the report there.

**The date of birth is sealed**, as payroll seals one (ADR-0034 §3): `tenant.birth_date_enc` is AES-GCM under the
workspace key, labelled `tenant.birth_date`. It isn't in any DTO: `TenantDto.hasDateOfBirth` says one is on file, the web
shows it masked (••/••/••••), and Show calls `POST tenants/:id/reveal`, which needs a recent sign-in (AUTH-09) and writes
`rental.revealed` to the audit log. An occupant's date of birth is handled the same way (`lease_person.birth_date`).
Backups decrypt both into the archive and re-seal them on restore (`ENCRYPTED` in `data/catalog.ts`). The other details
are ordinary contact data under the portfolio's RLS: only people with access to the portfolio see them (RNT-03 already
scoped tenants this way).

`TenantDto.current` is the lease the tenant signs that's active today (the latest start if two are), with its property
and unit, for the tenants list. `GET tenants/:id` adds every lease they sign or co-sign, active first, then upcoming,
then ended, the latest start first within each.

### 2. Co-signers and occupants: a `lease_person` table, not a role on `lease_tenant` (RNT-18)

The lease's people by role:

| Role                    | Where             | Pays rent?                                            | Details                                                      |
| ----------------------- | ----------------- | ----------------------------------------------------- | ------------------------------------------------------------ |
| Tenant (signer)         | `lease_tenant`    | yes: rent roll, arrears, matching, learned payee names | the tenant record                                            |
| Co-signer or guarantor  | `lease_person`    | no                                                    | name and contact, or one of the portfolio's tenants          |
| Occupant                | `lease_person`    | no                                                    | name, relationship, optional (sealed) date of birth          |

We add `app.lease_person` and keep `lease_tenant` as "the tenants who sign and pay", rather than adding a `role` column to
`lease_tenant`:

- **Signers stay the only payers by construction.** Four queries read `lease_tenant` as the payers (the rent roll's and
  arrears' names, matching by name in the nightly job, and learning a payee name). With a role column each would need a
  `role = 'signer'` filter, and a future query that forgot one would let a co-signer's name link a bank line to the
  lease, which misstates income (ADR-0018 §3). With a separate table none of them change.
- **An occupant has no tenant record.** `lease_tenant`'s key is `(lease_id, tenant_id)`; an occupant would need a nullable
  `tenant_id` and their own name, relationship and date of birth, which is a different row shape.
- **A co-signer can reuse a tenant record** (`lease_person.tenant_id`, co-signers only): someone who rents one unit and
  guarantees another is one person. Their name and contact details then come from the tenant record. A tenant can't both
  sign and co-sign the same lease (`lease.person_is_signer`), and can't be on it twice (`lease.person_twice`).

People are added with the lease (`CreateLeaseRequest.people`) or later on the lease page (`POST leases/:id/people`,
`PATCH`/`DELETE lease-people/:id`).

### 3. Lease documents, the broker, and set-up costs (RNT-19)

- **The signed lease** was already `fileIds` on the lease (`attachment_ids`), served only through a record the caller can
  read. The lease page now says so: "Signed lease", attach a PDF or photo, download, with the start and end dates at the
  top.
- **The broker or agent** is a contact with role `broker` (§5), `lease.broker_contact_id`.
- **A broker's fee and legal or document fees** are `app.lease_cost` rows. Recording one posts an expense through the
  same payment links as rent (`PaymentLinks`), owned by the lease (`spec.leaseId`, so `managedBy: 'lease'` and edits go
  through the lease) and tagged to the lease's property and unit (RNT-06):

  | Kind         | Category, found by tax line (owner may rename it) | Schedule E |
  | ------------ | ------------------------------------------------- | ---------- |
  | `broker_fee` | Commissions                                       | line 8     |
  | `legal_fee`  | Legal & professional                              | line 10    |

  It's recorded as paid from an account on a date, or taken over from a bank line already in the books, which keeps its
  date and amount. Removing the cost gives a taken-over line back as it was, or voids the transaction it created.
- **No amortization.** For tax, a commission paid to get a lease signed is generally spread over the lease term rather
  than deducted at once, and some legal fees for a lease can be too. Montra records what was paid when it was paid
  (cash basis, ADR-0017), so Schedule E shows the full fee in the year paid. The lease page and this ADR say so, and
  advise asking an accountant; Montra doesn't post an amortization schedule.

### 4. HOA dues and home warranty, and how the rest reaches Schedule E (RNT-20)

Two rental expense categories join the chart template, both on **Schedule E line 19 (Other)**, which asks for the
expense to be listed by name: **HOA dues** and **Home warranty**. Migration 0038 adds them to the rental books that exist
through `app.add_rental_categories(workspace, entity)`: in the entity's rental expense group, unless a category of that
name is already there, whatever its case and whether archived. It returns how many it added, so running it again adds
nothing. It is security-invoker, granted to `montra_app` only.

What already reaches Schedule E, confirmed:

- **Property tax**: the Taxes category, line 16. A mortgage payment's escrow for taxes posts there too, tagged to the
  property (ADR-0018 §6), when the payment is recorded.
- **Insurance**: the Insurance category, line 9, including the insurance part of mortgage escrow.
- **Utilities**: line 17.
- Escrow is expensed when paid in, not when the lender pays it out, so a year's total can differ from Form 1098
  (ADR-0018 §6, unchanged).

### 5. Property contacts (RNT-21)

`app.rental_contact` belongs to the portfolio (the rental entity) and links to any number of its properties through
`app.rental_contact_property`, so one insurer or one property manager serves many properties without copies. A contact
has a role (property manager, handyman, insurance, home warranty, HOA, landscaping, broker, attorney, water,
electricity, gas, garbage, internet, other), a company name (required; for a sole handyman, their name), an optional
contact person, website, email, phone, an account or policy number, and notes. The account or policy number is kept as
text and shown in full: it's on every bill and isn't an identity document.

- A website must be http or https; any other scheme (`javascript:` and the like) is refused by the API, and the web adds
  `https://` when no scheme is typed and links only http and https.
- Contacts can be archived (hidden from pickers and lists, kept on old records) or deleted. Deleting one clears it from
  leases (broker) and costs, and a maintenance entry that named it keeps the company name as its free-text vendor.
- The maintenance log's vendor can be a contact (`maintenance_log.contact_id`); free text stays for anyone not kept as
  one.
- RLS, triggers and grants follow migration 0037's pattern: readers of the portfolio see its contacts, writers change
  them.

### 6. Phone (RNT-22)

Rentals → Contacts and tenants lists each property's contacts (a shared one under each) with tap-to-call (`tel:`) and
tap-to-email (`mailto:`) links, and each tenant with their current property and unit. It's read-only and cached for
offline viewing; editing is on the web.

## Consequences

- A co-signer's or occupant's payment that names them isn't matched to the lease automatically; it's offered like any
  other line, and the owner links it. That's intended: only signers are payers.
- The capital-improvement check (RNT-09) looks at expense categories on lines 7, 14, 15 and 19, so a large HOA special
  assessment or home warranty charge may be offered as an improvement. The owner declines it, as for "Other" today.
- `PATCH leases/:id` with only `tenantIds` used to fail with an empty update; it now always touches the lease, so the
  version moves when the signers change.

## Alternatives considered

- **A `role` column on `lease_tenant`**: rejected in §2.
- **Collecting the SSN, sealed**: rejected in §1; nothing in Montra uses it.
- **Amortizing a leasing commission automatically**: it needs the deductible period, early-termination handling and an
  asset account per lease, and it's an accountant's call; recorded when paid instead (§3).
- **Contacts per property, copied**: one insurer for ten properties would be ten records to keep in step.
