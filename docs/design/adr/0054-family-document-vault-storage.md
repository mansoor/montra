# ADR-0054: The household's Family Document Vault as a storage provider

- Status: accepted (the owner, 2026-11-17; see "Owner's answers" and "Defaults taken" at the end)
- Date: 2026-11-17
- Builds on: ADR-0031 (your own storage: the destination port, the outbox, retries, sealed secrets), ADR-0050 (hosting
  anywhere), ADR-0019 (backups, archives, retention, purge), ADR-0016 and ADR-0041 (restricted payslips), ADR-0034 §3
  (sealed copies of identity documents), ADR-0052 (tax forms, a restricted kind)
- Amends: ADR-0031 §1 ("mirror, don't move") for this one kind of destination, and ADR-0031 §3 (one connection per
  workspace)
- Requirements: BAK-03, BAK-05, BAK-08, BAK-09, RCP-10, NFR-03; adds VLT-01..11 (§14)

## Context

The owner also runs the **Family Document Vault** (the vault): a separate app where a household keeps its papers. The
vault has added a way for other apps to connect to it, and the owner wants Montra to use it as the place a workspace's
documents live: statements, receipts, invoices, leases and, perhaps, payslips and tax forms.

The vault's side is specified in **the vault's private connected-apps contract (not in this repo)**. This ADR describes
only what Montra does, in Montra's terms and at the level of behaviour. It deliberately names no routes, fields, codes
or limits from that contract: Montra's repository is public, and the contract is not. Montra's code talks to the vault
only through the vault's own client library, published as a package (owner's answer 1).

What is known about the vault's side, at that level:

- **Connecting.** A vault owner registers an app in the vault, chooses the vault member the app acts as, and pastes the
  app's public key. Each app has its own **Ed25519** key pair. The vault then gives a short connection code to paste
  back into the app.
- **Every request is signed** with HTTP Message Signatures (RFC 9421), inside a short time window, with a fresh value per
  request. There are no bearer tokens or sessions. Requests go over **HTTPS only**; plain http is accepted only from the
  same machine (loopback), which is for development.
- **Sending** (shipped): a document goes in with an id the app chooses, which makes a resend harmless. It lands in a
  vault **Inbox** (the vault decides whose), held for a person to review. The app can ask what became of it: still waiting,
  **filed** as a vault document, or not kept (the family removed it, it lapsed undecided, or the vault refused it).
  Only once it is filed is the vault's copy the household's record.
- **Reading** (shipped): the vault owner grants reads by kind or category, with a lookback. The app reads a **cursor
  changes feed** of what changed, and downloads files **within a daily byte cap**. The vault decides what an app may
  read, and can stop an app seeing a document at any time without saying why.
- **Opening and deleting** (shipped): **single-use view links** that a person's browser opens, and per-app handling of
  an app's deletes, chosen by the vault owner.
- **Filing automatically** (next on the vault's side): a vault owner may let items from an app be filed without a
  person, so they reach "filed" sooner. Montra needs no change for it.
- The vault has a client library and a fake vault for tests. Today they are in its private repository; the vault's side
  will publish them as a release tarball (MIT licence) for Montra to depend on, starting with vault 0.9.0-dev.60.

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
- **None ("vault only")**: Montra's copy is removed once the vault has filed it. Offered behind a warning that the
  vault's settings then decide what Montra can still open; a file the vault won't return is asked for again (§5a).

So a workspace may have a vault connection **and** an S3/WebDAV connection. The one-per-workspace unique index becomes
one per class: at most one mirror (`s3` or `webdav`) and at most one vault. ADR-0031 §3 already allowed for dropping it.

What goes to the vault is chosen by document group (§6), not by Montra's internal file kinds. Copy and record are per
connection, not per group, to keep the choice understandable; a later change can make them per group if asked for.

**One direction only** (owner's answer 2). Documents enter Montra first: finance papers such as statements, payslips,
W-2s and 1099s are uploaded or scanned into Montra, read there, and then sent to the vault. Montra never imports a
document that started in the vault, and asks the vault's owner for no reads over the family's other papers. What Montra
reads back from the vault is only what Montra itself sent there.

### 2. Connecting: Montra makes the key, the vault owner registers it

Only a workspace **owner** connects, changes the role or the groups, starts a move, or disconnects, with a recent
sign-in (AUTH-09), as for taking a backup. Admins can see the status and press "Try again" (default taken, D4).

1. **Montra makes the key pair** in the API process when the owner chooses "Family Document Vault" in Settings →
   Storage. It is a fresh pair for this workspace, never one used before. The private key is sealed at once (§7); the
   public key and its fingerprint are shown with a **Copy** button, with the steps to register Montra in the vault.
2. **The owner (or whoever owns the vault) registers Montra in the vault**, choosing there what Montra may do and how
   the vault handles what Montra sends, and gets a connection code back.
3. **The owner pastes the code into Montra.** Montra checks, in order:
   - that the code names the key Montra made for this workspace (a code for another key is refused);
   - that the vault's address passes the address guard (§8);
   - that the server there identifies itself as a Family Document Vault that accepts apps, and which vault it is.
     Montra **pins** that identity, and stops the connection (and tells the owner) if a later answer shows a
     different vault at the same address;
   - a signed connection test. It tells Montra whether it is approved, the household's name, which kinds it may send,
     whether it may read back and download what it sent, and the current limits.
4. If the vault says someone on its side must still approve Montra, the connection is saved as **waiting for
   approval**, and Montra checks again on its own (and when the owner presses "Check again").
5. The address, Montra's app and key identifiers in the vault, and the vault's identity are saved in the connection's
   `config`; the sealed private key in `secret_enc`.

**Key rotation** ("Replace the key", owner only): Montra makes a new pair, registers it with the vault under the old
key, and keeps signing with the old one until the vault reports the new one confirmed by a person on the vault side.
It then switches, and the old key is retired. Both private keys are sealed in `secret_enc` during the change. A
rotation is also the response to a suspected key leak, alongside the vault owner removing the app.

### 3. What goes, and when

- **The trigger** on `app.file` (ADR-0031 §5) also adds a row to the vault's outbox (§11) when the workspace has a vault
  connection whose switch for that file's group (§6) is on.
- **A file goes only when Montra is done with it.** It is sent after its own processing finishes (scan reading,
  statement import, receipt extraction, payslip or tax-form reading) and it has no open Review item, so Montra never
  needs the bytes back for its own first pass. A file still being processed waits in the outbox as `queued`.
- **Groups are mapped to the vault's kinds, not hard-coded.** The vault says at connect time which of *its* kinds
  Montra may send. The owner maps each group that is switched on (§6) to one of them in Settings (Montra suggests the
  obvious ones). A group left unmapped is not sent, and Settings says so. The map is re-checked against the vault's
  list at every run, because the vault's owner can change what Montra may send.
- **File types.** The vault keeps documents and images. Montra asks it at connect time which types it takes; files of
  other types (a CSV or OFX statement export, say) stay in Montra only, and are shown as "not a type the vault keeps"
  (default taken, D8).
- **What Montra says about a document.** The vault accepts descriptive hints with a file, which it treats as
  suggestions: it reads the file itself. By default Montra sends only what the paper is (its group's mapped kind), a
  title made from the file name and its entity, its date, and which household member it belongs to when Montra knows
  and the vault accepts that as a hint (by name, as the household knows them). Amounts and account last-four digits are
  **not** sent unless the owner turns on "Describe documents in more detail" (default taken, D5). Montra never sends
  transactions, ledger data, or anything a person didn't upload.
- **Where it lands is the vault's decision** (owner's answer 3). Montra doesn't choose an Inbox or a person to file
  to. It sends the document with the hints above and leaves routing, filing and who can see it to the vault's own
  rules.

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
owner's storage (a new read for S3/WebDAV, used only here), then **asks the vault for it** (a download of a document
Montra sent, counted against the vault's daily read cap). Whether the vault returns it is up to the vault's settings.
Each caller gets the bytes or a typed "not available" result with the reason; what happens next is §5a. Showing a
document to a person never goes through `FileBytes`; it uses a view link (§9).

### 5a. Files the vault doesn't return: ask the person (owner's answer 2)

The intent is that every file Montra sent stays readable to Montra. When it isn't, Montra asks a person for it rather
than failing quietly or keeping only a reference.

- **When Montra asks the vault.** Whenever it needs a file it no longer holds: a backup or archive (BAK-04/05), a tax
  package (RPT-04, TAX-07), a re-read, or a person opening it (through a view link, §9).
- **When a file counts as missing.** The vault doesn't return it (it never says why, and Montra doesn't guess), the
  feed has said it is out of reach (§9), or the vault's daily read cap is used up and the caller can't wait. A background job (a backup, a tax package) waits for the vault's next
  daily reset once; an interactive request doesn't wait.
- **What Montra does.** The file gets `missing_since` and a reason in words. Review gains **"Files to provide again"**,
  listing each missing file with what it was (its name, group, date and what in Montra uses it) and an **Upload** action
  (web and phone). Owners and admins, and the person who uploaded it, see the entry, as row-level security on the file
  allows. Its count joins the Review badge. One `files_missing` notification per day at most, with no file names.
- **Providing it again** stores the new upload under the same file id (its `location` goes back to `montra`), clears
  `missing_since`, and records the new hash. A hash different from the original is accepted and noted on the file (a
  fresh scan of the same paper won't match byte for byte); Montra doesn't re-read it unless the person asks. The file
  then goes through the outbox again as a new send, if its group is still on.
- **Backups and tax packages** include every file they could get, and list in their README (and on screen) any file
  still missing after asking the vault, with a link to "Files to provide again". They never stop for a missing file.
- A file that is missing never changes the books: the transactions, payslips and tax forms read from it stay as they
  are.

### 6. What goes: one switch per document group (owner's answer 3)

The vault connection has a per-workspace setting, **"Send these to the vault"**, with one switch per group. Groups are
what a person recognises; each covers some of Montra's file kinds (`app.file.kind`):

| Group                | Montra file kinds                                                                                 | Default |
| -------------------- | ------------------------------------------------------------------------------------------------- | ------- |
| **Receipts**         | `receipt`                                                                                         | on      |
| **Statements**       | `statement` (PDFs and images; CSV, XLS and OFX exports stay in Montra, §3)                        | on      |
| **Bills**            | `invoice`: household bills, a business's bills, and invoice attachments, which Montra stores as one kind | on |
| **Payslips**         | `payslip`                                                                                         | **off** |
| **Tax documents**    | `tax_form` (W-2, 1099, 1098; ADR-0052)                                                            | **off** |
| **Other documents**  | `lease` and `other`                                                                               | off     |

Never sent, whatever the switches say:

- **Sealed copies of identity documents** (ADR-0034 §3), including the documents kept with an I-9: they are ciphertext
  the vault couldn't read, and are never mirrored either.
- **`logo`** (a business's logo) and **`export`** (Montra's own archives): not papers a household files.

**Payslips and tax documents** are restricted in Montra: a member's are visible only to that member, owners and admins
(and, for tax forms, accountants when the owner allows it). In the vault, where they land and who sees them is the
vault's decision (§3). So:

- both switches are off by default, and only an owner can turn them on (an admin can turn them off);
- turning one on shows a warning: "Montra will send these to your vault. Where they go and who can see them there is
  set in the vault, not in Montra." The choice is recorded in the security log;
- a member's payslip or tax form is sent with that member as the hint for whom it belongs to, when the vault accepts
  such a hint, and the vault decides the rest.

Business documents go when their group is on; a later version may offer a per-entity choice.

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
  `STORAGE_DESTINATIONS_PRIVATE` says (that switch stays for S3/WebDAV). This follows the agreed point, and holds even
  when Montra and the vault share a machine (default taken, D6).
- Development and tests may use a loopback fake vault over http, behind a setting that production refuses to start
  with.
- Redirects are never followed, every request has a connect and a total timeout, and responses are size-limited.
- The vault can restrict an app to known source addresses. Montra's outbound address on a home server or a VPS is not
  fixed today, so Montra publishes none and Settings says to leave that restriction off (default taken, D7).

### 9. Keeping in step with the vault, and opening documents

- **Only Montra's own documents.** The feed and downloads are used only for documents Montra sent (§1, one direction).
  A paper the family filed in the vault themselves is never read or imported.
- **The vault wins on the document.** For a file in the vault, the changes feed is the source of what the vault calls
  it: its kind, title, dates and whether it still exists. Montra stores that on the outbox row (`vault_meta`) and shows
  it ("In the vault as: Bank statement, October 2026"). It never changes Montra's books: transactions, payslips, tax
  form boxes and matches stay as Montra has them. A newer file put in the vault by the family is shown as "the vault
  has a newer version"; Montra doesn't re-read it on its own.
- **The feed** is read by the job a few times an hour, and before a vault-held document is shown. Montra saves its
  position only after it has processed a page.
- **No longer available.** When the vault says Montra may no longer see a document, the row becomes `out_of_reach` and
  the file shows "No longer available in Family Document Vault", with no guess at why. If Montra still has a copy
  (record and copy, or copy to the vault), nothing else changes. If it doesn't, the file is missing and a person is
  asked to provide it again (§5a); it is never deleted from Montra's books. If the vault shows it again before then,
  the missing entry clears.
- **Starting over.** When the vault says Montra's feed position is no longer valid (for example after the vault was
  restored from a backup), Montra reads the whole feed again, and treats any document it holds that isn't in it as out
  of reach.
- **Opening a document** that only the vault holds (or, for any vault-held document, "Open in the vault") mints a
  single-use view link **when the person clicks**, and the API answers with a redirect to it at once. The link is never
  stored, logged, cached, emailed, put in a notification or prefetched, and the web app never renders it into a page. On
  the phone, the app asks the API and hands the link straight to the system browser. A link that can't be used (the
  vault can't draw that type, or too many links this hour) gets a message in words, and for a type the vault can't draw,
  a download link instead when the vault allows downloads. A document the vault won't open for Montra at all is
  missing (§5a).
- **Who may open** a vault-held document in Montra is who may open the file in Montra today (row-level security on
  `app.file` and the restricted rules). The vault then applies its own rules to the link as well.

### 10. Deleting

- **Trash** never touches the vault, as for a mirror.
- **Deleted for good** (after the trash, at a retention date (RCP-10, BAK-09), or with a purged workspace): Montra drops
  its copy and its reference. The vault document is left alone by default, at a receipt's retention date too: the
  household's record is theirs (default taken, D10). The connection has the same switch as a mirror, "Also delete it
  in the vault when Montra deletes a file for good", off by default. When it's on, Montra asks the vault to delete, and the vault does what its owner set for Montra's deletes
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
    public key and fingerprint, the household's name as last reported, the role (`copy` or `record`), the
    backup choice (`montra`, `own_storage`, `none`), the group switches and each group's vault kind, and the detail
    switch; `secret_enc` holds the sealed private key(s); `delete_with_montra` is reused; `file_kinds` is derived from
    the groups that are on, so the existing trigger logic keeps working;
  - `status` gains `needs_vault` (waiting for approval, paused or removed on the vault's side, or a key waiting to be
    confirmed), with `last_error` in words.
- **`app.vault_connection_state`** (one row per vault connection): the feed position and when it was last read, the
  last full re-read, the vault's next daily reset and "sending held until" and "downloads held until" times, the measured
  clock offset, and the key-rotation state. Not secret; RLS as for `storage_destination` (owners and admins).
- **`app.vault_item`** (one row per file and vault connection; the outbox): `vault_ref` (the id chosen once, unique per
  connection), `status` (`queued`, `pending`, `received`, `filed`, `not_kept`, `failed`, `out_of_reach`, `delete`),
  `not_kept_reason` (Montra's own words and whether a resend is allowed), `vault_document_id`, `vault_version`,
  `vault_sha256`, `vault_meta` (jsonb, as last read from the feed), `received_at`, `filed_at`, `source_key` (Montra's
  object still to remove, §5), `source_removed_at`, `attempts`, `next_attempt_at`, `last_error`. Indexes on due rows and on `vault_document_id`. RLS enabled and forced,
  owners and admins only, as `storage_mirror_item`.
- **`app.file`**: `location text not null default 'montra'` (`montra` or `vault`), and `storage_key` loses `not null`
  (a file held only in the vault has no Montra object); a check keeps `storage_key` set whenever `location = 'montra'`.
  `missing_since` (timestamptz) and `missing_reason` (Montra's words) mark a file the vault didn't return (§5a), with a
  partial index for the Review list; `replaced_sha256` notes a re-provided file whose hash differs.
- **The triggers** from migration 0029 are extended: a stored file also queues a vault row; a file deleted for good marks
  a filed row `delete` only when `delete_with_montra` is on, removes a `received` row's Inbox item (§10), and removes
  other rows.
- **Definer functions** `app.vault_due()` and `app.vault_next()` mirror `app.storage_mirror_due()` and
  `app.storage_mirror_next()`.
- **Security log kinds**: `vault_connected`, `vault_changed` (role, backup, groups, detail, and payslips or tax
  documents turned on or off), `vault_key_replaced`, `vault_move_started`, `vault_disconnected`. **Audit log**: one row
  per file moved (`file.moved_to_vault`), per file brought back, per file marked missing and per file provided again,
  and per view link minted (file id and who; never the link).
- **Notification types**: `vault_attention` (the vault needs something from a person: approval, a paused or removed
  app, a key to confirm; daily dedupe, no file names), `files_missing` (§5a; daily dedupe, no file names), and the
  existing `storage_failing` for repeated failures.
- **Plans** (ADR-0049): a feature key `familyVault`, on for the existing plans as `ownStorage` is (default taken,
  D11). A plan without it refuses connecting.

DTOs (`packages/schemas/src/storage.ts`): `StorageDestinationKind` gains `fdv`; a `VaultConnectionDto` (the address,
the vault's household name, the fingerprint, role, backup, group switches and their vault kinds, counts by status, held
until, clock offset); requests for start, paste-the-code, change, replace the key, move, bring back, and provide a
missing file again; `FileDto` gains `location`, `missing` and a `vault` summary; the Review list gains missing files.
Mobile types and the web fixtures change with them (CLAUDE.md).

### 12. Jobs

One system job, `storage.vault`, separate from `storage.mirror` because its pacing, states and failure handling differ.
It reuses the mirror's shape: due connections through a definer function, each under an owner's RLS context, rows
claimed with `for update skip locked` and a lease, a run budget, then a reschedule for whatever is due next. Per
connection, a run does, in order:

1. **Check the connection** with the signed connection test at the start of a run when it last failed or is
   waiting, and at least daily otherwise; refresh the allowed kinds, whether Montra may read back what it sent, and the limits.
2. **Send** due rows one at a time (§4).
3. **Ask about received rows** in batches, and mark them filed or not kept.
4. **Remove sources** that meet §5.
5. **Read the feed** (§9), or start over when told to.
6. **Deletes** (§10) and withdrawals.
7. **Fetches** that a backup or tax package is waiting on (§5a), within the day's read allowance; a file the vault
   doesn't return is marked missing.
8. **Move/copy backfill** progresses through the same send step; it only adds rows.

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
`queued` rows for every file of the groups that are on, not in the trash. Settings shows how long it will take at the vault's
current daily limit, and suggests asking the vault's owner for a temporary higher allowance. A **move** is the same
backfill on a "record" connection: §5 then removes each source as its document is filed. The job resumes from the
first row not yet received after a crash; asking about the id before resending makes a second send harmless anyway.

### 13. What people see

**Web, Settings → Storage** gains a "Family Document Vault" card beside "Your own storage":

- connecting in three steps (§2): the public key and fingerprint with Copy, what to do in the vault, then paste the
  code; "Waiting for <name> to approve Montra in the vault" until it is approved;
- the role and backup choice, in words: "Keep Montra's copy too" (default), "Keep a copy in my own storage", "Keep it
  only in the vault" (with its warning);
- "Send these to the vault": the group switches (§6), each with the vault kind it maps to; payslips and tax documents
  off, owner-only to turn on, with the warning in §6;
- status: sending, in someone's Inbox, filed, not taken, failed, out of reach; the last error in words; any hold for the
  daily limit; the clock warning; "Check again", "Try again", "Send again", "Replace the key", "Bring files back",
  "Disconnect";
- the move/copy backfill with its estimate and progress.

**Files and documents** (receipts, statements, payslips, invoices, leases, tax forms): a small "In the vault" badge, the
vault's name for the document, "Open in the vault", and "No longer available in Family Document Vault", "Not taken
by the vault" or "Missing: please upload it again" when that is so.

**Review → Files to provide again** (web and phone) lists missing files with an Upload action each (§5a). The phone
uploads through the same native file upload as receipts and payslips, or a scan.

**Phone:** Your data → Storage shows the vault's status line next to the mirror's (read only; connecting is on the web,
as the key step needs copying between apps). Files show the same badges, and "Open in the vault" goes through the API
to the system browser (§9). Nothing about the vault is kept in the phone's offline store beyond the file's `location`,
status and missing flag.

### 14. Requirements

A new subsection, **13.6 Family Document Vault**, in `docs/requirements/R1-requirements.md`, added by the first PR:

| ID     | Requirement                                                                                                                                       | Priority |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| VLT-01 | An owner connects the workspace to the household's Family Document Vault with a key pair Montra makes for that workspace, checks the vault's code and identity, and sees whether it's approved. | S |
| VLT-02 | The owner chooses, with one switch per group (receipts, statements, bills, payslips, tax documents, other), what goes to the vault and how each group maps to the vault's kinds, and whether the vault is a copy or the record, with a backup copy at Montra, at their own storage, or none. The vault decides where each document lands. | S |
| VLT-03 | Documents are sent one at a time after Montra has finished with them, are never filed twice, and show their vault status per file and in total. | S |
| VLT-04 | Existing documents can be copied or moved; a move removes Montra's copy only after the vault has filed the document and the chosen backup exists. | S |
| VLT-05 | Documents go one way, Montra to the vault; the vault's changes to documents Montra sent are read and shown, and win on the document but never change the books; a document the vault no longer shows is marked so, without a reason. | S |
| VLT-06 | A vault-held document opens through a single-use link made when the person clicks, never stored, logged or sent.                                   | S |
| VLT-07 | Payslips and tax documents go to the vault only if an owner turns them on after a warning; sealed copies of identity documents, logos and exports never go. | M |
| VLT-08 | The private key is sealed, never shown, logged or reused across workspaces, and can be replaced; connecting, changes, moves and disconnecting are in the security log; files moved and links made are audited. | M |
| VLT-09 | The vault's daily limits and waits are respected without counting as failures; problems are shown in words, and owners are told once when the vault needs a person. | S |
| VLT-10 | The phone shows the vault status and badges, opens vault-held documents, and uploads missing files again.                                          | C |
| VLT-11 | When Montra needs a file it no longer holds, it asks the vault; a file the vault doesn't return is listed in Review to be provided again, and backups and tax packages list any file still missing. | M |

### 15. Testing

- **Signing** belongs to the vault's client package, which is tested against fixed vectors in its own repository.
  Montra writes no signer of its own and keeps no copy of those vectors. Montra pins the package's version, and one
  Montra test checks that a request made through the package is accepted by the package's fake vault, so an upgrade
  that breaks signing fails Montra's CI.
- **The package's fake vault** runs as a local server in the API's integration tests (real Postgres, as the other
  suites). Montra's tests use it to file or decline documents, serve the changes feed and downloads, mint links, and
  make it fail in each way §12 and §5a handle (a wait to retry, the daily caps, connection problems, a document no
  longer readable, a hash that doesn't match). Failures at the network level (a dropped connection, a timeout, a lost
  answer) are made by Montra's tests at the socket, not by imitating the vault's answers. A failure mode the fake
  lacks is asked of the vault's side; Montra doesn't write vault-shaped answers into its public repo.
- **Montra's own guarantees**, each with a test: an id is saved before the first send and never changes; a lost answer
  leads to a status check, not a second document; no source is removed while its item is only in the Inbox, or before
  the backup exists; payslips and tax documents don't go unless an owner turned them on; sealed files, logos and
  exports never go; Montra never reads a document it didn't send; a file the vault doesn't return is marked missing and
  listed, and a backup or tax package lists it rather than stopping; providing it again restores it; a key is never
  in a log line, DTO, archive or error; a view link is never written to the database or logs; a connection problem
  stops the whole connection; a cap hold doesn't count toward `failing`; a pinned vault identity that changes stops
  the connection; the address guard refuses private addresses and http in production.
- **RLS and catalog tests** for the new tables (owners and admins only; excluded from archives with a reason).
- **Web** unit tests and one Playwright spec against the fake vault (connect, send, file, open). **Phone** pure-module
  tests for the status line and badges.
- **One live run** against the vault's development build behind HTTPS, by hand, before the record role is enabled
  (the vault refuses plain http from another machine).

## Delivery

A chain of small PRs into `develop`, each with its dev bump. The vault's sending, reading, view links and deletes have
all shipped, so the record role can ship whole.

**Precondition: the vault's first client release tarball (0.9.0-dev.60)** (owner's answer 1). Montra depends on the
client package, with its fake vault, as a tarball attached to the vault's public releases and installed by its pinned
URL (no registry, no token), and never on the vault's private repository. Until that release exists:

- PR 1 can be built and merged: it needs no vault code, only the port, the tables and the DTOs, tested without a vault.
- PR 2 onwards wait for the package. Their Montra-side code sits behind the `StorageDestination` port (extended for the
  vault's extra steps), and is tested with the package's fake once it is available.

1. **Contracts**: the migration, Kysely types, DTOs, the extended port, the `familyVault` plan key, requirements
   VLT-01..11 in the requirements and `status.json`; the group mapping (§6) as a tested pure function.
2. **Connecting** (needs the package): the dependency, key making and sealing, the code check and identity pinning, the
   connection test, waiting for approval, replacing the key, disconnecting; the web Settings card; security log rows.
   Nothing is sent yet.
3. **Sending, as a copy**: the outbox and `storage.vault` job, ids and status checks, caps and retries, notifications,
   the group switches with the payslip and tax-document warning, the copy backfill; status in Settings and badges on
   files.
4. **Keeping in step**: the changes feed, the vault's metadata on files, out of reach, starting over; view links.
5. **The vault as the record**: `FileBytes` and moving the readers onto it, removing sources (§5), missing files and
   "Files to provide again" (§5a), the move backfill, bringing files back, deletes.
6. **Phone**: status, badges, opening vault-held documents, and providing missing files again.

### As built: PR 1 (2026-11-17)

The contracts, with no vault code and no vault dependency: migration `0063_family_vault.sql`, the Kysely types, the
DTOs and group mapping in `packages/schemas/src/storage.ts`, the port in `apps/api/src/storage/destinations/vault.ts`,
the `familyVault` plan key, and VLT-01..11 (requirements 13.6, traced to a new P14). Nothing can make a vault
connection yet. Where PR 1 differs from or adds to the text above, and why:

- **`app.file.storage_key` stays NOT NULL until PR 5.** `scripts/check-migrations.mjs` would accept dropping it, but
  the Kysely type would then be `string | null` at about 70 reads in 20 files, which is exactly the move to `FileBytes`
  that PR 5 makes. No file can be held only in the vault before PR 5 anyway. The check that keeps `storage_key` set
  while `location = 'montra'` (`file_storage_key_held`) is added now, so PR 5 only drops the NOT NULL.
- **There is no `FileDto`.** Montra's records name their files by id, so §11's "`FileDto` gains `location`, `missing`
  and a `vault` summary" is `FileStorageStateDto`, keyed by file id, to serve beside the records that hold files.
  Review's missing files are their own list (`MissingFileDto`, `MissingFilesResponse`) rather than fields on today's
  Review DTO. No existing DTO changed shape, so the web fixtures and phone types are unchanged; PR 3 and PR 5 attach
  these where the badges and Review need them.
- **The mirror stays a mirror.** `StorageDestinationKind` gains `fdv`, but `StorageDestinationDto.kind` is the new
  `MirrorDestinationKind` (`s3`, `webdav`). The storage settings, the mirror's job, backups to storage and the
  mirror's definer functions and trigger now look at mirror connections only, so a vault row beside a mirror changes
  nothing they do (tested in `own-storage.test.ts`). `openDestination` takes mirror kinds only; the vault needs no
  adapter yet, so none exists.
- **The vault's tables can only hang off a vault connection.** Each has `destination_kind` (always `fdv`) in a
  foreign key to a new unique index on `storage_destination (workspace_id, id, kind)`. `needs_vault` is allowed only on
  `fdv` rows.
- **A vault row has `folder` and `keep_backups`.** They stay NOT NULL; PR 2 stores the default folder name, unused.
  `mirror_files` is the connection's "send files" switch; `file_kinds` is derived from the groups by `vaultFileKinds`.
- **The outbox, beyond §11's list:** `vault_ref` is null until it is saved before the first send, unique per
  connection, and a trigger refuses changing it once saved (§4.1). `resend_allowed` and `auto_resends` (at most one
  automatic resend after a lapse, §4.5) carry "whether a resend is allowed"; `not_kept_reason` is the words. A `delete`
  row without `filed_at` is a withdrawal from the Inbox (§10), so no extra status. Checks: an id past sending, a
  document for `filed` and `out_of_reach`, words for `not_kept`, a source key before `source_removed_at`.
- **The connection's state** adds `checked_at` and `next_check_at` (when the job should look for its own sake: the
  daily check, the feed); the key change is `none`, `made` (sealed, not yet registered) or `registered` (waiting for
  the vault side to confirm), with its time.
- **The trigger queues, it doesn't schedule.** A new file is `queued` (§3: it waits until Montra is done with it), and
  `storage.vault` doesn't exist until PR 3, so nothing wakes a job. `app.vault_due()` returns a connection with a due
  row, or whose `next_check_at` has come; while `needs_vault`, only the latter, and nothing while paused.
  `app.vault_next()` is the earliest of both.
- **Deleted for good:** an Inbox item (`received`) is always marked to withdraw; a filed document is marked `delete`
  only with "Also delete it in the vault" on and the vault allowing deletes (`can_delete`); any other row goes.
- **Notification types** `vault_attention` and `files_missing` are in the database's check only. `NOTIFICATION_TYPES`
  gains them with the PRs that send them (2 and 5): adding them now would add rows to notification settings for things
  that can't happen yet. The five security log kinds are in `SecurityEventKind`, with their words, because they show
  only once written.
- **The plan key.** The migration adds `familyVault` to every plan version that has `ownStorage`, lifting the freeze on
  versions with subscribers for that one update (adding a feature takes nothing away, ADR-0049 §1). The staff console
  lists it and the API checks it (PR 2), but customers don't see it yet: `FEATURES_NOT_YET_SHOWN` in
  `@montra/domain` keeps it out of the billing page's "what's included" (`includedFeatureKeys`, tested), until a vault
  can be connected. PR 2 or 3 removes `familyVault` from that set; its words are already in the messages.
- **The group mapping lives in `@montra/schemas`**, beside `STORAGE_FILE_KINDS`: `vaultGroupOf` (a group, or `never`
  for sealed copies, logos and exports), `vaultGroupSwitches`, `vaultFileKinds`, `vaultSends`, the defaults and the two
  restricted groups. Leaving out statement exports by type (§3, D8) needs the vault's list of types, so it comes with
  sending (PR 3).
- **The request DTOs** add what the screens need: the code is pasted against the connection's `version`; "Send
  existing documents" carries the count the person was shown, so a different number is refused; disconnecting takes
  `anyway` for §10's "Disconnect anyway". `VaultConnectionDto.stage` is `register`, `approval` or `connected` (§2).

## Consequences

- Montra can hand a household's papers to the place the household already keeps them, without being the only copy.
- For the record role, Montra reads files from somewhere it doesn't run. Every reader of file bytes moves to
  `FileBytes`, and each one must cope with "not available now". This is the largest part of the work and the reason
  ADR-0031 rejected moving files in the first place; the default backup ("Keep Montra's copy too") avoids it entirely.
- The vault's owner, not Montra, decides what Montra may send, read back and download, where each document lands and
  who sees it there, and can change it at any time. A vault-only file can become unreadable from Montra without
  warning; Montra then asks a person for it (§5a). Montra's books never depend on reading it again, because files are
  sent only after Montra is done with them.
- Documents flow one way. Papers the family files straight into the vault never reach Montra; to use one in Montra, a
  person uploads it to Montra.
- The vault's daily limits slow backfills and on-demand fetches to days for a large workspace. The status says so, and
  a backup or tax package lists what it couldn't get in time.
- Montra depends on a package released by the vault's side, as a tarball pinned by URL. Upgrades are pinned and tested
  like any dependency, and the chain past PR 1 waits for its first client release tarball (0.9.0-dev.60).
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
  file read. Kept as an option behind a warning instead, with missing files asked for again (§5a).
- **Montra writes its own signer and client** in this public repo: it would put the vault's API shape in public code
  that Montra then has to keep in step by hand. The owner chose the vault's published package instead.
- **Keep only a reference** ("in the vault as …") in backups and tax packages for files Montra no longer holds:
  rejected by the owner. Montra asks the vault, and then the person.
- **Read the family's other vault papers too** (statements or W-2s filed straight into the vault): rejected by the
  owner. Finance papers enter through Montra and go one way.
- **Montra chooses the Inbox or the person** a document goes to: rejected by the owner. The vault decides; Montra only
  says what the document is and, where the vault accepts it, whom it belongs to.
- **Montra reaches the vault on the home network** (private address or a tailnet): refused by the address guard, and
  outside the agreed "public HTTPS only".
- **A long-lived token instead of signed requests**: not what the vault offers, and a token in Montra's database is
  worth more to a thief than a key that only signs within a short window.
- **One key pair for all of Montra**: a single leak would reach every household's vault. One per workspace, as agreed.
- **Send files as soon as they're uploaded**: Montra would often need them back for reading and Review, which in the
  record role would cost the vault's daily read cap. Sending after processing avoids it.
- **Reuse `storage_mirror_item` for the vault**: its states (copied or not) don't fit Inbox, filed, not kept and out of
  reach, and mixing them would complicate the mirror's job. A separate outbox keeps both simple.

## Owner's answers (2026-11-17)

The three questions that blocked the build, as the owner answered them:

1. **Where the vault's client code lives: "published package".** Montra depends on the vault's MIT-licensed client
   library, with its fake vault, as a published package. Montra writes no signer or vault client of its own in this
   public repo. The vault's side publishes the package; until then only PR 1 can be built (Delivery). The owner later
   chose how it is published (2026-11-17): a release tarball on the vault's public releases from 0.9.0-dev.60,
   installed by pinned URL, rather than an npm registry.
2. **Files only in the vault: ask the vault, then the person.** Every file Montra sends to the vault is meant to stay
   readable to Montra. Finance papers (statements, payslips, W-2s, 1099s and the like) are always uploaded to Montra
   first and then sent to the vault, never the other way. When Montra needs a file it no longer holds, it asks the vault
   for it; whether the vault returns it depends on the vault's settings. If the vault doesn't, Montra asks the user to
   provide the file again. Applied in §1 (one direction), §5, §5a, §9 and VLT-05, VLT-11. The "reference only" option is
   dropped.
3. **Payslips, tax forms and whose Inbox: a setting per group, and the vault decides.** "MonTra should have a
   configuration that says what files are uploaded like Receipts, Payslips, Statements, Bills, Tax documents and let
   vault decide whose inbox it goes to." Applied in §3 and §6: one switch per group, payslips and tax documents allowed
   when an owner turns them on (off by default, with a warning), and no Inbox or person chosen by Montra.

## Defaults taken (owner may revisit)

The other questions were not answered; the ADR's proposal stands for each:

- **D4. Who may connect:** owners only, with a recent sign-in; admins see the status and retry, and may turn payslips
  and tax documents off but not on.
- **D5. How much Montra says about a document:** the vault kind, a title, the date and whom it belongs to; amounts and
  account last-four digits only with "Describe documents in more detail", per connection rather than per group.
- **D6. Montra and the vault on one machine:** no loopback exception; public HTTPS always.
- **D7. Fixed outbound addresses:** none published; the vault's address restriction for Montra stays off.
- **D8. Types the vault can't keep** (CSV, XLS and OFX statement exports): they stay in Montra only, shown as "not a
  type the vault keeps"; no PDF rendering.
- **D9. "Keep it only in the vault":** offered in the first version, behind its warning, now that missing files are
  asked for again (§5a).
- **D10. Deletes:** the vault's document is kept by default when Montra deletes a file for good, at a retention date
  too; "Also delete it in the vault" is an opt-in switch.
- **D11. Plans:** a `familyVault` feature key, on for the existing plans, as `ownStorage` is.
- **D12. Order:** build now. The vault's view links and deletes have shipped, so the record role ships whole; the
  vault's automatic filing comes next on its side and needs no Montra change.
