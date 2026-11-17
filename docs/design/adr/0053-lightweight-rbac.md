# ADR-0053: Lightweight RBAC: roles as permission sets, with per-person changes

- Status: proposed (deferred; no build scheduled)
- Date: 2026-11-16
- Builds on: ADR-0041 (admin and member roles, family logins), ADR-0044 (workspace security rules), PAY-09,
  AUTH-04, AUTH-09, AUTH-14..18, BIZ-13, NFR-03
- Related: ADR-0052 (tax forms received), whose owner-only accountant setting this ADR would absorb

## Context

A workspace has six fixed roles: owner, admin, partner, member, viewer and accountant
([07-security-privacy-ops.md §2](../07-security-privacy-ops.md)). What each role may do is written in four places,
none of which names the action:

1. **API role lists.**
   - `requireRole(ctx, …)` is called at 38 sites in 12 files.
   - `requireWorkspaceAdmin(ctx)` is called at 20 sites, and `isAdmin(role)` at 17 more (backups, storage, billing,
     sync, sharing).
   - Local constants carry other lists: `RULE_EDITORS`, `WRITERS` (twice), `STATEMENT_ROLES`, `BILL_ROLES`,
     `UNDO_ROLES`, `MFA_ROLES`.
   - There are literal checks too: `ctx.role === 'member'` in payroll, `m?.role !== 'owner'` in restore, and
     `current_member_role() in (…)` inside a SQL query in `categorizer.service.ts`.
2. **The member guard.** `WorkspaceGuard` (`auth/auth.ts:303`) lets a member make only the writes in
   `MEMBER_WRITES` (`common/roles.ts`). Any other write is closed to members.
3. **RLS role lists.**
   - More than 30 policies test `app.current_member_role() in (…)` or `app.is_admin()`, mostly from migration 0041, plus
     `document_intake` in 0058.
   - `app.can_read_restricted(member)` decides who sees payslips and restricted ledger lines (PAY-09): owners, admins
     and the person's own login.
4. **Client mirrors.** The phone has `abilitiesOf` (`apps/mobile/src/features/roles.ts`, AUTH-18). The web has
   `canWriteBooks` (`lib/household-bills.ts`), `isAdminRole` (`lib/settings.ts`) and about 15 inline `workspace.role`
   checks.

The security doc promises "one `PolicyService.can(user, action, resource)`". **It doesn't exist**: no such class or
function is in the code.

Book access is a separate axis, and it works well. `app.entity_grant` (none, read or write per book) and
`app.entity_access()` (migration 0001, cached in 0009, widened in 0041) decide **which books** a login sees and
writes. This ADR doesn't change it. RBAC here is about **which actions** someone may take.

Fixed roles make simple questions hard to answer. The owner asked:

> Can the accountant see W-2s?
>
> Is the Accountant role going to make the tax package, or is it built by the owner or member and shared with the
> accountant?

From the code, the answers today are:

- An accountant **can't** see members' payslips. `can_read_restricted` is owners, admins and the person's own login.
- An accountant **can** make a tax package for any books they can read. `POST tax-package` is closed only to members,
  through the guard.
- The package is built under the maker's own RLS, so an accountant's package leaves out every restricted line.
- So "include members' private documents in a package" is today a side effect of being an owner or admin. It isn't a
  decision anyone can make.

ADR-0052 (tax forms) needs an answer before RBAC exists, so it adds an **owner-only workspace setting**, off by
default: "Accountants can see members' tax forms and include them in tax packages". This ADR designs the general
mechanism that setting stands in for.

**Out of scope:**

- **Staff roles** on the platform console (support < admin < owner, ADR-0049, `app.staff_role`) are a different
  thing: Montra's own staff, not people in a workspace.
- **The database roles** `montra_admin` and `montra_support`, whose grants the tests pin
  (`packages/db/test/rls.test.ts`). These are Postgres logins, not workspace roles.
- **Book access** (`entity_grant`), which stays as it is.
- **Custom roles** (see Alternatives).

## Decision

**In short:**

- Each of the six roles becomes a named **default set of permissions** from a fixed catalogue of 30.
- The owner, or an admin where allowed, can turn any permission **on or off for one person**, on top of their role,
  within limits per role.
- One server-side resolver, `app.has_permission()` in SQL with `can()` over it in the API, decides every check.
- RLS uses the same resolver, so an override can't be silently undone by the database, and private records stay
  protected in SQL.
- Clients get the person's effective permission list and only hide what they can't do. The server always decides.
- On deploy, behaviour doesn't change: every role's effective permissions equal today's checks, and a parity test
  proves it.

### 1. The permission catalogue

Names are `group.action`. **W** marks a write permission, which a viewer can never hold (§3.2). **S** marks a
sensitive permission (§3.4). **Tier** says who can hold it beyond the defaults: _owner_ (the owner only, never
grantable), _admin_ (owners and admins only) or _any_.

Every permission is also bounded by book access. A permission says what kind of action someone may take; book access
says in which books. Reading needs no permission: what someone reads is their book access plus
`documents.view_members_private`.

#### Books and transactions

| Permission            | W   | S   | Tier | Meaning                                                                                                                                                                                    |
| --------------------- | --- | --- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `transactions.record` | W   |     | any  | Add, edit, delete, restore and confirm transactions and transfers, and work the review queue, in books they can write                                                                      |
| `trips.record`        | W   |     | any  | Log trips and mileage                                                                                                                                                                      |
| `books.set_up`        | W   |     | any  | Set up the books: categories, accounts and their details (loans, cards, 401(k)), payees and tags beyond adding one while recording, payslips, and everything else outside the other groups |
| `family.manage`       | W   |     | any  | Add, edit and remove people in the Family list. Linking a login to a person is `sharing.manage`                                                                                            |
| `planning.manage`     | W   |     | any  | Budgets, goals and suggestions                                                                                                                                                             |
| `journals.post`       | W   |     | any  | Post manual journal entries                                                                                                                                                                |
| `periods.close`       | W   |     | any  | Close the books through a date                                                                                                                                                             |
| `periods.reopen`      | W   | S   | any  | Reopen a closed period, or unlock a locked entry                                                                                                                                           |
| `reconciliation.undo` | W   |     | any  | Undo a completed reconciliation                                                                                                                                                            |

#### Imports and documents

| Permission                       | W   | S   | Tier | Meaning                                                                                                                                                             |
| -------------------------------- | --- | --- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `imports.run`                    | W   |     | any  | Import statements and migrations, and file statement intakes and scans                                                                                              |
| `rules.manage`                   | W   |     | any  | Create, change, apply and delete rules; accept rule suggestions and an import's category proposals                                                                  |
| `documents.capture`              | W   |     | any  | Capture, match, apply and delete receipts; add household bills and file bill intakes; submit staff spending claims with their receipts                              |
| `documents.view_members_private` |     | S   | any  | See other people's private records: their payslips and payslip lines (PAY-09) and, once ADR-0052 lands, their tax forms. Still bounded by book access (§4.3). Owner-controlled (§3.3) |

#### Planning

`planning.manage` (above). Planning has no other action today.

#### Business, payroll and rentals

| Permission        | W   | S   | Tier | Meaning                                                                                                                         |
| ----------------- | --- | --- | ---- | ------------------------------------------------------------------------------------------------------------------------------- |
| `business.manage` | W   |     | any  | Invoices, bills and customers; staff, payroll runs and approving spending claims; uploading staff identity documents (PRL-11) |
| `rentals.manage`  | W   |     | any  | Properties, leases, rent, deposits and rental contacts                                                                          |

#### Reports and exports

| Permission                    | W   | S   | Tier  | Meaning                                                                                                                                                     |
| ----------------------------- | --- | --- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `exports.accounting`          |     |     | any   | Download the accountant export (CSV, XLSX, IIF) of books they can read (BIZ-13)                                                                             |
| `tax_package.make`            |     |     | any   | Make a tax package of books they can read                                                                                                                   |
| `tax_package.include_private` |     | S   | any   | Include other people's private records in a tax package they make. Needs `documents.view_members_private`, since the package is read under the maker's RLS. Owner-controlled |
| `backups.books`               |     |     | any   | Take a backup of one book they can read                                                                                                                     |
| `backups.workspace`           |     | S   | admin | Back up the whole workspace, save backups to its own storage, and schedule backups                                                                          |

#### Sharing and settings

| Permission                     | W   | S   | Tier  | Meaning                                                                                                                                       |
| ------------------------------ | --- | --- | ----- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `sharing.manage`               | W   | S   | admin | Invite people, revoke invites and access, change roles, set book grants, link a login to a Family person                                      |
| `permissions.manage`           | W   | S   | admin | Change other people's permissions (§3). New                                                                                                   |
| `workspace.settings`           | W   |     | admin | Create, rename, colour and archive books; move an account to other books; set planning priorities                                             |
| `workspace.security`           | W   | S   | admin | The workspace's security rules (MFA policy, idle timeout), support access grants, and reading the audit log                                   |
| `billing.manage`               | W   |     | admin | Choose a plan, pay, and open the billing portal                                                                                               |
| `workspace.transfer_ownership` | W   | S   | owner | Hand the workspace over to an admin (AUTH-15)                                                                                                 |
| `workspace.restore_over`       | W   | S   | owner | Restore a backup over this workspace                                                                                                          |

#### AI and storage

| Permission         | W   | S   | Tier  | Meaning                                                                    |
| ------------------ | --- | --- | ----- | -------------------------------------------------------------------------- |
| `ai.settings`      | W   |     | admin | AI mode, provider keys, and whether documents may go to the AI             |
| `ai.clear_history` | W   |     | any   | Delete the workspace's AI event log                                        |
| `storage.manage`   | W   | S   | admin | Connect, change and disconnect the workspace's own storage (ADR-0031)       |

**Personal preferences aren't permissions:** which books someone's calendar shows (`PUT calendar/books`), marking
notifications read, sync pushes and AI task results. They stay open to every login, as the member allowlist leaves
them today.

**Where the catalogue lives:** `packages/schemas/src/permissions.ts`.

- It holds the `Permission` enum, each permission's metadata (group, W, S, tier, owner-controlled, what it needs) and
  `ROLE_DEFAULTS`.
- The API, web and phone all import it.
- It is the only source in TypeScript. The database copy (§5) is tested against it.

### 2. Default sets per role (today's behaviour)

✓ means the role holds the permission by default. – means it doesn't.

| Permission                       | owner | admin | partner | member | viewer | accountant | Where it comes from today                                                          |
| -------------------------------- | :---: | :---: | :-----: | :----: | :----: | :--------: | ---------------------------------------------------------------------------------- |
| `transactions.record`            |   ✓   |   ✓   |    ✓    |   ✓    |   –¹   |     ✓      | review `requireRole(...RULE_EDITORS, 'member')`; member allowlist; book access     |
| `trips.record`                   |   ✓   |   ✓   |    ✓    |   ✓    |   –¹   |     –      | `trips.ts` ×3; RLS `trip_write`                                                    |
| `books.set_up`                   |   ✓   |   ✓   |    ✓    |   –    |   –¹   |     ✓      | member guard; RLS `payee_delete`, `payee_alias_all`, `tag_update`, `tag_delete`    |
| `family.manage`                  |   ✓   |   ✓   |    ✓    |   –    |   –¹   |     –      | RLS `family_member_*`                                                              |
| `planning.manage`                |   ✓   |   ✓   |    ✓    |   –    |   –¹   |     ✓      | member guard; book access                                                          |
| `journals.post`                  |   ✓   |   ✓   |    ✓    |   –    |   –    |     ✓      | `journals.controller.ts:188`                                                       |
| `periods.close`                  |   ✓   |   ✓   |    –    |   –    |   –    |     ✓      | `journals.controller.ts:238`                                                       |
| `periods.reopen`                 |   ✓   |   ✓   |    –    |   –    |   –    |     –      | `journals.controller.ts:284, 337`                                                  |
| `reconciliation.undo`            |   ✓   |   ✓   |    –    |   –    |   –    |     ✓      | `UNDO_ROLES` (`reconciliation.controller.ts:177, 348`)                             |
| `imports.run`                    |   ✓   |   ✓   |    ✓    |   –    |   –    |     ✓      | imports ×1, migrations ×4, `STATEMENT_ROLES` ×2, scans; RLS on profiles, migrations, intakes |
| `rules.manage`                   |   ✓   |   ✓   |    ✓    |   –    |   –    |     ✓      | `RULE_EDITORS` ×7; `categorizer.service.ts:517`; RLS `rule_write`, `rule_suggestion_all` |
| `documents.capture`              |   ✓   |   ✓   |    ✓    |   ✓    |   –    |     ✓      | `WRITERS` ×12, `BILL_ROLES` ×2; RLS `file_all`, `document_intake` (bill kind)      |
| `documents.view_members_private` |   ✓   |   ✓   |    –    |   –    |   –    |     –      | `app.can_read_restricted`; `sync.controller.ts:120`                                |
| `business.manage`                |   ✓   |   ✓   |    ✓    |   –    |   –¹   |     ✓      | member guard; `payroll.controller.ts:287`                                          |
| `rentals.manage`                 |   ✓   |   ✓   |    ✓    |   –    |   –¹   |     ✓      | member guard                                                                       |
| `exports.accounting`             |   ✓   |   ✓   |    ✓    |   ✓²   |   ✓    |     ✓      | no role check, only recent sign-in                                                 |
| `tax_package.make`               |   ✓   |   ✓   |    ✓    |   –    |   ✓    |     ✓      | member guard only                                                                  |
| `tax_package.include_private`    |   ✓   |   ✓   |    –    |   –    |   –    |     –      | implicit: the package is read under the maker's RLS                                |
| `backups.books`                  |   ✓   |   ✓   |    ✓    |   –    |   –    |     –      | `backup.service.ts:161`                                                            |
| `backups.workspace`              |   ✓   |   ✓   |    –    |   –    |   –    |     –      | `backup.service.ts:164, 172, 185, 389, 664`                                        |
| `sharing.manage`                 |   ✓   |   ✓   |    –    |   –    |   –    |     –      | `sharing.controller.ts` ×5; `settings.controller.ts:218, 245`; RLS invites, members, grants |
| `permissions.manage`             |   ✓   |   ✓   |    –    |   –    |   –    |     –      | new                                                                                |
| `workspace.settings`             |   ✓   |   ✓   |    –    |   –    |   –    |     –      | `settings.controller.ts:81, 112`; `accounts.controller.ts:63, 74`; RLS `entity_write`, `workspace_update` |
| `workspace.security`             |   ✓   |   ✓   |    –    |   –    |   –    |     –      | `workspaces.controller.ts:43`; `ops.controller.ts:103, 110`; `journals.controller.ts:384`; RLS |
| `billing.manage`                 |   ✓   |   ✓   |    –    |   –    |   –    |     –      | `ops.controller.ts:80, 85, 92`                                                     |
| `workspace.transfer_ownership`   |   ✓   |   –   |    –    |   –    |   –    |     –      | `sharing.controller.ts:210`; RLS `member_update`                                   |
| `workspace.restore_over`         |   ✓   |   –   |    –    |   –    |   –    |     –      | `restore.service.ts:330`                                                           |
| `ai.settings`                    |   ✓   |   ✓   |    –    |   –    |   –    |     –      | `ai.controller.ts:49`; RLS `ai_credential_write`                                   |
| `ai.clear_history`               |   ✓   |   ✓   |    ✓    |   –    |   –    |     –      | `ai.controller.ts:161`                                                             |
| `storage.manage`                 |   ✓   |   ✓   |    –    |   –    |   –    |     –      | `storage-destinations.service.ts` ×8; RLS `storage_destination_owner`, `storage_mirror_item_owner` |

¹ A viewer is refused these today by book access (read-only books), not by a role check. See inconsistency 1.
² See inconsistency 4.

**Not a permission: who must use two-step verification.** `MFA_ROLES` and "accountants always" (`mfaRequired`,
ADR-0044) stay keyed by role. §3.4 adds one rule on top: anyone holding a granted sensitive permission must use MFA
too.

#### Inconsistencies found

These come from reading the code; none was run. The default table reproduces each one as it is. None is silently
changed. Each fix is listed with its own commit and test in the delivery, and only if the owner says yes (Q2, Q5).

**Update, 2026-11-16:** the owner decided 1–3 ahead of this ADR, and each was reproduced by a test and fixed
(`apps/api/test/access-rules.test.ts`): viewers are read-only always (migration 0061), planning settings are owners'
and admins' (a 403), and the sync feed asks `can_read_restricted` (migration 0062). Read 1–3 below as the state
before that; the default table should start from the fixed behaviour. 4 and 5 are unchanged.

1. **A viewer given a write grant on a book can write it.**
   - Nothing stops it: `PUT members/:id/grants` and the invite both accept `access: 'write'` for any role, and
     `entity_access` lets the grant win.
   - Only RLS book access then applies, and the API has no viewer check.
   - The web (`canWriteBooks`, the transaction page's `canEdit`) and the phone (`abilitiesOf`) hide every write from
     a viewer, so the server allows what the clients hide.
   - The ADR's rule that a viewer never writes (§3.2) closes this. That is a behaviour change, so it waits for Q2.
2. **Saving planning priorities as a partner or accountant reports success but saves nothing.**
   - `PATCH planning/settings` has no role check.
   - `RecommendationsService.updateSettings` updates `app.workspace`, whose RLS policy `workspace_update` is
     admin-only, so the update touches no row, raises no error, and returns the merged settings.
   - The phone's `setUp` ability offers planning settings to partners.
   - The table follows what the database enforces: `workspace.settings`, owners and admins only. Fixing the silent
     no-op (a 403, or opening the setting to partners) is part of Q5.
3. **The sync feed hides a person's own private rows from them.**
   - `sync.controller.ts:120` skips restricted rows for everyone except owners and admins (`isAdmin`).
   - `can_read_restricted` also lets the person's own linked login read them, so their phone doesn't hear about
     changes to their own payslips until something else refreshes it.
   - The table maps the check to `documents.view_members_private` unchanged. The fix (use the same rule as RLS) is
     part of Q5.
4. **Members can download the accountant export but can't make a tax package.**
   - `GET exports/accounting` checks only for a recent sign-in, and the member guard covers writes only.
   - `POST tax-package` is closed to members.
   - The table keeps both as they are. Taking `exports.accounting` off members' defaults is part of Q5.
5. **Smaller ones, kept as they are:**
   - RLS `ai_event_all` lets any member delete AI events, while the API allows only owners, admins and partners. The
     API is the stricter side, and it decides.
   - The RLS lists for `payee_insert`, `payee_update`, `tag_insert` and `idempotency_key_*` leave out accountants,
     while accountants may record transactions in books granted to them. This may make some accountant writes fail
     in RLS, which is untested.
   - Accountants may record transactions and receipts but not trips.
   - Partners post journals but neither close periods nor undo reconciliations.
   - The last two look deliberate (ADR-0039, ADR-0041) and are recorded so the parity test pins them.

### 3. Per-person overrides

#### 3.1 What is stored

- An override is **grant** or **deny** of one permission, for one person in one workspace, on their membership.
  "Default" means no override.
- **Effective permissions** = the role's defaults, plus grants, minus denies, limited by the role's ceiling (§3.2).
- **The owner has no overrides**: the owner always holds every permission.
- **A role change clears the person's overrides.** A role is a preset, and switching presets starts over. The audit
  row lists what was cleared, and the confirmation in Settings says what will be.

#### 3.2 What each role can be granted (ceilings)

| Role                          | Can be granted                                                                                              | Can be denied                                 | Why                                                                                                                                                                                                                                                                      |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| owner                         | nothing (holds all)                                                                                         | nothing                                       | The owner is the account of last resort. Removing anything from them could lock the workspace.                                                                                                                                                                         |
| admin                         | nothing extra                                                                                               | anything except `permissions.manage`, by the owner only | The owner may narrow an admin (for example, no private records). An admin with no `permissions.manage` would be an admin who can't do an admin's job, so make them a partner instead.                                                                                  |
| partner, member, accountant   | any **any-tier** permission                                                                                  | any default                                   | **Admin-tier permissions** (sharing, permissions, workspace settings and security, billing, AI settings, storage, whole-workspace backups) **are never grantable** to these roles. Each one changes who sees what, or takes the whole workspace out. Granting one would make an admin under another name, which the Sharing list wouldn't show. Make them an admin instead. |
| viewer                        | only non-write any-tier ones: `documents.view_members_private`, `tax_package.include_private`, `backups.books` | any default                                   | **A viewer never writes**: that is what the role means. A viewer who needs to change something should be a member or partner, so their role tells the truth. The same rule refuses a write book grant for a viewer, once Q2 is answered.                                |
| everyone                      | never `workspace.transfer_ownership` or `workspace.restore_over`                                             | –                                             | Owner-only (AUTH-15). Ownership moves only by handing it over to an admin.                                                                                                                                                                                                |

**Dependencies:**

- `tax_package.include_private` needs `documents.view_members_private`. Granting the first grants both, and denying
  the second also turns off the first. The server checks this; the UI just shows it.
- `documents.view_members_private` without read access to the personal books shows nothing. This is not a
  dependency, because book access is a different axis, but the UI warns about it (§6).

#### 3.3 Who may change overrides

- **The owner** may change anyone's overrides.
- **An admin** (with `permissions.manage`) may change the overrides of partners, members, viewers and accountants,
  with these limits:
  - **Not another admin's overrides.** Admins can't narrow or widen each other. This is Q3.
  - **Not owner-controlled permissions:** `documents.view_members_private` and `tax_package.include_private`. They
    replace ADR-0052's owner-only setting, and private records are the owner's call.
  - **Only permissions the admin holds.** An admin the owner has narrowed can't hand out what they lack.
- **Nobody changes their own permissions.** The same rule as "You cannot change your own role"
  (`sharing.controller.ts`).

#### 3.4 Safeguards

- **Recent sign-in:** every change needs `requireRecentAuth(ctx)` (AUTH-09, 10 minutes).
- **Sensitive permissions** (**S** in §1):
  - **Granting one** needs the changer to have signed in with a second factor (`ctx.user.aal === 'aal2'`), checked
    on the request the way the staff console checks it (`ops/staff.ts:96`). This applies even where the deployment
    has turned the MFA default off.
  - **Holding a granted one** puts the holder under the MFA requirement: `mfaRequired` returns true for them. A
    viewer allowed to see payslips must use two-step verification, as an accountant must (Q4).
- **Audit:**
  - Each change writes an `app.audit_log` row (`permission.granted`, `permission.denied`, `permission.reset`,
    `permissions.cleared_by_role_change`) with the actor, the person and the permission.
  - It also writes an `app.security_event` for the person affected, so it appears in their security activity
    (AUTH-12).
  - A granted sensitive permission also emails the person, as identity changes do (ADR-0045).

### 4. Enforcement

#### 4.1 One resolver, in SQL; `can()` in the API over it

**`app.has_permission(p text) returns boolean`** (SQL):

- It is `security definer` with `set search_path = app, pg_temp`.
- It is true for the owner. Otherwise it applies the role's default from `app.role_permission`, then the person's
  row in `app.member_permission`, then the ceiling.
- It caches its answer per transaction the way `current_member_role` and `entity_access` do: `set_config` keyed by
  workspace, user and `app.cache_gen`.
- The `clear_access_cache` trigger is added on `member_permission`, so a change in the same transaction is seen.

**`app.effective_permissions() returns text[]`** returns the whole set in one call.

**In the API (`apps/api/src/common/permissions.ts`):**

- `can(ctx, permission, resource?)` and `requirePermission(ctx, permission, resource?)`.
- `requirePermission` throws `403 permission.denied` and names the permission: "This needs the 'Run imports'
  permission". This replaces "This action requires the owner or admin role".
- The optional `resource` is `{ entityId }`. For a write permission it also requires write access to that book,
  through the same `entity_access`. PR 2 passes it nowhere, since no site checks books today; it exists so new code
  can ask both questions at once. RLS stays the backstop either way.
- `requireRole`, `requireWorkspaceAdmin`, `isAdmin`, `ADMINS`, `RULE_EDITORS`, the local role constants and
  `memberMayRequest` are deleted at the end of PR 2. A lint-style test refuses their return.

**The member guard becomes a permission guard:**

- A route table maps each non-recording write route to the permission it needs. It replaces `MEMBER_WRITES`, an
  allowlist, with a map.
- Routes with no entry are closed to anyone without `books.set_up`. A new endpoint therefore stays closed to members
  until it is classified, as today.

#### 4.2 Caching

- **Per request.** `WorkspaceGuard` already reads the membership. It also reads `app.effective_permissions()` in the
  same transaction and stores a `ReadonlySet<Permission>` on `ctx.permissions`. Every `can()` in that request reads
  the set, with no further query. This is one extra function call per request on the row it already reads.
- **Per transaction in SQL.** `has_permission` caches the same way `entity_access` does (§4.1).
- **No cache across requests.** A change applies on the person's next request, and is seen by their open
  transaction through `cache_gen`.

#### 4.3 RLS: yes, through the same function (recommended)

RLS must know about permissions. Two reasons:

- **Overrides would otherwise be undone by the database.** Many RLS policies carry role lists
  (`import_profile_all`, `rule_write`, `family_member_*`, `trip_write`, `document_intake` and others). Grant
  `imports.run` to a member while those lists stay, and the API lets them in, then RLS refuses the rows.
- **Private records need a backstop in SQL.** Payslip lines are filtered row by row in `posting`, `journal_entry`
  and the read models. The API can't filter those. So `documents.view_members_private` must be enforced where
  `can_read_restricted` is.

So, in PR 2:

- **Each RLS role list is replaced by `app.has_permission('…')`.** The same permission is used as at the matching
  API site, and the defaults are equal to the old lists, so nothing changes on deploy.
- **`app.is_admin()` stays** where it really means "owner or admin": the `workspace_member` policies that protect
  the owner's row.
- **`app.can_read_restricted(p_member)` becomes** "the person's own login, or
  `app.has_permission('documents.view_members_private')`".
  - Owners and admins hold it by default, so it equals today's `is_admin() or own login`.
  - ADR-0052's tax form policies, which call `can_read_restricted`, pick it up with no change of their own.
  - Book access still bounds it: a payslip in the personal books is invisible to an accountant without a read grant
    on those books, whatever their permissions.

The alternative is RLS keyed by role, with overrides enforced only in the API. It was rejected: it splits the truth,
and any override touching a policy with a role list would fail in confusing ways.

#### 4.4 What the clients get

- **`WorkspaceDto.permissions: Permission[]`** is the signed-in person's effective set. It comes back from
  `GET /v1/workspaces/:id` and the workspace list, next to `role`.
- **`MemberDto`** gains `overrides: { permission, effect }[]`. Owners and admins see it on everyone; others see only
  their own.
- **A client never works out permissions from the role.** The one exception is a workspace cached by an older phone
  build, which has no `permissions` field. That client falls back to `ROLE_DEFAULTS[role]` from
  `@montra/schemas`, as `abilitiesOf` today treats a missing `access` as writable and leaves it to the server.
- **Where the clients use it:**
  - `abilitiesOf` (phone) and `canWriteBooks`, `isAdminRole` and the inline role checks (web) become reads of
    `permissions`, combined with each book's `access` as now.
  - **The server is always the judge.** Hiding is for convenience only.

### 5. Storage

Three tables. The migration is the **next free number at build time**. ADR-0052 now takes 0059 and 0060, so this is
0061 at the earliest.

**`app.permission`** is reference data (the catalogue):

- Columns:
  - `key` (primary key, e.g. `imports.run`);
  - `grp`;
  - `is_write`;
  - `is_sensitive`;
  - `tier` (`owner`, `admin` or `any`);
  - `owner_controlled`;
  - `requires` (the permission it depends on, nullable).
- It is loaded by the migration and changed only by later migrations.
- `montra_app` gets `select`, and no role may write it. It has no workspace, so no RLS, like the reference data
  loaded by `pnpm db:migrate`.

**`app.role_permission`** is reference data (the defaults):

- Columns: `role` and `permission`, the primary key being both, with a foreign key to `app.permission`.
- One row per ✓ in §2. Grants are as for `app.permission`.

**`app.member_permission`** holds the overrides:

- Columns:
  - `workspace_id`;
  - `user_id`;
  - `permission` (foreign key to `app.permission`);
  - `effect` (`grant` or `deny`);
  - `set_by`;
  - `set_at`.
- The primary key is (`workspace_id`, `user_id`, `permission`). A foreign key to `app.workspace_member`
  (`workspace_id`, `user_id`) deletes overrides with the membership.
- **RLS:**
  - It is enabled and forced.
  - **Select:** your own rows, or every row in the workspace if you hold `permissions.manage`.
  - **Insert, update and delete:** `app.has_permission('permissions.manage')`.
  - A `before` trigger, owned by `montra_owner` and with `search_path` set, refuses:
    - a row for the owner;
    - a grant beyond the person's ceiling;
    - the owner-controlled ones unless the changer is the owner;
    - another admin's rows unless the changer is the owner;
    - the changer's own rows;
    - permissions the changer doesn't hold.
  - The API checks the same rules first, for friendly messages. The trigger is the backstop, as RLS is for book
    access.
- `montra_app` gets the usual grants. A statement trigger on `workspace_member` (role changes) deletes the person's
  overrides.

**Grants on the functions:**

- `app.has_permission` and `app.effective_permissions` are executable by `montra_app` and `montra_support`, exactly
  as `app.is_admin()` is, because policies are evaluated in support sessions too.
- `montra_admin` gets nothing, so the pinned function list in `packages/db/test/rls.test.ts` is unchanged for
  `montra_admin`. The support assertions are checked again.

**The single source of the defaults:** the `@montra/schemas` catalogue is the source. A `packages/db` test asserts
that `app.permission` and `app.role_permission` equal it, row for row. A new permission means a migration and a
schemas change in the same PR, and the test fails if either is missing.

### 6. UI

**Web, Settings → Sharing:**

- **Each person shows their role** (the select stays) and a **Permissions** disclosure, closed by default. A summary
  next to it says, for example: "Accountant · 2 changes".
- **Inside the disclosure** are the permissions this person's role may take (its ceiling), grouped as in §1, each
  with its one-line meaning. Each has three states:
  - **Default**: shows the role's value, "On for accountants" or "Off for accountants";
  - **On**: granted for this person, whatever the role says;
  - **Off**: denied for this person.
- **Changed rows are marked**, and **Reset to role defaults** clears them all.
- **Sensitive permissions** carry a note ("They'll need two-step verification"). Saving one asks for a fresh sign-in
  and a second factor if needed (§3.4).
- **Dependencies show inline.** Turning on "Include private records in tax packages" turns on "See other people's
  private records", and the reverse turns both off.
- **A warning appears** when "See other people's private records" is on but the person can't read the personal
  books: "They won't see any until you share the personal books with them."
- **Admin-tier and owner-only permissions aren't listed** for roles that can't take them. A short line says why:
  "Sharing, settings, billing and storage come with the admin role."
- **What the editor sees depends on who they are.** An admin sees owner-controlled rows read-only, with "Only the
  owner can change this", and sees other admins' permissions read-only.
- **Changing a role** asks first when it would clear overrides, and lists them.

**The invite form** keeps role presets only, as now. Overrides are set after the invite is accepted. This keeps the
invite flow and the invite table unchanged.

**The phone, at most a read-only view:**

- More → Sharing shows each person's role and their changed permissions as a list.
- More → Your account shows the person's own permissions, from `WorkspaceDto.permissions`.
- No changes are possible on the phone.

**The owner's example**, the accountant who may see members' tax forms:

1. Open Settings → Sharing and select the accountant.
2. Under Permissions, turn on "See other people's private records". If wanted, also turn on "Include private records
   in tax packages".
3. Give them read access to the personal books under book access.

On the second question: the accountant can make the tax package themselves (`tax_package.make`, on by default, as
today). Whether it includes members' private records is the separate `tax_package.include_private` switch. Owners and
members can still make the package and share the file, as now.

### 7. Migration of existing behaviour

**Zero behaviour change on deploy.** The defaults in §2 equal today's checks, footnoted inconsistencies included. No
override rows exist until someone makes one.

**The parity test plan:**

1. **The API parity table** (`apps/api/test/permissions-parity.test.ts`):
   - **What it covers.** One row per former site: every `requireRole` (38), `requireWorkspaceAdmin` (20), `isAdmin`
     gate (17), local role constant, literal role check, and every route in the member allowlist plus a sample of
     closed member routes.
   - **What each row holds:** method, route, a valid body, and the six roles' expected outcome (`ok` or `403`)
     written from today's role list.
   - **How it runs:** as each role in a seeded workspace, giving every role write access to the books where the site
     needs it, so only the role check decides.
   - **When it's written.** In PR 1, **against today's code**, so it pins today's behaviour before anything moves.
     PR 2 must pass it unchanged.
   - **Owner-approved fixes** (Q2, Q5) each change one row in their own commit, with the reason in the row.
2. **RLS parity** (`packages/db/test/permissions.test.ts`):
   - For each policy moved in PR 2, and each role, the policy's verdict on an insert and a select equals the old
     role list's verdict.
   - `can_read_restricted` gives the same answer for the owner, an admin, the linked login, a partner, a viewer and an
     accountant.
   - The catalogue tables equal `@montra/schemas`.
   - `has_permission` for each role equals `ROLE_DEFAULTS`.
3. **The resolver and overrides:**
   - grant and deny applied;
   - every ceiling and who-may-change rule refused, by the trigger and by the API;
   - a role change clears overrides;
   - the cache is invalidated within a transaction;
   - the sensitive-grant MFA rule;
   - audit rows written.
4. **The guard:** the existing "may write only the routes listed for them" test (`apps/api/test/roles.test.ts`)
   becomes "every non-recording write route is mapped to a permission", generated from the Nest route table. An
   unmapped route fails the test.
5. **A static test:** no `requireRole(`, `requireWorkspaceAdmin(`, `isAdmin(`, `.role === '` (outside sharing's role
   select) or `current_member_role() in` remains in `apps/api/src` or in new migrations.
6. **Clients:**
   - On the phone, `abilitiesOf` from `ROLE_DEFAULTS[role]` equals today's `abilitiesOf` from `role`, for each of the
     six roles × read-only and writable books.
   - The web helpers get the same check.
7. **Existing suites stay green unchanged:** `apps/api/test/roles.test.ts`, `auth-gateway.test.ts`,
   `packages/db/test/roles.test.ts` and `rls.test.ts`, and the e2e sharing specs.

#### Migrating existing toggles

ADR-0052's owner-only workspace setting, "Accountants can see members' tax forms and include them in tax packages",
off by default, is the first per-person permission in disguise. When RBAC is built (PR 3):

1. **If the setting is on,** the migration gives every current accountant in that workspace a **grant** of
   `documents.view_members_private` and `tax_package.include_private`, and writes an audit row saying it came from
   the setting.
2. **The setting disappears from Settings.** The API stops reading it, and the tax form policies read
   `can_read_restricted` only.
3. **The column stays** until a later contract migration (`-- contract:`), so a rollback still reads it.
4. **Accountants invited after the move** get the role's defaults (off), and the owner grants per person. This is
   the intended change: the setting was workspace-wide, and the grant is per accountant.

If RBAC is built before ADR-0052 after all, the setting is never added. ADR-0052 uses
`documents.view_members_private` directly, and its open question 3 becomes a default for this ADR's accountant role.

### 8. Delivery

Four PRs, each into `develop`, each green with `pnpm verify`. Migration numbers are the next free ones at build
time; NNNN below.

1. **The catalogue, storage and `can()`, with no behaviour change.**
   - **Scope:**
     - `packages/schemas/src/permissions.ts` (enum, metadata, `ROLE_DEFAULTS`);
     - `WorkspaceDto.permissions`, filled from `app.effective_permissions()`;
     - `ctx.permissions` loaded in `WorkspaceGuard`;
     - `can()` and `requirePermission()`, used nowhere yet;
     - the parity table written against today's code.
   - **Migration NNNN:** the three tables, the two functions, the trigger and cache hook, and their grants. No policy
     changes.
   - **Tests:** parity (green on today's code), catalogue equals tables, resolver per role, staff-role grant pins.
   - **Phone:** types only (`WorkspaceDto` gains a field; per CLAUDE.md, the web fixtures and mobile types change in
     the same PR). The phone doesn't read it yet.
2. **Moving every check.**
   - **Scope:**
     - every `requireRole`, `requireWorkspaceAdmin`, `isAdmin` and local role list becomes `requirePermission`;
     - the member guard becomes the route-to-permission map;
     - `categorizer.service.ts`'s SQL check becomes `has_permission`;
     - the old helpers are deleted, with the static test.
   - **Migration NNNN+1:** every RLS role list becomes `has_permission`, and `can_read_restricted` is redefined (§4.3).
     There is no data change.
   - **Tests:** the parity table and RLS parity unchanged and green.
   - **Owner-approved fixes:** each in its own commit with its row changed (Q2: viewer write grants refused, existing
     ones turned to read; Q5: the listed fixes).
   - **Phone:** no.
3. **The overrides API and Settings UI.**
   - **Scope:**
     - `GET` and `PUT /v1/workspaces/:id/members/:userId/permissions`, with validation (§3.2, §3.3), recent sign-in,
       MFA for sensitive grants, audit and security events, and the email;
     - `mfaRequired` gains "holds a granted sensitive permission";
     - `MemberDto.overrides`;
     - the Sharing disclosure on the web, with role-change clearing;
     - the ADR-0052 toggle moved (§7), if that ADR has shipped.
   - **Migration:** NNNN+2 only to move the ADR-0052 setting into grants; otherwise none.
   - **Tests:**
     - API: every rule, both allowed and refused;
     - DB: trigger refusals;
     - web: the pure helpers (`lib/permissions.ts`: states, dependencies, warnings);
     - e2e: an owner grants an accountant private records, and the accountant then sees a member's payslip in the
       personal books they were given.
   - **Phone:** no.
4. **The clients consume effective permissions.**
   - **Scope:**
     - Web: `isAdminRole`, `canWriteBooks`, `settingsGroupsFor` and the ~15 inline role checks read `permissions`.
     - Phone: `abilitiesOf` gains per-permission abilities (`importFiles` from `imports.run`, `backUp` from
       `backups.workspace`, `setUp` split into its groups), with the fallback for old caches, and the read-only
       views (§6).
   - **Migration:** none.
   - **Tests:** client parity (§7 item 6); phone unit tests for overridden abilities; web fixtures.
   - **Phone:** yes. Not run on a device until the owner tries the LAN build.

When it's built:

- AUTH-19 is added to `docs/requirements/R1-requirements.md`: "The owner, or an admin within limits, can turn
  individual permissions on or off per person on top of their role."
- `status.json`, `STATUS.md` and §2 of `07-security-privacy-ops.md` are updated: the role table points to this ADR's
  defaults, and the `PolicyService` sentence is replaced by `can()` and `has_permission`.

## Consequences

- **The questions become answerable.** "Can the accountant see W-2s?" and "may the accountant include them in a
  package?" are two named switches per person, default off. Making a package is a third, default on, as today.
- **One place decides.** `has_permission` serves both the API and RLS. The scattered role lists, the allowlist and
  the client mirrors go. The security doc's promise of a single policy check becomes true.
- **A new action has to be classified.** A new endpoint names its permission, or stays closed to anyone without
  `books.set_up`. A new permission needs a migration row and a schemas entry, and a test fails if either is missing.
- **A small cost per request:** one function call when the workspace is opened, and per-transaction caching in SQL,
  as `entity_access` already does.
- **More states to support.** "Why can't they…?" now has role, book access and overrides as answers. The Sharing
  disclosure shows all three for the person.
- **Not per-member scoping.** `documents.view_members_private` is workspace-wide: someone sees everyone's private
  records they have book access to, or no one's. "May see only Alex's payslips" would need a resource-scoped grant,
  which `can(ctx, p, resource)` leaves room for but this ADR doesn't build.

## Alternatives considered

- **Full custom roles.** Owners name their own roles and tick permissions.
  - It is more flexible, but a household has a handful of people, and each custom role needs a name, a description
    and its own upkeep when the catalogue grows.
  - The Sharing list would show names nobody else understands.
  - Per-person changes on six well-known presets cover the real cases, the accountant and the teenager, with less to
    explain.
  - Custom roles could be added later as saved override sets, on the same tables.
- **Attribute-based access control (ABAC).** Policies over attributes (book type, amount, person, time).
  - It is powerful, but it needs a policy language, an evaluator in SQL and in TypeScript, and a way for an owner to
    read the policies.
  - Book access already covers the one attribute that matters (which books). Restricted rows cover the other (whose
    records).
  - It is too much machinery for a family app.
- **Keeping fixed roles plus a few flags.** For example, ADR-0052's accountant setting, then one for exports, one for
  backups.
  - It is the cheapest per flag, but each flag is workspace-wide and for one role. "This accountant but not that
    one" can't be said.
  - The flags multiply with features, each with its own check, and nothing would hold them together.
  - ADR-0052's setting is the stopgap this ADR replaces.
- **Overrides enforced in the API only, with RLS kept on roles.** Rejected in §4.3: it splits the truth, and private
  records need the SQL backstop.
- **Splitting `books.set_up` finer, or folding planning, business and rentals into it.**
  - All four come from the same member allowlist and have identical defaults.
  - Separate groups let an owner give a teenager the budget without the business, which is the case most likely to
    be asked for.
  - Finer than this, such as per report or per screen, would make the switch list too long to read.

## Open questions for the owner

1. **Accountant defaults:** keep accountants off "see other people's private records" and "include them in tax
   packages" by default, so you switch them on per accountant (proposed), and keep accountants able to make tax
   packages of the books shared with them, as today? Yes or no?
2. **Viewers with write access to a book:** today a viewer given a book as "write" can change it, though the apps hide
   it. Close it, so viewers are always read-only and existing write grants to viewers become read (proposed), or keep
   it?
3. **Admins and other admins:** may an admin change another admin's permissions, or only you (proposed: only you)?
4. **Two-step verification for granted access:** anyone given a sensitive permission (for example, a member allowed to
   see payslips) must use two-step verification, as accountants do. Yes (proposed) or no?
5. **Three small fixes in the move (§2):**
   - planning priorities: give partners and accountants a clear "only owners and admins" instead of a save that does
     nothing (proposed), or let them save;
   - your own payslip changes reach your phone;
   - members lose the accountant export.

   Make all three (proposed), or name the ones to keep as they are.
