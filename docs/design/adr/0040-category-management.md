# ADR-0040: The user's own categories

- Status: accepted
- Date: 2026-11-12

## Context

Every set of books got a fixed list of categories from the chart template when it was created, and nothing could
add, rename or retire one. A user looking for "Miscellaneous" for a 25¢ bag fee found no such category and no way to
make it. Categories are ledger accounts (`app.ledger_account` with `is_category`, a `category_group_id` and an
`archived_at` that only budgets and the categorizer were reading), so the data model already had room for this.

## Decision

- **Endpoints.** `POST categories` adds one (entity, name, kind, optional group and tax line); `PATCH categories/:id`
  renames, moves to another group of the same books, archives or unarchives; `GET category-groups` lists an entity's
  groups; `GET categories?include=archived` lists archived ones too, flagged. `CategoryDto` gains `groupId`, `archived`
  and `fixed` (all optional, so categories cached on a phone before this still parse).
- **Defaults.** Without a group, income goes in the books' income group and spending in the usual group for the books
  (Daily living, Business expenses, Rental expenses). Business and rental categories start on their form's "other" line
  (Schedule C 27a or 6, Schedule E 19 or 3), which the existing tax-line control changes. Personal ones have none.
- **Names** are unique per entity and kind, ignoring case and outer spaces. A clash with an archived category says so
  ("unarchive it instead") rather than making a second one. The check is in the service, not a unique index, because
  imports and older data may already hold such pairs.
- **Never delete.** A category on postings can't go, and one that isn't today may be tomorrow, so retiring means
  archiving: it leaves `GET categories` (so the sync pull, every picker and the AI's options), rules whose action sets
  it are skipped, and payee and receipt-item history pointing at it doesn't suggest it. Its transactions, budgets and
  reports keep it, and unarchiving restores all of that.
- **Built-in categories** (a `system_role`: Uncategorized, FX, bank fees) can't be renamed, moved or archived: the
  ledger finds them by role.
- **Who.** RLS decides, as for every entity-scoped write: `can_write_entity`. A viewer or a read-only grant gets 403.
- **Phone.** The category picker ends with "Add a category"; it needs a connection, creates the category on the server,
  runs a sync so the store has it, and picks it. The phone keeps no rules of its own about names or groups beyond an
  early warning.
- **Miscellaneous** is in the personal template's Daily living group. Migration 0040 adds it once to existing personal
  books through `app.add_miscellaneous_category`, skipping books with a category of that name in any case.

## Consequences

- Rules can point at an archived category; they pause rather than fail, and resume on unarchive. The rules page doesn't
  flag them yet.
- Creating a transaction through the API with an archived category's id still works (old clients, undo, restore); the
  clients never offer one.
- Merging two categories (moving every posting from one to another) is not part of this; archiving the unwanted one and
  recategorizing with a rule or bulk edit covers it for now.

## Alternatives considered

- **Delete when unused.** Simpler to explain, but a category with no postings today can still be named by rules,
  budgets, receipt-item history and exports; archiving is safe in every case.
- **A unique index on lower(name).** Would have to clean up existing duplicates first, and would block imports that
  rely on the current lookup; the service check gives a clearer message anyway.
