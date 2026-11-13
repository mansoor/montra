# ADR-0041: Admin and member roles, and family logins

- Status: accepted
- Date: 2026-11-12

## Context

A workspace had four roles: owner, partner, viewer and accountant. Only the owner could manage sharing, AI, storage
and billing, so a couple running the household together had to share one login or leave the owner as the only one who
could change anything. There was no role for a teenager or a business's staff: partner was too much and viewer too
little.

Family members (the Family list) and logins (Sharing) were separate records. Inviting a spouse meant adding them to the
Family list and inviting them under Sharing, with nothing tying the two. `family_member.linked_user_id` existed, and
payslip privacy (PAY-09) already used it, but only the owner's own "self" profile ever got it set. A spouse who signed
in as a partner could not see their own payslips. Any partner could also set the link through the API to any person,
and so read that person's payslips.

## Decision

- **Roles.** Six: `owner`, `admin`, `partner`, `member`, `viewer`, `accountant`.
  - **Admin** (AUTH-14) can do everything the owner can, through `app.is_admin()` in RLS and `isAdmin` /
    `requireWorkspaceAdmin` in the API: entities, sharing, AI, storage, billing, support access, backups, period
    locks, all books, restricted lines.
  - **The owner** stays a single account: the one that created the workspace or was handed it.
  - **Partner** is unchanged: daily use of the personal books plus any granted. No sharing, AI, storage or billing.
  - **Member** (AUTH-17) writes the personal books by default (any others by grant), but only through transactions,
    receipts, trips, the review queue and staff spending claims (PRL-11). A member may upload a claim's receipt but
    not an identity document, and can't approve or decline claims.
  - **Viewer** and **accountant** are unchanged.
- **The owner's row is the owner's** (AUTH-15).
  - RLS lets an admin manage members but not update, delete or create an `owner` row. Only the owner can make someone
    owner.
  - `accept_invite` never changes an existing owner's role.
  - Handing over is `PATCH sharing/members/:id {role: 'owner'}`. It needs the owner, a recent sign-in, and an active
    admin to receive it. The admin is promoted first, then the old owner steps down to admin. The other order would
    leave the old owner unable to touch the owner row.
  - Two things stay the owner's alone: handing over, and restoring a backup over the workspace, which replaces
    everyone's data.
- **Members are kept out of setup by an allowlist** (AUTH-17).
  - `WorkspaceGuard` refuses any write by a member whose route isn't on `MEMBER_WRITES` (`common/roles.ts`), with 403
    `role.member`. A new endpoint is closed to members until someone adds it there.
  - RLS gives members only the table rights that recording money needs: payees, tags, files, trips and idempotency
    keys. They get no rights on family members, rules, rule suggestions or imports.
  - Correcting a category normally may write a rule suggestion. For roles that can't make rules, the categorizer skips
    that step instead of failing the edit.
  - The web hides the setup pages (Ask, Journal, Imports, Rules) and every settings group but "You" from members.
- **Invites can name the person** (AUTH-16).
  - `workspace_invite.family_member_id` holds the person. `CreateInviteRequest.familyMember` takes either `{id}` (a
    person already in the list) or `{name, relationship}` (added in the same transaction). Accepting links the person
    to the login.
  - A login is at most one person per workspace (unique index). A person already linked to another email is refused
    with 409 `invite.family_linked`.
  - Only owners and admins can change `linked_user_id`. The API checks this, and so does a trigger that applies to
    `montra_app` sessions, so `accept_invite` (security definer) still links.
  - The Family list shows each person's sign-in status, with an "Invite to sign in" button. Sharing shows "In the
    family as …" and asks "Who is this?" when inviting.
- **Sensitive actions.** Inviting an admin, or making someone admin, needs a recent sign-in, as inviting an accountant
  already did (AUTH-09). Admins need MFA wherever owners do (AUTH-04).

## Consequences

- Policies changed in place (`alter policy`), so blue/green tasks still running the old code keep working. They just
  don't know the new roles yet.
- The jobs that act as "the owner" (nightly, storage mirror, support grant) still pick the single owner. Storage
  failure notices now go to admins too.
- Payslips stay private as before. A linked login now sees its own, and admins see all, as owners do.
- The phone follows the roles too (AUTH-18). Each book in the workspace DTO carries `access` (`read` or `write`, from
  `app.entity_access`), and `abilitiesOf` in `apps/mobile/src/features/roles.ts` turns the role and those into what to
  show. It only hides; the API still refuses. When adding a member route to `MEMBER_WRITES`, check the phone's
  `setUp`/`record` split still matches.

## Alternatives considered

- **Making admins owners** (several `owner` rows). This is simpler in RLS, but nothing would protect the original
  owner, and the jobs that pick "the owner" would have to choose one.
- **Members see only their own accounts.** This would need account-level filtering in every book and in the
  transaction feed's indexes and RLS (ADR-0009 performance work). Per-book grants already let a business owner keep
  staff to the business books, so this is left for later.
- **A path denylist for members.** This is shorter to write, but it fails open: every new endpoint would be writable by
  members until someone remembered to list it.
