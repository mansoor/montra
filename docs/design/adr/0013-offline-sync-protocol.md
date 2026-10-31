# ADR-0013: Offline sync protocol (pull, outbox push, field-group last-write-wins)

- Status: accepted
- Date: 2026-10-31
- Phase: 4

## Context

PLT-05 asks for an offline mobile mode: view recent data, add transactions offline, and sync with
last-write-wins per field plus a conflict notice. 05 §3 sketches the protocol. ADR-0008 gives a change
feed (`/sync/changes`) that lists changed row ids only; the web re-reads them through the normal API.
A device that applies changes to a local store needs the resolved rows, and it needs a single
idempotent way to replay a queue of edits made offline.

## Decision

1. **Pull: `GET /sync/pull?since=<seq>&days=90&limit=500`.**
   - The server walks the change feed after `since`. It maps `transaction`, `journal_entry`, `posting`
     and `transaction_tag` rows to transaction ids, and returns full `TransactionDto`s re-read under RLS.
   - Transactions the member can no longer see (voided, deleted, or with access revoked) come back in
     `removedTransactions`.
   - Accounts, categories, members and entities are returned whenever they appear in the page.
   - `since=0` is a bootstrap. It returns every reference row plus the last `days` of transactions, with
     `full: true`.
   - Pages end on transaction boundaries, as in ADR-0008.
2. **Push: `POST /sync/push { ops[] }`.** Up to 100 ops, applied in order, each in its own database
   transaction, so one rejected op doesn't block the rest.
   - **Op kinds:** `transaction.create`, `.update`, `.delete`, `review.accept` and `review.resolve`.
   - **Replays:** every op carries a client `opId` and is recorded in `sync_op`. A replay returns the
     stored result with `status: duplicate`.
   - **Creates** use the client-generated transaction id. A create whose id already exists is a duplicate.
3. **Field-group last-write-wins.**
   - **Groups:**
     - `ledger` = account, amount, category, splits and member. It is atomic, so the entries always
       balance.
     - The independent groups are `payee` (payee, description), `date`, `memo`, `tags` and `review`.
   - **Clocks:** each transaction keeps `field_clock` = `{ group: { v, at } }`: the row version and
     the time at which that group last changed. It is set on every server-side change: API, imports,
     rules and review.
   - **Merging an update.** An update carries `baseVersion` and the device's `changedAt`. For each
     group the op touches:
     - if `field_clock[g].v <= baseVersion` (nobody changed it since the device's copy), apply it;
     - otherwise apply it only if `changedAt > field_clock[g].at`, and record a conflict either way.
   - **Result:** `merged` with `conflicts[]` (group, winner and both times), which the device shows as
     a notice.
   - **Rejections:** a merge that fails validation (a locked period, a deleted account, a category
     from an entity the member can't write) is `rejected`. The device keeps the op as a draft for the
     user to edit or discard.
   - **Clock skew:** device times later than the server's receive time are clamped to the receive
     time, so a fast device clock can't win every conflict.
4. **The engine (`packages/sync`) is shared and platform-neutral.**
   - Mobile implements `SyncStore` with expo-sqlite. The database is encrypted with SQLCipher, using a
     random 256-bit key kept in SecureStore (Keychain or Keystore), and `wipe()` deletes the database
     and the key (BAK-10).
   - Local writes are optimistic: the row is marked `pending` until the op is acknowledged.
5. **Push notifications.** Devices register Expo push tokens with `POST /v1/me/push-devices`, removed
   on sign-out. Sending notifications arrives with NOT-01 in a later phase.

## Consequences

- The device needs no ledger logic. It shows the server's `TransactionDto` projection, plus a simple
  optimistic overlay for pending edits.
- Two devices editing the same transaction offline converge per group. The losing edit is visible in
  the conflict notice and isn't silently lost.
- `sync_op` grows with every op. It is purged after 30 days, which is longer than any realistic
  offline period, and the device drops an op once it is acknowledged.
