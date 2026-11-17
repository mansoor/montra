# ADR-0054: The household's Family Document Vault as a storage provider

- Status: proposed (draft; open questions for the owner at the end)
- Date: 2026-11-17
- Builds on: ADR-0031 (your own storage: the destination port, the outbox, retries, sealed secrets), ADR-0050 (hosting
  anywhere), ADR-0019 (backups, archives, retention, purge), ADR-0016 and ADR-0041 (restricted payslips), ADR-0034 §3
  (sealed copies of identity documents), ADR-0052 (tax forms, a restricted kind)
- Amends: ADR-0031 §1 ("mirror, don't move") for this one kind of destination, and ADR-0031 §3 (one connection per
  workspace)
- Requirements: BAK-03, BAK-05, BAK-08, BAK-09, RCP-10, NFR-03; adds VLT-01..10 (§14)

## Context

The owner also runs the **Family Document Vault** (the vault): a separate app where a household keeps its papers. The
vault has added a way for other apps to connect to it, and the owner wants Montra to use it as the place a workspace's
documents live: statements, receipts, invoices, leases and, perhaps, payslips and tax forms.

The vault's side is specified in **the vault's private connected-apps contract (not in this repo)**. This ADR describes
only what Montra does, in Montra's terms and at the level of behaviour. It deliberately names no routes, fields, codes
or limits from that contract: Montra's repository is public, and the contract is not (open question 1).

What is known about the vault's side, at that level:

- **Connecting.** A vault owner registers an app in the vault, chooses the vault member the app acts as, and pastes the
  app's public key. Each app has its own **Ed25519** key pair. The vault then gives a short connection code to paste
  back into the app.
- **Every request is signed** with HTTP Message Signatures (RFC 9421), inside a short time window, with a fresh value per
  request. There are no bearer tokens or sessions. Requests go over **HTTPS only**; plain http is accepted only from the
  same machine (loopback), which is for development.
- **Sending** (shipped): a document goes in with an id the app chooses, which makes a resend harmless. It lands in the
  acting member's vault **Inbox**, held for a person to review. The app can ask what became of it: still waiting,
  **filed** as a vault document, or not kept (the family removed it, it lapsed undecided, or the vault refused it).
  Only once it is filed is the vault's copy the household's record.
- **Reading** (shipped): the vault owner grants reads by kind or category, with a lookback. The app reads a **cursor
  changes feed** of what changed, and downloads files **within a daily byte cap**. The vault decides what an app may
  read, and can stop an app seeing a document at any time without saying why.
- **Opening and deleting** (coming): **single-use view links** that a person's browser opens, and per-app handling of
  an app's deletes, chosen by the vault owner.
- The vault has a client library and a fake vault for tests, in its own private repository.

Montra's side today (ADR-0031): one S3-compatible or WebDAV destination per workspace, which Montra only writes to. It
mirrors files by kind (`STORAGE_FILE_KINDS`: statement, receipt, payslip, lease, invoice, other, tax_form) through an
outbox (`app.storage_mirror_item`) and one system job (`storage.mirror`). Montra's own object storage (`StoragePort`)
always keeps its copy, and everything that reads a file reads that copy: OCR and scan reading, previews, matching,
retention, quota, backups and archives, tax packages and payroll forms.

Points already agreed between the owner and the vault's plan:

1. Per workspace, one Ed25519 key pair, encrypted at rest and never reused across workspaces (or vaults).
2. The vault's address is reached over public HTTPS only.
3. Retries reuse the document's id, so nothing is filed twice.
4. The workspace chooses which kinds of document go to the vault, and whether to keep a backup copy at Montra's own
   storage or at their own S3/WebDAV.
5. A backfill moves documents one at a time, and a source may be deleted only once the vault reports the item filed.
6. The vault wins on edits; Montra reads them through the changes feed.
7. View links are single-use.

## Decision

### 1. A new destination kind, `fdv`, that can be the record

The vault becomes a third destination kind beside `s3` and `webdav`. Unlike them, it can be **the record** of a
document, which ADR-0031 §1 ruled out for the others. For each connection the owner chooses one of two roles:

| Role                     | What Montra keeps                                                                                                    | Who has the record                   |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| **Copy to the vault**    | Its own copy of every file, as today. The vault gets a copy, like a mirror.                                          | Montra                               |
| **The vault is the record** | Once a file is filed in the vault, Montra keeps a backup copy where the owner chose (below), and a reference to the vault document. | The vault, for the kinds sent there |

For "the vault is the record", the backup copy is one of:

- **At Montra** (the default): Montra's own copy stays. Nothing that reads files changes; the vault is the household's
  record and Montra's copy is a convenience copy.
- **At your own storage**: the workspace's S3/WebDAV destination (ADR-0031) holds the copy, and Montra's own copy is
  removed once the vault has filed the file *and* the mirror has copied it.
- **None ("vault only")**: Montra's copy is removed once the vault has filed it. Offered only if the owner agrees
  (open question 9), and always behind a warning that the vault's settings then decide what Montra can still open.

So a workspace may have a vault connection **and** an S3/WebDAV connection. The one-per-workspace unique index becomes
one per class: at most one mirror (`s3` or `webdav`) and at most one vault. ADR-0031 §3 already allowed for dropping it.

The connection's kinds (which Montra kinds go to the vault) are chosen as for a mirror, with the exceptions in §6.
Copy and record are per connection, not per kind, to keep the choice understandable; a later change can make them per
kind if asked for.

### 2. Connecting: Montra makes the key, the vault owner registers it

Only a workspace **owner** connects, changes the role, starts a move, or disconnects (open question 4), with a recent
sign-in (AUTH-09), as for taking a backup. Admins can see the status and press "Try again".

1. **Montra makes the key pair** in the API process when the owner chooses "Family Document Vault" in Settings →
   Storage. It is a fresh pair for this workspace, never one used before. The private key is sealed at once (§7); the
   public key and its fingerprint are shown with a **Copy** button, with the steps to register Montra in the vault.
2. **The owner (or whoever owns the vault) registers Montra in the vault**, choosing the vault member Montra acts as and
   what it may do, and gets a connection code back.
3. **The owner pastes the code into Montra.** Montra checks, in order:
   - that the code names the key Montra made for this workspace (a code for another key is refused);
   - that the vault's address passes the address guard (§8);
   - that the server there identifies itself as a Family Document Vault that accepts apps, and which vault it is.
     Montra **pins** that identity, and stops the connection (and tells the owner) if a later answer shows a
     different vault at the same address;
   - a signed connection test. It tells Montra which member it acts as, the household's
     name, which kinds it may send, which reads it has been granted, and the current limits.
4. If the vault says the member Montra acts as must still approve it, the connection is saved as **waiting for
   approval**, and Montra checks again on its own (and when the owner presses "Check again").
5. The address, Montra's app and key identifiers in the vault, and the vault's identity are saved in the connection's
   `config`; the sealed private key in `secret_enc`.

**Key rotation** ("Replace the key", owner only): Montra makes a new pair, registers it with the vault under the old
key, and keeps signing with the old one until the vault reports the new one confirmed by a person on the vault side.
It then switches, and the old key is retired. Both private keys are sealed in `secret_enc` during the change. A
rotation is also the response to a suspected key leak, alongside the vault owner removing the app.

### 3. What goes, and when

- **The trigger** on `app.file` (ADR-0031 §5) also adds a row to the vault's outbox (§11) when the workspace has a vault
  connection that takes that kind.
- **A file goes only when Montra is done with it.** It is sent after its own processing finishes (scan reading,
  statement import, receipt extraction, payslip or tax-form reading) and it has no open Review item, so Montra never
  needs the bytes back for its own first pass. A file still being processed waits in the outbox as `queued`.
- **Kinds are mapped, not hard-coded.** The vault says at connect time which of *its* kinds Montra may send. The owner
  maps each Montra kind to one of them in Settings (Montra suggests the obvious ones). A Montra kind left unmapped is
  not sent, and Settings says so. The map is re-checked against the vault's list at every run, because the vault's
  owner can change what Montra may send.
- **File types.** The vault keeps documents and images. Montra asks it at connect time which types it takes; files of
  other types (a CSV or OFX statement export, say) stay in Montra only, and are shown as "not a type the vault keeps".
- **What Montra says about a document.** The vault accepts descriptive hints with a file, which it treats as
  suggestions: it reads the file itself. By default Montra sends only what the paper is (the mapped kind), a title made
  from the file name and its entity, its date, and the person it is about when Montra knows (by name, as the household
  knows them). Amounts and account last-four digits are **not** sent unless the owner turns on "Describe documents in
  more detail" (open question 5). Montra never sends transactions, ledger data, or anything a person didn't upload.
- **Whose Inbox.** Every document lands in the Inbox of the one vault member the connection acts as. Montra's person
  hint is a suggestion of whom the paper is about, not where it goes (open question 3).

### 4. Sending, one at a time, without duplicates

For each outbox row, oldest first, with **one request in flight per connection** and a pause between sends:

1. **Its id is chosen once** (an opaque value derived from the workspace and file ids, never a name or an amount) and
   saved on the row **before** the first send. It never changes, through retries and crashes.
2. **Send** it, signed afresh for every attempt.
3. **An answer** means the vault has it durably. Montra checks the vault's hash of the file against its own; a mismatch
   is a failure that stops the row and is shown to the owner. The row becomes `received` (in someone's Inbox) or
   `filed`.
4. **No answer** (timeout, dropped connection): Montra asks the vault about that id before sending again. Unknown means
   it never arrived, so it is sent again; known means it arrived, and its state is used.
5. **Not kept** by the vault:
   - the family removed it from the Inbox: the row is `not_kept`, Montra keeps its copy, marks the file "not taken by
     the vault", and tells the owner. It is **not** sent again unless a person asks, because the family decided;
   - it lapsed undecided in the Inbox: sent again under the same id, at most once on its own; after that it waits for a
     person to press "Send again";
   - the vault refused it (a kind Montra may no longer send, a type it doesn't keep, too large): `not_kept` with the
     reason in words, and Montra keeps its copy.

### 5. The vault is the record: removing Montra's copy

Only for a connection whose role is "the vault is the record", and only when **all** of these hold:

1. the vault reports the item **filed** (never while it is only in the Inbox: an Inbox item can still be removed or
   lapse);
2. the backup copy exists where the owner chose: Montra's own (nothing to do), or the mirror reports the file `done`;
3. the file has no open Review item or running job;
4. the connection is active.

Then, in one transaction: the file's `location` becomes `vault`, the vault document's id is recorded, the old storage
key is kept on the outbox row as the object still to remove, and an audit row says the file moved. The object is
deleted after the transaction commits, and only then is `source_removed_at` set. A crash in between leaves a row whose
object is still to remove, which the next run deletes; there is no window in which the file has no copy anywhere.

**Reading a file whose bytes Montra no longer holds** goes through one place (`FileBytes`, replacing direct
`StoragePort.get` calls by the readers listed in Context). It tries, in order: Montra's copy, the backup copy at the
owner's storage (a new read for S3/WebDAV, used only here), then a download from the vault (counted against the daily
read cap, and only if a read grant covers that document). Each caller gets a typed "not available now" result, with the
reason and when to try again, and degrades in words rather than failing (open question 2 decides which callers may
wait for it). Showing a document to a person never goes through `FileBytes`; it uses a view link (§9).

### 6. Restricted and sealed kinds

- **Sealed copies of identity documents** (ADR-0034 §3) are never sent, as they are never mirrored: they are
  ciphertext the vault couldn't read.
- **Payslips and tax forms** are restricted in Montra: a member's are visible only to that member, owners and admins
  (and, for tax forms, accountants when the owner allows it). In the vault they would land in the acting member's Inbox
  and then be visible as the vault's own settings say, which Montra cannot check or narrow. So, until the owner decides
  (open question 3):
  - both kinds are **off** for a vault connection, and can't be turned on by an admin;
  - when the owner turns one on, Settings warns that "who can see it in the vault is set in the vault, not in Montra",
    names the vault member the documents will go to, and records the choice in the security log;
  - a member's restricted document is sent with that member as the person hint, so the vault can file it to them.
- Business documents (invoices, receipts of a business entity) go only if their kind is on; a later version may offer a
  per-entity choice.

### 7. Keys and other secrets

- The private key (and, during rotation, the second one) is sealed as one JSON value with `FieldCrypto`: AES-256-GCM
  under the workspace's KMS-wrapped data key, bound to `storage_destination.secret` as today's secrets are
  (ADR-0031 §3). On a self-hosted install the KMS adapter is whichever ADR-0050 §3 configured.
- It is unsealed only in the worker or API process that signs a request, held in a `KeyObject` for that run, and never
  logged, returned, exported or written anywhere else. The logger's redaction paths gain the signature headers and the
  view-link field, and request logging for vault calls records only the method, the path's shape and the status.
- The public key and its fingerprint are not secret and are shown to owners, so they can compare them with the vault.
- A key belongs to one workspace and one vault. Disconnecting destroys it; connecting again makes a new one. A purged
  workspace loses it with everything else (ADR-0019 §12).
- Archives exclude the connection, its secret and its outbox, with a reason in the catalog test (ADR-0031 Consequences).
  A restored workspace starts unconnected.
- Signatures are only accepted within a short window of the vault's clock, so the worker's clock matters. Montra
  measures its offset from each vault answer, shows "Montra's clock is off" when it is large, and the self-hosting
  runbooks (ADR-0050 §5) gain an NTP check.

### 8. Where Montra may connect

- The address guard (`destinations/guard.ts`) is reused: the address is checked when each connection is made, so a name
  that later resolves to a private address is refused (DNS rebinding).
- **Public HTTPS always** for a vault, in production and on a self-hosted install alike, whatever
  `STORAGE_DESTINATIONS_PRIVATE` says (that switch stays for S3/WebDAV). This follows the agreed point; open question 6
  asks about Montra and the vault on the same machine.
- Development and tests may use a loopback fake vault over http, behind a setting that production refuses to start
  with.
- Redirects are never followed, every request has a connect and a total timeout, and responses are size-limited.
- The vault can restrict an app to known source addresses. Montra's outbound address on a home server or a VPS is not
  fixed today (open question 7).

### 9. Keeping in step with the vault, and opening documents

- **The vault wins on the document.** For a file in the vault, the changes feed is the source of what the vault calls
  it: its kind, title, dates and whether it still exists. Montra stores that on the outbox row (`vault_meta`) and shows
  it ("In the vault as: Bank statement, October 2026"). It never changes Montra's books: transactions, payslips, tax
  form boxes and matches stay as Montra has them. A newer file put in the vault by the family is shown as "the vault
  has a newer version"; Montra doesn't re-read it on its own.
- **The feed** is read by the job a few times an hour, and before a vault-held document is shown. Montra saves its
  position only after it has processed a page.
- **No longer available.** When the vault says Montra may no longer see a document, the row becomes `out_of_reach` and
  the file shows "No longer available in Family Document Vault", with no guess at why. If Montra still has a copy
  (record and copy, or copy to the vault), nothing else changes. If it doesn't, the file can't be opened from Montra
  until the vault shows it again; it is never deleted from Montra's books.
- **Starting over.** When the vault says Montra's feed position is no longer valid (for example after the vault was
  restored from a backup), Montra reads the whole feed again, and treats any document it holds that isn't in it as out
  of reach.
- **Opening a document** that only the vault holds (or, for any vault-held document, "Open in the vault") mints a
  single-use view link **when the person clicks**, and the API answers with a redirect to it at once. The link is never
  stored, logged, cached, emailed, put in a notification or prefetched, and the web app never renders it into a page. On
  the phone, the app asks the API and hands the link straight to the system browser. A link that can't be used (the
  vault can't draw that type, or too many links this hour) gets a message in words, and for a type the vault can't draw,
  a download link instead when the vault allows downloads.
- **Who may open** a vault-held document in Montra is who may open the file in Montra today (row-level security on
  `app.file` and the restricted rules). The vault then applies its own rules to the link as well.

### 10. Deleting

- **Trash** never touches the vault, as for a mirror.
- **Deleted for good** (after the trash, at a retention date (RCP-10, BAK-09), or with a purged workspace): Montra drops
  its copy and its reference. The vault document is left alone by default: the household's record is theirs. The
  connection has the same switch as a mirror, "Also delete it in the vault when Montra deletes a file for good", off by
  default. When it's on, Montra asks the vault to delete, and the vault does what its owner set for Montra's deletes
  (keep it but let go of it, or move it to the vault's own trash). The feed, not the answer, is the record of what
  happened.
- **An Inbox item** that Montra's own file loses before it is filed (the file is deleted for good) is withdrawn from the
  Inbox, so the family isn't asked about a document that no longer exists in Montra.
- **Disconnecting** when some files exist only in the vault (no copy at Montra or the owner's storage) first offers
  "Bring the files back" (downloads them, over several days if the vault's daily cap needs it) and only then
  disconnects. "Disconnect anyway" keeps the references, shown as "In the vault, not connected".

### 11. Data model and migration sketch

One migration (number assigned when it is written), append-only and backward compatible:

- **`app.storage_destination`**:
  - `kind` check gains `fdv`;
  - the unique index `storage_destination_one` is replaced by two partial unique indexes: one for `kind in ('s3',
    'webdav')` and one for `kind = 'fdv'`;
  - for `fdv`, `config` holds the vault's address and pinned identity, Montra's app and key identifiers there, the
    public key and fingerprint, the acting member's display name as last reported, the role (`copy` or `record`), the
    backup choice (`montra`, `own_storage`, `none`), the kind map, and the detail switch; `secret_enc` holds the sealed
    private key(s); `delete_with_montra` is reused;
  - `status` gains `needs_vault` (waiting for approval, paused or removed on the vault's side, or a key waiting to be
    confirmed), with `last_error` in words.
- **`app.vault_connection_state`** (one row per vault connection): the feed position and when it was last read, the
  last full re-read, the vault's next daily reset and "sending held until" and "downloads held until" times, the measured
  clock offset, and the key-rotation state. Not secret; RLS as for `storage_destination` (owners and admins).
- **`app.vault_item`** (one row per file and vault connection; the outbox): `vault_ref` (the id chosen once, unique per
  connection), `status` (`queued`, `pending`, `received`, `filed`, `not_kept`, `failed`, `out_of_reach`, `delete`),
  `not_kept_reason` (Montra's own words and whether a resend is allowed), `vault_document_id`, `vault_version`,
  `vault_sha256`, `vault_meta` (jsonb, as last read from the feed), `received_at`, `filed_at`, `source_key` (Montra's
object still to remove, §5), `source_removed_at`,
  `attempts`, `next_attempt_at`, `last_error`. Indexes on due rows and on `vault_document_id`. RLS enabled and forced,
  owners and admins only, as `storage_mirror_item`.
- **`app.file`**: `location text not null default 'montra'` (`montra` or `vault`), and `storage_key` loses `not null`
  (a file held only in the vault has no Montra object); a check keeps `storage_key` set whenever `location = 'montra'`.
- **The triggers** from migration 0029 are extended: a stored file also queues a vault row; a file deleted for good marks
  a filed row `delete` only when `delete_with_montra` is on, removes a `received` row's Inbox item (§10), and removes
  other rows.
- **Definer functions** `app.vault_due()` and `app.vault_next()` mirror `app.storage_mirror_due()` and
  `app.storage_mirror_next()`.
- **Security log kinds**: `vault_connected`, `vault_changed` (role, backup, kinds, detail, restricted kinds),
  `vault_key_replaced`, `vault_move_started`, `vault_disconnected`. **Audit log**: one row per file moved
  (`file.moved_to_vault`), per file brought back, and per view link minted (file id and who; never the link).
- **Notification types**: `vault_attention` (the vault needs something from a person: approval, a paused or removed
  app, a key to confirm; daily dedupe, no file names), and the existing `storage_failing` for repeated failures.

DTOs (`packages/schemas/src/storage.ts`): `StorageDestinationKind` gains `fdv`; a `VaultConnectionDto` (the address,
the vault's household name, the acting member's name, the fingerprint, role, backup, kind map, counts by status, held
until, clock offset); requests for start, paste-the-code, change, replace the key, move, bring back; `FileDto` gains
`location` and a `vault` summary. Mobile types and the web fixtures change with them (CLAUDE.md).

### 12. Jobs

One system job, `storage.vault`, separate from `storage.mirror` because its pacing, states and failure handling differ.
It reuses the mirror's shape: due connections through a definer function, each under an owner's RLS context, rows
claimed with `for update skip locked` and a lease, a run budget, then a reschedule for whatever is due next. Per
connection, a run does, in order:

1. **Check the connection** with the signed connection test at the start of a run when it last failed or is waiting, and at
   least daily otherwise; refresh the allowed kinds, grants and limits.
2. **Send** due rows one at a time (§4).
3. **Ask about received rows** in batches, and mark them filed or not kept.
4. **Remove sources** that meet §5.
5. **Read the feed** (§9), or start over when told to.
6. **Deletes** (§10) and withdrawals.
7. **Move/copy backfill** progresses through the same send step; it only adds rows.

**Retries and limits:**

- The vault says whether a failure is worth retrying and, often, how long to wait. Montra waits at least that long, plus
  a little random jitter, re-signs, and tries again.
- Otherwise Montra's own backoff from ADR-0031 §5 applies (1 minute up to daily), and a row gives up after the same
  number of attempts, staying `failed` until "Try again".
- **The daily caps** are not failures. When the vault says the day's sending is used up, sending is held until the
  vault's next daily reset, and the status says "Waiting for the vault's daily limit, until …". Reads and downloads
  have their own hold. Neither counts toward `failing`.
- **A problem with the connection itself** (the key isn't recognised or not yet confirmed, the app was paused, removed,
  not approved, or lacks a permission, the clock is off) stops the whole connection at once: status `needs_vault`, the
  vault's own message shown to owners (it is written for people), and one `vault_attention` notification. Nothing is
  retried until a run's connection check passes again.
- Unknown failures follow the usual rule: a client error isn't retried, a server error is.
- Five failures in a row with no success turn the connection `failing`, as for a mirror.

**Backfill.** "Also send the N documents already in Montra" (on connect) and "Send existing documents" later add
`queued` rows for every file of the chosen kinds not in the trash. Settings shows how long it will take at the vault's
current daily limit, and suggests asking the vault's owner for a temporary higher allowance. A **move** is the same
backfill on a "record" connection: §5 then removes each source as its document is filed. The job resumes from the
first row not yet received after a crash; asking about the id before resending makes a second send harmless anyway.

### 13. What people see

**Web, Settings → Storage** gains a "Family Document Vault" card beside "Your own storage":

- connecting in three steps (§2): the public key and fingerprint with Copy, what to do in the vault, then paste the
  code; "Waiting for <name> to approve Montra in the vault" until it is approved;
- the role and backup choice, in words: "Keep Montra's copy too" (default), "Keep a copy in my own storage", "Keep it
  only in the vault";
- the kinds, each with the vault kind it maps to; payslips and tax forms off, with the warning in §6;
- status: sending, in someone's Inbox, filed, not taken, failed, out of reach; the last error in words; any hold for the
  daily limit; the clock warning; "Check again", "Try again", "Send again", "Replace the key", "Bring files back",
  "Disconnect";
- the move/copy backfill with its estimate and progress.

**Files and documents** (receipts, statements, payslips, invoices, leases, tax forms): a small "In the vault" badge, the
vault's name for the document, "Open in the vault", and "No longer available in Family Document Vault" or "Not taken
by the vault" when that is so.

**Phone:** Your data → Storage shows the vault's status line next to the mirror's (read only; connecting is on the web,
as the key step needs copying between apps). Files show the same badges, and "Open in the vault" goes through the API
to the system browser (§9). Nothing about the vault is kept in the phone's offline store beyond the file's `location`
and status.

### 14. Requirements

A new subsection, **13.6 Family Document Vault**, in `docs/requirements/R1-requirements.md`, added by the first PR:

| ID     | Requirement                                                                                                                                       | Priority |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| VLT-01 | An owner connects the workspace to the household's Family Document Vault with a key pair Montra makes for that workspace, checks the vault's code and identity, and sees whether it's approved. | S |
| VLT-02 | The owner chooses which kinds go to the vault, how each maps to the vault's kinds, and whether the vault is a copy or the record, with a backup copy at Montra or their own storage. | S |
| VLT-03 | Documents are sent one at a time after Montra has finished with them, are never filed twice, and show their vault status per file and in total. | S |
| VLT-04 | Existing documents can be copied or moved; a move removes Montra's copy only after the vault has filed the document and the chosen backup exists. | S |
| VLT-05 | The vault's changes are read and shown, and win on the document but never change the books; a document the vault no longer shows is marked so, without a reason. | S |
| VLT-06 | A vault-held document opens through a single-use link made when the person clicks, never stored, logged or sent.                                   | S |
| VLT-07 | Payslips and tax forms go to the vault only if the owner turns them on after a warning; sealed copies of identity documents never go.              | M |
| VLT-08 | The private key is sealed, never shown, logged or reused across workspaces, and can be replaced; connecting, changes, moves and disconnecting are in the security log; files moved and links made are audited. | M |
| VLT-09 | The vault's daily limits and waits are respected without counting as failures; problems are shown in words, and owners are told once when the vault needs a person. | S |
| VLT-10 | The phone shows the vault status and badges, and opens vault-held documents.                                                                        | C |

### 15. Testing

- **The signer** is tested against fixed vectors: a known key, request and clock give a known signature base and
  signature, byte for byte. Where those vectors live depends on open question 1, since they show the signing profile.
- **A fake vault** runs as a local server in the API's integration tests (real Postgres, as the other suites). It
  verifies signatures, enforces idempotency by id, holds documents in an Inbox until the test files or declines them,
  serves a changes feed and downloads under a daily cap, mints single-use links, and can be told to fail in each way
  §12 handles (retry with a wait, daily cap, connection problems, a hash that doesn't match, a lost answer). Its source
  depends on open question 1.
- **Montra's own guarantees**, each with a test: an id is saved before the first send and never changes; a lost answer
  leads to a status check, not a second document; no source is removed while its item is only in the Inbox, or before
  the backup exists; restricted kinds don't go unless the owner turned them on; sealed files never go; a key is never
  in a log line, DTO, archive or error; a view link is never written to the database or logs; a connection problem
  stops the whole connection; a cap hold doesn't count toward `failing`; a pinned vault identity that changes stops
  the connection; the address guard refuses private addresses and http in production.
- **RLS and catalog tests** for the new tables (owners and admins only; excluded from archives with a reason).
- **Web** unit tests and one Playwright spec against the fake vault (connect, send, file, open). **Phone** pure-module
  tests for the status line and badges.
- **One live run** against the vault's development build behind HTTPS, by hand, before the record role is enabled
  (the vault refuses plain http from another machine).

## Delivery

A chain of small PRs into `develop`, each with its dev bump, after this ADR is accepted and open questions 1–3 are
answered:

1. **Contracts**: the migration, Kysely types, DTOs, requirements VLT-01..10 in `status.json`; the signer and vault
   client (where open question 1 puts them) with their vector tests; the fake vault.
2. **Connecting**: key making and sealing, the code check and identity pinning, the connection test, waiting for
   approval, replacing the key, disconnecting; the web Settings card; security log rows. Nothing is sent yet.
3. **Sending, as a copy**: the outbox and `storage.vault` job, ids and status checks, caps and retries, notifications,
   the copy backfill; status in Settings and badges on files.
4. **Keeping in step**: the changes feed, the vault's metadata on files, out of reach, starting over.
5. **The vault as the record**: `FileBytes` and moving the readers onto it, removing sources (§5), the move backfill,
   bringing files back, the restricted-kind switches; view links and deletes once the vault's third step has shipped.
6. **Phone**: status, badges and opening vault-held documents.

## Consequences

- Montra can hand a household's papers to the place the household already keeps them, without being the only copy.
- For the record role, Montra reads files from somewhere it doesn't run. Every reader of file bytes moves to
  `FileBytes`, and each one must cope with "not available now". This is the largest part of the work and the reason
  ADR-0031 rejected moving files in the first place; the default backup ("Keep Montra's copy too") avoids it entirely.
- The vault's owner, not Montra, decides what Montra may send, read and download, and can change it at any time. A
  vault-only file can become unreadable from Montra without warning. Montra's books never depend on reading it again,
  because files are sent only after Montra is done with them.
- The vault's daily limits slow backfills and on-demand fetches to days for a large workspace. The status says so.
- Files held only in the vault don't count against Montra's storage quota (BAK-08). Retention dates (RCP-10, BAK-09)
  stop applying to the vault's copy: Montra deletes only its own.
- The private key adds one more sealed secret per workspace; losing the KMS key means connecting again, not losing
  documents.
- Two destinations per workspace (a mirror and a vault) means the storage settings and the phone's status line show two
  connections.
- BAK-05 is unchanged: the vault is not where scheduled backups go. A backup archive could be sent to the vault later
  if the vault takes that kind of file.

## Alternatives considered

- **Treat the vault as one more mirror only** (never the record): simplest, and it is the "copy" role. Rejected as the
  only option because the owner wants the vault to be where documents live.
- **Make the vault the record with no backup choice**: Montra would depend on the vault's settings and limits for every
  file read. Kept as an option behind a warning instead (open question 9).
- **Montra reaches the vault on the home network** (private address or a tailnet): refused by the address guard, and
  outside the agreed "public HTTPS only".
- **A long-lived token instead of signed requests**: not what the vault offers, and a token in Montra's database is
  worth more to a thief than a key that only signs within a short window.
- **One key pair for all of Montra**: a single leak would reach every household's vault. One per workspace, as agreed.
- **Send files as soon as they're uploaded**: Montra would often need them back for reading and Review, which in the
  record role would cost the vault's daily read cap. Sending after processing avoids it.
- **Reuse `storage_mirror_item` for the vault**: its states (copied or not) don't fit Inbox, filed, not kept and out of
  reach, and mixing them would complicate the mirror's job. A separate outbox keeps both simple.

## Open questions for the owner

1. **Where the vault's client code lives.** The vault's client library and fake vault are in the vault's private
   repository. Montra's code can't use the private contract's details in public until this is decided. Options:
   - **(a) Montra writes a minimal signer and client of its own**, in this public repo. Simplest to build and test, but
     the code (and the signing vectors) inevitably shows the vault's API shape in public.
   - **(b) Montra depends on a published package** of the vault's client (and its fake), under a licence Montra can
     use. The API shape is then public through that package instead; Montra's repo holds only the provider.
   - **(c) The vault provider lives in a private package or fork**, loaded by Montra through the `StorageDestination`
     port. The public repo keeps only the port, the generic outbox and the UI, and CI needs access to the private
     package (or skips its tests on forks).
   Recommendation: (b) if the vault's API is meant to be usable by others anyway; otherwise (c).
2. **Backups and tax packages for files only in the vault.** When a file has been filed in the vault and removed from
   Montra's storage (backup "own storage" or "none"), should Montra's backups (BAK-04/05), restore and tax packages
   (RPT-04, TAX-07):
   - fetch it on demand (slow: the vault's daily read cap, and only if a read grant covers it; the archive or package
     waits or goes out with a list of what's missing);
   - include a reference only ("in the vault as …"), with no bytes; or
   - require a backup copy (Montra's or the owner's storage) for kinds that go into tax packages?
3. **Payslips and tax forms.** May they go to the vault at all? If yes: to the acting member's Inbox (which may not be
   the person they belong to), with the vault's visibility deciding who sees them, or only when the vault connection
   acts as a workspace owner, or should Montra wait for a way to send to each person's own Inbox?
4. **Who may connect.** Owner only (proposed), or owners and admins as for S3/WebDAV today? And may an admin turn on
   restricted kinds?
5. **How much Montra says about a document.** Proposed default: kind, title, date and person; amounts and account
   last-four digits only with "Describe documents in more detail". Is that right, and should it be per kind?
6. **Montra and the vault on the same machine.** A self-hosted Montra (ADR-0050 §11) on the vault's own server could
   reach it over loopback, which the vault allows. Allow that as an exception to "public HTTPS only", or keep the rule?
7. **Fixed outbound addresses.** The vault can limit an app to known source addresses. Should Montra publish a fixed
   outbound address (needs a static IP or an egress proxy on the home server or VPS), or leave the allow-list unused?
8. **Kinds and types the vault can't keep.** CSV/XLS/OFX statement exports, and any Montra kind the vault doesn't list,
   stay only in Montra. Is that acceptable, or should Montra send a PDF rendering of them instead?
9. **"Keep it only in the vault".** Offer it in the first version, or only "Keep Montra's copy too" and "Keep a copy in
   my own storage" until the record role has been lived with?
10. **Deletes.** Keep the vault's document by default when Montra deletes a file for good (proposed, as for a mirror),
    including at a receipt's retention date?
11. **Plans.** Is the vault connection part of every plan (ADR-0049), or a paid feature?
12. **Order.** Build it now (the vault's sending and reading have shipped), or wait for the vault's third step (view
    links and deletes) so the record role ships whole? The chain above builds the copy role first either way.
