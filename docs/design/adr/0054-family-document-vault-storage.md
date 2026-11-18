# ADR-0054: The household's Family Document Vault as a storage provider

- Status: accepted (the owner, 2026-11-17; see "Owner's answers", "Owner's clarification" and "Defaults taken" at the
  end)
- Date: 2026-11-17; amended 2026-11-18 for the vault's API keys ("API keys (vault 0.9.0-dev.63–65)")
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

### 1. A new destination kind, `fdv`: additional storage, and the household's record

The vault becomes a third destination kind beside `s3` and `webdav`. It is **additional** storage: Montra's own storage
(and the owner's S3/WebDAV mirror, ADR-0031) go on as they are. Unlike a mirror, a document **filed** in the vault is
the household's **record** of it, which ADR-0031 §1 ruled out for the others (owner's clarification, 2026-11-17).

What happens to each group of documents (§6) is chosen per group, as one of three **modes**:

| Mode                            | What Montra keeps                                                                     | In the vault                       |
| ------------------------------- | ------------------------------------------------------------------------------------- | ---------------------------------- |
| **Not sent**                    | Its copy, locally, as today.                                                          | Nothing                            |
| **Sent, keep a local copy**     | Its copy, locally, as today.                                                          | The filed document: the record     |
| **Sent, no local copy**         | Nothing of its own once the vault has filed it (§5); it asks the vault, then a person, when it needs the file again (§5a). | The filed document: the record |

**"Local"** means where Montra normally keeps the file: its own storage (`StoragePort`). The owner's S3/WebDAV mirror
keeps following its own per-kind setting (ADR-0031), whatever a group's mode. For a group sent with no local copy,
Settings says when the mirror is set to copy that kind, so the mirror will still hold a copy; Montra never changes the
mirror's setting on its own.

So a workspace may have a vault connection **and** an S3/WebDAV connection. The one-per-workspace unique index becomes
one per class: at most one mirror (`s3` or `webdav`) and at most one vault. ADR-0031 §3 already allowed for dropping it.

What goes to the vault is chosen by document group (§6), not by Montra's internal file kinds.

**One direction only** (owner's answer 2). Documents enter Montra first: finance papers such as statements, payslips,
W-2s and 1099s are uploaded or scanned into Montra, read there, and then sent to the vault. Montra never imports a
document that started in the vault, and asks the vault's owner for no reads over the family's other papers. What Montra
reads back from the vault is only what Montra itself sent there.

### 2. Connecting: Montra makes the key, the vault owner registers it

_Steps 1–3 and the key rotation below are superseded by "API keys (vault 0.9.0-dev.63–65)" (2026-11-18): the vault
makes the key, and an owner pastes it into Montra._

Only a workspace **owner** connects, chooses a sent mode for payslips or tax documents, starts a move, replaces the
key or disconnects, with a recent sign-in (AUTH-09), as for taking a backup. Admins can see the status and press "Try
again" (default taken, D4).

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

### 5. Sent with no local copy: removing Montra's copy

Only for a file whose group's mode is **sent, no local copy** (§1), and only when **all** of these hold:

1. the vault reports the item **filed** (never while it is only in the Inbox: an Inbox item can still be removed or
   lapse);
2. if the owner's S3/WebDAV mirror is set to copy that kind, the mirror reports the file `done` (it copies from
   Montra's copy, so that copy stays until then); a mirror that doesn't copy the kind is not waited for;
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

### 6. What goes: one mode per document group (owner's answer 3, owner's clarification)

The vault connection has a per-workspace setting, **"Send these to the vault"**, with one mode per group (§1): not
sent, sent and keep a local copy, or sent with no local copy. Groups are what a person recognises; each covers some of
Montra's file kinds (`app.file.kind`):

| Group                | Montra file kinds                                                                                 | Default mode |
| -------------------- | ------------------------------------------------------------------------------------------------- | ------------ |
| **Receipts**         | `receipt`                                                                                         | sent, keep a local copy |
| **Statements**       | `statement` (PDFs and images; CSV, XLS and OFX exports stay in Montra, §3)                        | sent, keep a local copy |
| **Bills**            | `invoice`: household bills, a business's bills, and invoice attachments, which Montra stores as one kind | sent, keep a local copy |
| **Payslips**         | `payslip`                                                                                         | **not sent** |
| **Tax documents**    | `tax_form` (W-2, 1099, 1098; ADR-0052)                                                            | **not sent** |
| **Other documents**  | `lease` and `other`                                                                               | not sent     |

Never sent, whatever the modes say:

- **Sealed copies of identity documents** (ADR-0034 §3), including the documents kept with an I-9: they are ciphertext
  the vault couldn't read, and are never mirrored either.
- **`logo`** (a business's logo) and **`export`** (Montra's own archives): not papers a household files.

**Payslips and tax documents** are restricted in Montra: a member's are visible only to that member, owners and admins
(and, for tax forms, accountants when the owner allows it). In the vault, where they land and who sees them is the
vault's decision (§3). So:

- both are not sent by default, and only an owner can choose a sent mode for them (an admin can set them back to not
  sent);
- turning one on shows a warning: "Montra will send these to your vault. Where they go and who can see them there is
  set in the vault, not in Montra." The choice is recorded in the security log;
- a member's payslip or tax form is sent with that member as the hint for whom it belongs to, when the vault accepts
  such a hint, and the vault decides the rest.

Business documents go when their group is on; a later version may offer a per-entity choice.

### 7. Keys and other secrets

_The private key here became the vault API key's secret from vault 0.9.0-dev.63: see "API keys (vault
0.9.0-dev.63–65)" (2026-11-18)._

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

_From vault 0.9.0-dev.63 a document Montra's send made stays readable to Montra after the family adds newer versions:
see "API keys (vault 0.9.0-dev.63–65)" (2026-11-18)._

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
  disconnects. "Disconnect anyway" keeps the references, shown as "In the vault, not connected". As built (PR 5b2): a
  soft disconnect that keeps the connection, `disconnected`, with no key, and lists those files in "Files to provide
  again" until the same vault is connected again.

### 11. Data model and migration sketch

One migration (number assigned when it is written), append-only and backward compatible:

- **`app.storage_destination`**:
  - `kind` check gains `fdv`;
  - the unique index `storage_destination_one` is replaced by two partial unique indexes: one for `kind in ('s3',
    'webdav')` and one for `kind = 'fdv'`;
  - for `fdv`, `config` holds the vault's address and pinned identity, Montra's app and key identifiers there, the
    public key and fingerprint, the household's name as last reported, each group's mode (§1) and vault
    kind, and the detail switch; `secret_enc` holds the sealed private key(s); `delete_with_montra` is reused;
    `file_kinds` is derived from the groups that are sent (either mode), so the existing trigger logic keeps working;
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
current daily limit, and suggests asking the vault's owner for a temporary higher allowance. For a group sent with no
local copy it is a **move**: §5 then removes each source as its document is filed. The job resumes from the
first row not yet received after a crash; asking about the id before resending makes a second send harmless anyway.

### 13. What people see

**Web, Settings → Storage** gains a "Family Document Vault" card beside "Your own storage":

- connecting in three steps (§2): the public key and fingerprint with Copy, what to do in the vault, then paste the
  code; "Waiting for <name> to approve Montra in the vault" until it is approved;
- "Send these to the vault": each group's mode (§6) in words, "Don't send", "Send, and keep a copy in Montra" or
  "Send, and don't keep a copy in Montra" (with §5a's warning, and a note when the owner's own storage still copies
  that kind), each sent group with the vault kind it maps to; payslips and tax documents not sent, owner-only to send,
  with the warning in §6;
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
| VLT-01 | An owner connects the workspace to the household's Family Document Vault with an API key the vault generates for Montra, checks the vault's connection string and identity, and sees whether it's approved, whom Montra acts as, and when the key expires. | S |
| VLT-02 | The owner chooses, for each group (receipts, statements, bills, payslips, tax documents, other), whether it is not sent (kept only locally), sent with a local copy kept, or sent with no local copy, and how each sent group maps to the vault's kinds. A document filed in the vault is the household's record; "local" is Montra's own storage, and the owner's own S3/WebDAV keeps its own setting. The vault decides where each document lands. | S |
| VLT-03 | Documents are sent one at a time after Montra has finished with them, are never filed twice, and show their vault status per file and in total. | S |
| VLT-04 | Existing documents can be sent; for a group sent with no local copy, Montra removes its copy only after the vault has filed the document. | S |
| VLT-05 | Documents go one way, Montra to the vault; the vault's changes to documents Montra sent are read and shown, and win on the document but never change the books; a document the vault no longer shows is marked so, without a reason. | S |
| VLT-06 | A vault-held document opens through a single-use link made when the person clicks, never stored, logged or sent.                                   | S |
| VLT-07 | Payslips and tax documents go to the vault only if an owner turns them on after a warning; sealed copies of identity documents, logos and exports never go. | M |
| VLT-08 | The vault key's secret is sealed, never shown, logged, archived or reused across workspaces, and an owner can replace the key; connecting, changes, moves and disconnecting are in the security log; files moved and links made are audited. | M |
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
- **One live run** against the vault's development build behind HTTPS, by hand, before "sent, no local copy" is enabled
  (the vault refuses plain http from another machine).

## Delivery

A chain of small PRs into `develop`, each with its dev bump. The vault's sending, reading, view links and deletes have
all shipped, so "sent, no local copy" can ship whole.

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
3. **Sending, with a local copy kept**: the outbox and `storage.vault` job, ids and status checks, caps and retries,
   notifications, each group's mode (not sent, or sent and keep a local copy) with the payslip and tax-document
   warning, the backfill; status in Settings and badges on files.
4. **Keeping in step**: the changes feed, the vault's metadata on files, out of reach, starting over; view links.
5. **Sent with no local copy**: the third mode, `FileBytes` and moving the readers onto it, removing sources (§5),
   missing files and "Files to provide again" (§5a), the move backfill, bringing files back, deletes. Built as two PRs:
   5a, `FileBytes`, the readers and the migration, removing nothing; 5b, the rest.
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

### As built: PR 2 (2026-11-17)

Connecting, over the vault's client package `@fdv/client` (MIT), installed in `apps/api` from the vault's public GitHub
release by pinned URL, `v0.9.0-dev.59/fdv-client-0.9.0-dev.59.tgz` (no registry, no token); pnpm records its integrity
in the lockfile. The precondition above named 0.9.0-dev.60; dev.59 is the first tarball and has everything connecting
needs (dev.60 adds downloading the exact file sent and routing to the Inbox of the person a document is about, which the
later PRs use). Where PR 2 differs from or adds to the text above, and why:

- **The package.** It is ESM only; the API is already ESM (`"type": "module"`, NodeNext), so it imports it directly,
  and the Docker image installs it from the lockfile like any dependency. Its fake vault (`@fdv/client/testing`) is
  loaded only with `FAMILY_VAULT_FAKE=on`. Its contract scenarios (`./testing/contract`) hold a vault's own API to the
  client and need vitest 5 or 6; Montra is on vitest 4 and has no vault API to hold to them, so they aren't used. A
  pnpm hook (`.pnpmfile.cjs`) drops that optional vitest peer: otherwise pnpm links it to the workspace's vitest and
  the API's production install carries vitest, vite and esbuild. Both Dockerfiles copy the hook.
- **Where the code is.** `apps/api/src/storage/vault/`: `keys.ts` (the pair and its sealed shape), `transport.ts` (the
  `fetch` the package is given), `connection.ts` (reading a code, identifying the vault, the signed connection test,
  failures as `VaultError`), `vault.service.ts`, `vault.controller.ts` (`/v1/workspaces/:id/family-vault`), and
  `fake.ts`. `VaultError` gains `invalid_code`, `other_key` and `not_a_vault`, and `VaultCheck` gains `actingAs`.
- **Checking a code**, in §2's order: the package reads it strictly; its fingerprint must be the one of the key Montra
  is waiting on; its address must pass the guard; the server's own description must say it is a Family Document Vault
  that takes apps and give its installation id, which is pinned (a vault too old to give one isn't connected to), and a
  code that names another installation is refused; then the signed connection test. A different installation id later,
  in the description or the connection test, stops the connection (`needs_vault`, with the words to show).
- **The address guard** refuses plain http and loopback even though the package itself accepts http to the same
  machine (D6), and also `.local` and single-label names. Montra's `fetch` uses the mirror's guarded lookup on every
  socket, follows no redirect, has a connect and a total timeout and refuses answers over 4 MB. The package turns any
  failed `fetch` into "offline", so the transport keeps why it refused a request, and the adapter says that instead.
- **Waiting for approval** is `stage: approval`, `status: needs_vault`; "Check again" (owners and admins, D4) moves it
  on. Checking on its own needs the job (PR 3): `next_check_at` is set (15 minutes while waiting, daily once connected)
  and nothing runs it yet; before a code is pasted it is `infinity`.
- **A paused or removed app, a key the vault doesn't know or hasn't confirmed, the clock**: the vault's refusals for
  these stop the connection with the vault's own words. A paused app's connection test answers but says it is paused,
  which Montra treats the same. A vault Montra can't reach counts as a failed check, and five in a row turn the
  connection `failing`.
- **Replacing the key differs from §2.** The vault's API lets an app add a key of its own, and lets an owner add one in
  the vault's Settings and get a new code. The package's fake (dev.59) has neither, and Montra writes no vault-shaped
  answers, so PR 2 builds the second, which the fake can stand in for: "Replace the key" makes a new pair, sealed beside
  the current one (`key_rotation = made`); Settings shows its public key and fingerprint; someone in the vault adds it
  to Montra's app there; the owner pastes the code the vault gives. That code must name the new key and the same app,
  at the pinned vault, and the connection test must pass signed with the new key. Then Montra switches, drops the old
  key from `secret_enc` and asks the vault to retire it (best effort: the vault retires an older key by itself a few
  days after a newer one is first used). Until then the current key signs, and "Keep the current key" cancels.
  `registered` is unused until the app-added route is in the fake; the vault's side is asked for it.
- **The key in use.** The package signs with a PKCS#8 key handed to it as bytes, not a `KeyObject` (§7). Montra unseals
  it for one request or run and zeroes those bytes when the connection closes.
- **Logging.** The API has no structured request log with redaction paths to extend. Nothing in the adapter logs, the
  transport records nothing, and `VaultError.detail` carries a status and a code at most. A test watches the process's
  output through a check and a bad paste.
- **Nothing is sent.** A vault connection's `mirror_files` stays off, so the trigger on `app.file` queues nothing. Each
  group is stored with its default mode (owner's clarification); choosing modes and mapping groups to the vault's kinds
  come with sending (PR 3), so the Settings card shows the connection only, and says that nothing is sent yet.
- **No migration.** The owner's clarification needs none: the role and the backup choice were only ever in `config`
  (jsonb) and the DTOs, never in a column, so they are simply gone. Each group's mode is in `config` too.
  `VaultGroupSettingDto` has `mode` instead of `on`; `VaultConnectionDto` loses `role` and `backup` and gains `newKey`
  and `actingAs`; `ReplaceVaultKeyRequest` gains `cancel`. No client used them yet.
- **The plan key stays hidden.** `familyVault` stays in `FEATURES_NOT_YET_SHOWN`, as a connection sends nothing yet;
  the billing page lists it from PR 3. The Settings card shows to owners and admins whose plan has `familyVault`; only
  an owner changes anything.
- **Tests and the e2e run** use the package's fake inside the API process, behind `FAMILY_VAULT_FAKE=on`, which
  production refuses to start with. With it on, a dev-only route (`POST /v1/dev/fake-vault/apps`) stands in for the
  vault's owner registering Montra, so Playwright connects end to end. Paused, removed and approved apps, and an added
  key, are set through the fake's own state, as its types offer. A dropped connection is a `fetch` that rejects;
  redirects, size limits and timeouts are made by a local http server, against the transport with a test-only loopback
  switch that no setting reaches.
- **Security log rows**: `vault_connected` (host, household, approved, fingerprint), `vault_changed` (a key made or a
  new key cancelled), `vault_key_replaced` and `vault_disconnected`. None carries a key or a code.
- **Disconnecting** deletes the connection with its sealed key, state and outbox. It doesn't ask the vault to remove
  Montra; Settings says to do that in the vault. `anyway` is taken and changes nothing until files can be held only in
  the vault (PR 5).

### As built: PR 3 (2026-11-17)

Sending, with a local copy kept, on `@fdv/client` **0.9.0-dev.60**, the release the precondition named
(`v0.9.0-dev.60/fdv-client-0.9.0-dev.60.tgz`; its size and sha256 were checked against the vault side's, and pnpm
records its integrity). Migration `0064_vault_sending.sql`. Where PR 3 differs from or adds to the text above, and why:

- **"Sent with no local copy" isn't offered yet.** Settings offers "Don't send" and "Send, and keep a copy in Montra",
  says that sending without a copy comes in a later version, and the API refuses `sent_no_copy`
  (`VAULT_GROUP_MODES_OFFERED`). Offering it now, with Montra keeping the copy anyway, would record a choice the build
  can't honour and leave files "eligible" for a removal whose safeguards (`FileBytes`, missing files, §5a) don't exist
  yet; PR 5 adds the mode with them. The safer of the two options the owner left open.
- **A group is sent only once it is mapped.** The defaults (receipts, statements and bills sent) have no vault kind
  until the owner saves one (Montra suggests the obvious one, `vaultSuggestKind`), so nothing goes until the owner has
  looked at the table. `file_kinds` is derived from the groups that are sent *and* mapped (`vaultEffectiveModes`), so
  the trigger queues nothing for the others, and Settings lists sent groups not yet mapped. `mirror_files` is on once
  the vault has approved Montra (`stage: connected`).
- **"Done with it"** (§3) is `app.vault_file_busy`: no receipt or payslip being read or in review, no statement import
  not yet committed, no scan or statement-or-bill intake waiting, no tax form being read or checked. A definer function,
  because a scan is its uploader's alone and the job runs as an owner. A new file also waits two minutes, so the record
  it belongs to exists first; the trigger wakes the job then.
- **A filed item may have no document id.** A vault that lets Montra send but not read answers "filed" without saying
  which document (the vault's `unavailable` state, as the fake also shows it), so `vault_item_check1` became a check on
  `filed_at` alone. Montra records the id when it is told it.
- **`content_available`** (dev.60) is stored on each row as the vault last said it; nothing uses it until PR 5.
- **The id** is `m1-` and 40 characters of a SHA-256 over the workspace, the file and the row's creation time: opaque,
  derived from ids, and new for a new row, so "Send again" after the family removed a document is a new send (the
  vault's answer about the old id won't change), while "Try again" keeps the id. A row whose last attempt got no answer
  is asked about before it is sent again; a row sent again on purpose (a lapse's one automatic resend, an id the vault
  says it doesn't know) is sent directly.
- **Claims use a CTE** (`with c as (… limit n for update skip locked) update … from c`), not the mirror's
  `in (… limit n)`, which Postgres may run again per row and so lease more rows than it sends; found by the
  one-at-a-time test. The mirror's job has the same shape and may want the same change.
- **What Montra says** (§3, D5): the mapped kind, a title from the file's name (with a business's or rental's name),
  the paper's date, the tax year, and the person: a payslip's member, a tax form's person, a household bill's member,
  by name as the household knows them. Amounts (a receipt's total, a payslip's net, a bill's amount) and an account's or
  card's last four go only with "Describe documents in more detail". Only hints the vault lists (`config.hints`); the
  job checks the connection first when it doesn't know them yet. The vault routes a paper to the Inbox of the person it
  is about when they can receive it (an adult with a sign-in, not locked or paused), else to the person Montra acts as;
  Montra isn't told which. A recipient paused at that moment is a retriable "busy" from the vault: waited out like any
  wait the vault asks for.
- **Types the vault doesn't keep** (D8): statement exports (CSV, spreadsheets, OFX, QFX, QIF) never go, whatever the
  vault takes; any other type the vault doesn't list, and files over its size limit, are `not_kept` with the words
  "Not a type the vault keeps. It stays in Montra." (or too large), and no resend. The backfill leaves them out of its
  count.
- **Waits, caps and failures** (§12): the daily cap holds sending (`send_held_until`, shown) and isn't a failure; a wait
  the vault asks for is waited at least that long, with up to 15 seconds' jitter and Montra's backoff, and a row never
  gives up over it; can't reach the vault at all holds every row on the backoff; a refusal of the document itself is an
  answer (`not_kept`), another client error fails the row at once; five failures in a row turn the connection
  `failing` (`storage_failing`, once). A connection problem stops it (`needs_vault`), releases the row without counting
  the attempt, and tells owners and admins once, as it stops (`vault_attention`, which joins `NOTIFICATION_TYPES` as a
  notification people don't switch off, like `storage_failing`). While stopped, only the check runs, every 15 minutes.
- **Not kept** (§4.5): removed by the family is `not_kept` with a resend allowed, and owners and admins hear about it
  once a day at most (`vault_attention`, no file names); a lapse is sent again once on its own, under the same id, then
  waits for "Send again"; a kind the vault no longer lets Montra send is `not_kept` with a resend allowed (a mapped
  kind gone from the vault's last list holds the row as `queued` with the words instead, until the mapping changes).
- **Withdrawals and deletes** (§10) run in this job, as the triggers from PR 1 already mark the rows: an Inbox item for
  a file deleted for good is withdrawn, and a filed one is deleted in the vault only with "Also delete it in the vault"
  on and allowed. The switch is in the API (`deleteWithMontra`) but not yet in Settings; PR 5 shows it with the rest of
  deleting.
- **Backfill** ("Send existing documents") queues every file of the sent and mapped groups not already in the outbox,
  not in the trash, oldest first, after the owner (recent sign-in) confirms the count shown with the days it takes at
  the vault's daily limit. It is recorded as `vault_move_started` with `keepCopy: true`.
- **Badges** are on the files of receipts, payslips and tax forms, for anyone who can see those files: the API asks only
  about files the caller sees under row-level security, and `app.vault_file_states` answers with the status and the
  words. Statements and bills don't list their files by id on screen yet, so they get badges later.
- **The fake reads a multipart body as UTF-8**, so the bytes of a binary file (a real PNG, JPEG or most PDFs) arrive
  changed and Montra's hash check fails them; Montra's tests send text-only files. Asked of the vault's side; the real
  vault isn't known to do this.
- **The e2e run** covers choosing what is sent, the warning and the count of existing documents. Sending itself is
  tested in the API's tests: Playwright's worker is another process, without the API's in-process fake.
- **The plan key is shown.** `FEATURES_NOT_YET_SHOWN` is empty, so the billing page lists "Documents sent to your Family
  Document Vault".

### As built: PR 4 (2026-11-17)

Keeping in step and view links, on `@fdv/client` **0.9.0-dev.61** (`v0.9.0-dev.61/fdv-client-0.9.0-dev.61.tgz`, 501,417
bytes, sha256 `535a6bff7f8520f1…`, checked against the vault side's numbers; pnpm records its integrity). Migration
`0065_vault_feed.sql`. Where PR 4 differs from or adds to the text above, and why:

- **The package.** dev.61 has no peer dependencies, so the pnpm hook (`.pnpmfile.cjs`) and its copies in both
  Dockerfiles are gone, and the API's production install still has no vitest, vite or esbuild. `NetworkError` now says
  why in a short `detail`; Montra keeps it only when it is a code such as `ECONNREFUSED`, and never logs the error's
  `cause`, which can hold an address. Its key routes are not used.
- **The auth change is coming.** From vault 0.9.0-dev.63 connected apps use API keys the vault's owner makes (a client
  id and a secret, sent as HTTP Basic) instead of Montra's Ed25519 key and signed requests. PR 4 doesn't touch keys or
  signing: the feed and links are two more methods of `VaultConnection` (`changes`, `link`), behind the port, so a
  separate PR changes only how the client is built.
- **The feed** is read by `storage.vault` every 20 minutes while the vault lets Montra read (`documents.read`; without
  it the feed is never asked for and `feed_next_at` is null), and caught up (at most five pages, five seconds) before a
  document is opened when it was last read over a minute ago. Each page is applied in one transaction with saving the
  position, and only if the position is still the one the page was read from, so the job and a person opening a
  document never apply a page twice or out of order. `vault_due()` and `vault_next()` count the feed's time while the
  connection is active or failing.
- **Only Montra's own documents.** A line is matched to a row by the vault's document id, or, for a filed item whose
  document Montra wasn't told, by Montra's own id (`external_id`, present only on Montra's own documents). Anything else
  the feed names (whatever the vault's owner lets Montra read) is skipped and never stored; tested with a grant over the
  family's papers.
- **What is kept** (`vault_meta`): the document id, the kind's name and key, the title, the paper's date, the version,
  `newerVersion` and when it was read; never amounts, issuers or account digits, though the feed has them. The badge
  says "In the vault as: …" (the title, else the kind). Nothing else is written: the books, the receipt and the file row
  are unchanged (tested). A received row the feed shows filed becomes `filed`.
- **A newer version.** The vault marks a document Montra's own only while its current version is the one Montra sent.
  With no read grant (Montra asks for none, §1), a document the family puts a newer version into stops being readable,
  so the feed says it is unavailable and Montra shows "No longer available", not "the vault has a newer version". The
  newer-version badge shows only where the vault's owner granted reads of that kind. Raised for the owner below.
- **Out of reach** is a row status only while Montra keeps its copy (the only mode until PR 5); a shown-again document
  is `filed` again. Missing files (§5a) come with PR 5.
- **Starting over.** A position is refused when the vault answers that it is too old, or that it isn't a position at
  all (what a restored vault says of one it never gave); the adapter then reads from the beginning and says so. The
  first read is a full read too. `full_read_started_at` marks one in progress across runs, and `vault_item.feed_seen_at`
  when the feed last showed each document; a full read that reaches the end marks out of reach any filed document of
  Montra's it didn't show, **if it was filed before the read began** (one filed since may not be in the read's snapshot,
  and the feed's own lines say what becomes of it).
- **Opening.** "Open in the vault" is offered on a filed document the feed has shown (`canOpen`). It is a plain link,
  never Next's `<Link>`, to a route of the web app (`/w/:id/vault/:file/open`), which refuses prefetches, prerenders
  and other sites' navigations (`Sec-Purpose`, `Purpose`, `Sec-Fetch-Site`, `Sec-Fetch-Dest`), then calls the API's
  `POST …/family-vault/files/:file/open` (outside the idempotency interceptor, which would store the answer) and sends
  the browser on to the API's 303 at once. A form posting straight to the API would be simpler, but the web app's
  `form-action` CSP applies to the redirect, and the vault's address is per workspace. Errors go to a page of words
  (`/w/:id/vault/:file?problem=…`), which holds no link.
- **Who opens.** The API checks the person can see the file under row-level security, then a definer function,
  `app.vault_file_open(file)`, gives the document, its status and the owner the connection acts as. The connection and
  its sealed key are for owners and admins, so the link is made under that owner's context, as the job does; the audit
  row (`file.vault_link_made`, with `view` or `download`) names the person who clicked, never the link.
- **The link** must be https on the vault's own origin, or it is refused. It is in no body, table, notification or
  log: tested by searching every table and the process's output for its token after a click. Each click makes a new
  one.
- **A link that can't be made:** a type the vault can't draw opens as a download when the vault lets Montra download,
  else "can't show this kind of file"; the vault's hourly limit is a 429 with `Retry-After` and words with the minutes,
  not a failure; a vault that doesn't let Montra open documents is said in words, and sending goes on (its refusal
  isn't treated as a connection problem here); a document the vault won't open is "No longer available", and the feed
  is read again now, since the feed, not that answer, is the record. A connection problem wakes the connection check.
  Opening works while sending is paused; the feed isn't caught up then.
- **"Also delete it in the vault"** is now in Settings (owner only, off by default, offered when the vault lets Montra
  delete), as the API has had it since PR 3. Settings also says when the vault's changes were last read.
- **The phone** (PR 6) needs the link handed to the system browser; the API answers only with a redirect for now.
- **The e2e run** checks the switch, the feed line and opening a file that isn't there. Opening a filed document is
  tested in the API's tests, against the fake: filing happens in the fake inside the API process.

### As built: PR 5a (2026-11-17)

PR 5 is split in two, as the brief allowed when moving every reader onto `FileBytes` made one PR too large to review:
**5a** (this) is `FileBytes`, every reader moved onto it, the migration and the vault's read-back, and removes nothing;
**5b** turns on "sent with no local copy": removing sources (§5), missing files and "Files to provide again" (§5a), the
move backfill, bringing files back and the disconnect choice (§10). On `@fdv/client` **0.9.0-dev.62**
(`v0.9.0-dev.62/fdv-client-0.9.0-dev.62.tgz`, 504,907 bytes, sha256 `aa97e8fbc64bbe16…`, checked against the vault
side's numbers; pnpm records its integrity), whose fake keeps a file's bytes exactly as sent. Migration
`0066_vault_file_bytes.sql`. Where PR 5a differs from or adds to the text above, and why:

- **`storage_key` loses its NOT NULL**, as PR 1 planned, in a plain `alter column … drop not null`, which
  `check-migrations` accepts without a `-- contract:` marker: it takes nothing away from code still running, and no row
  has a null key until 5b removes a source. `file_storage_key_held` (0063) still keeps a key on every file Montra holds.
  The Kysely type is `string | null`, so every reader had to be moved for the build to pass.
- **`FileBytes`** (`apps/api/src/storage/file-bytes.ts`) tries Montra's copy, the mirror's, then the vault's, and checks
  the file's hash on the mirror's and the vault's. It answers bytes with where they came from, or a typed reason with
  words: `in_vault`, `vault_refused`, `vault_read_cap` (with when), `vault_unavailable` or `not_held`. Montra's own copy
  failing to read falls through to the copies, so a lost object is read back too. Readers: receipts, payslips,
  household bills, business bills, invoices, rentals, tax forms, I-9 documents and reimbursements (previews); AI
  reading of receipts and payslips, statement imports, intakes and migrations (jobs); backups and tax packages; the
  mirror's and the vault's own sending. A test reads the API's source and fails if anything else reads a file by its
  key; only Montra's own archives (backups, restores) still are.
- **The copies are read under the owner's context.** The mirror's outbox and the vault's are for owners and admins,
  and a partner's backup needs their files too. As for opening (PR 4), the file is read under the caller's own
  row-level security first; then a definer, `app.file_copies(file)`, says where its copies are and which owner the
  connections act as (members of the workspace only), and the copy is read as that owner.
- **The mirror is read back** with a new `get(path, maxBytes)` on S3 and WebDAV, by the path the mirror recorded when it
  copied the file, and only by `FileBytes`.
- **The vault is asked by Montra's own id** (`sentFile(ref)`, the package's `AppClient.sentFile`, which replaces the
  port's `download(documentId)`), so the answer is the exact file Montra sent even after the family adds a newer
  version, and asking needs no read grant over the family's papers. Only a `filed` row is asked: an Inbox item isn't
  the record, and an `out_of_reach` one is missing by §5a. Not found, not allowed to download, and too large for a
  day's reading are all "the vault didn't return it", with no guess at why; a different file under Montra's id is the
  same. Its daily read cap holds every read until the vault's reset (`read_held_until`), so nothing asks again before
  then, and isn't a failure; a connection problem wakes the connection's check, which stops it and tells owners as in
  PR 3. The transport's answer limit is raised from 4 MB to an upload's limit plus 1 MB, so a file Montra may hold can
  come back.
- **Showing a file to a person never asks the vault** (§5). A preview of a file only the vault holds answers 409
  `file.in_vault`, "Open it there", and the person uses "Open in the vault" (PR 4); one the mirror holds is served from
  there. The web's handling of that answer comes with 5b, when such files first exist.
- **Re-reading needs Montra's copy.** The doc-worker reads files by key, inside the transaction that queues it, where
  the vault can't be asked. So a receipt, payslip, scan, intake or import made from a file only the vault holds first
  asks for it (`ensureHeld`), stores it under a new key and sets `location` back to `montra`; 5b's removal takes it
  away again once nothing is reading it. Inside a transaction a missing key is a 409 to try again (`heldKey`), never a
  null key in a job.
- **Jobs** that read a file (AI reading, imports, intakes) fail for good, in words, on a file the vault won't return,
  and are retried by the queue on a hold or a vault that can't be asked now.
- **Backups and tax packages** hold every file they can get, from wherever it is, and list the rest by name, id and
  reason at the end of their README, with "Upload them again in Montra"; they never fail for a file. On screen, the
  count and a link to "Files to provide again" come with 5b (an `ExportJobDto` change). A background archive doesn't
  yet wait for the vault's next daily reset (§5a says once): it lists a file held by the cap like any other, and 5b
  decides whether to add the wait.
- **The mirror's and the vault's own jobs never ask the vault.** The mirror marks a file only the vault holds
  `skipped`, with the words, rather than spend the vault's daily reads on a copy; the vault's job only sends what
  Montra (or the mirror) holds.
- **A restore** keeps every file as Montra's (`location = 'montra'`): a restored workspace starts unconnected (§7).
- **A purge** removes the objects of a workspace's files and any source the vault's job still has to remove (a crash
  between 5b's commit and its delete), and no key that isn't there.
- **Tests** (`family-vault-file-bytes.test.ts`) make a file held only in the vault as 5b will: sent to the fake, filed
  there by a person from the bytes the fake received, then Montra's object removed. Files are binary, every byte value
  from 0 to 255, here and now in the PR 3 and PR 4 suites too, which used text files while the fake read a body as
  UTF-8. Problem answers that say how long to wait now carry `Retry-After`, and a deliberate 503 isn't reported as a
  fault.

### As built: PR 5b1 (2026-11-17)

PR 5b is split again, as the brief allowed: **5b1** (this) turns on "sent with no local copy" with removing sources
(§5), missing files and "Files to provide again" (§5a) with their Review badge and notification, uploading again,
the web's handling of `file.in_vault`, and quota (BAK-08); **5b2** is the move backfill for files filed before a group
was switched, bringing files back, the disconnect choice (§10), the missing count on an archive's screen (an
`ExportJobDto` change), a background archive waiting once for the vault's daily reset, and restore marking. Still on
`@fdv/client` 0.9.0-dev.62. Migration `0067_vault_no_local_copy.sql`. Where 5b1 differs from or adds to the text above,
and why:

- **The third mode is offered** (`VAULT_GROUP_MODES_OFFERED` is all three; the 422 `vault.mode_not_offered` is gone),
  owner only as any change but turning payslips or tax documents off, and with a recent sign-in, as a move (§2).
  Settings warns before saving it (§5a's words) and says when the owner's own storage still keeps a copy of that group
  (`VaultConnectionDto.mirrorGroups`). The DTO also gains `files: { onlyInVault, missing }`, shown with the counts.
- **What is removed.** A file whose document the vault files *while* its group is sent with no local copy (filed from
  the Inbox, or sent and filed at once). Documents filed before the group was switched keep Montra's copy: moving them
  is the move backfill, with its count and confirmation (5b2), not a side effect of saving the mode. A file Montra put
  back to read it again (`FileBytes.ensureHeld`) loses its copy again, looked at 30 minutes later and waiting while
  anything reads it.
- **The conditions**, all checked in the transaction that moves the file, with the file and its outbox row locked:
  1. the row is `filed` (never `received`: an Inbox item can still be removed or lapse);
  2. the vault says it could give back the exact file Montra sent (`content_available`). What it said may be from
     before it filed the item (the feed can file a row the job never asked about again), so a row without a yes is
     asked about once more, in a batch, before anything is removed;
  3. when the owner's S3/WebDAV mirror is set to copy that kind (`mirror_files` and the kind in its `file_kinds`,
     paused or not), its row for the file is `done`; a mirror that doesn't copy the kind isn't waited for;
  4. `app.vault_file_busy(file)` is false: no receipt, payslip, import, scan, intake or tax form reading it or waiting
     on a person in Review (0064's definition), and, new here, no backup or tax package of the workspace being made;
  5. the connection is `active` (§5.4);

  and, as a guard rather than a condition, the vault's hash is the file's when the vault gave one. Then in that
  transaction `location` becomes `vault`, `storage_key` null, the key goes to the row's `source_key` with
  `source_removed_at` null, and an audit row `file.moved_to_vault` (system, the connection and the vault's document)
  is written. After the commit the object is deleted and only then is `source_removed_at` set; a delete that fails (or
  a crash) leaves the row for the next run, which finishes it first. An object that is some file's copy again is never
  deleted. Tested: each condition alone, the crash and the resume, and that running again changes nothing (one audit
  row).
- **When the job looks.** A new column, `vault_item.remove_at`: set when a row is filed (by an answer or the feed), and
  30 minutes on while a condition isn't met yet, cleared when the copy is gone or the file isn't one whose copy goes.
  `vault_due()` and `vault_next()` count it, and sources still to remove, while the connection is active or failing; a
  failing connection pushes them on rather than spinning the worker.
- **Missing** (§5a) is marked for a file only the vault holds (`location = 'vault'`), not in the trash, when the vault
  doesn't give it back (`vault_refused`) or the feed says its document is out of reach; never for the vault's daily
  read cap, which is a wait (the reader gets `vault_read_cap`; a background archive's one wait comes with 5b2), and
  never for a file Montra still holds, even with its object lost. The reason is Montra's words (`MISSING_WORDS`); an
  audit row `file.marked_missing` per file. A file marked out of reach that the feed shows again is no longer missing
  (`file.found_again`). §5a's "the caller can't wait" case is left out deliberately: a cap clears by itself the next
  day, and asking a person to upload a file the vault will give back tomorrow would be wrong.
- **Review → "Files to provide again"** (`GET …/missing-files`, `MissingFileDto`): owners and admins see every missing
  file, anyone else but a viewer the ones they uploaded, each with what uses it (receipts, payslips, tax forms,
  statements, household and business bills, leases), read under their own row-level security. It sits under the
  statements and bills to file on the web, and on the phone's Review screen (ahead of PR 6), each with an Upload
  action; its count joins the Review badge (`reviewBadgeTotal` on the web, `reviewBadge` on the phone, as tax forms').
- **`files_missing`** joins `NOTIFICATION_TYPES` as a notification people don't switch off (as `vault_attention`): to
  owners, admins and whoever uploaded a newly missing file, at most one a day each (deduplicated by the day), no file
  names, linking to Review.
- **Providing it again** (`POST …/missing-files/:fileId`, multipart; members may, for their own uploads): a PDF or a
  JPEG, PNG or WebP photo, as an upload of a paper. Stored under a new key with the same file id; `location` back to
  `montra`, the mark cleared, `sha256` and `bytes` the new file's; a different hash keeps the first original hash in
  `replaced_sha256`; audited (`file.provided_again`). The file's vault row is replaced by a new `queued` one (a new
  send, with a new id), so the old vault document is no longer Montra's to delete later; the mirror copies it again
  when its copy was skipped or is of other bytes. It counts against the quota again.
- **Quota (BAK-08)** moved here from 5b2 because removal changes it: `app.check_storage_quota()` and
  `app.workspace_storage()` count only files Montra holds.
- **The web's `file.in_vault`**: a receipt's or payslip's viewer shows "kept in Family Document Vault" with "Open in
  the vault" (when the vault has a document to open) instead of the page, from the file's state; and a link to such a
  file (Open original, a bill's or lease's file) lands, through the web's API proxy, on the vault page with
  `problem=in_vault`, which offers the same plain link. The proxy only does that for a person's navigation
  (`Sec-Fetch-Dest: document`) and that one code.
- **Disconnecting** is refused (409 `vault.files_only_in_vault`, with `anyway` too) while any file is held only in the
  vault: deleting the connection would delete the rows Montra reads those files back through. 5b2's choice replaces
  this.
- **The e2e run** sets receipts to "no local copy" with its warning, and lists, counts and uploads again a file marked
  missing in the database (the fake vault lives in the API's process, so filing and refusing are API tests).

### As built: PR 5b2 (2026-11-18)

The rest of "the vault as the record", on `@fdv/client` 0.9.0-dev.62 still (dev.63's API keys are a separate PR; nothing
here touches keys or signing beyond wiping and making them as before). Migration `0068_vault_move_back.sql`. Where 5b2
differs from or adds to the text above, and why:

- **The move backfill, with the owner's answer "Offer to move now".** Right after an owner saves a group as "sent with no
  local copy", the web asks for the count of that group's files the vault has already filed and Montra still holds
  (`GET …/family-vault/move?groups=…`, `VaultMoveDto`) and, when there are any, asks "Move these N files too?". Nothing
  moves unless the owner says yes (`POST …/family-vault/move` with `expected` and the groups; owner only, with a recent
  sign-in; a different count is refused, as for "Send existing documents"; `vault_move_started` with `keepCopy: false`).
  Settings keeps a "Move existing documents" section for later. Confirming only sets each counted row's `remove_at`;
  the job's removal step (§5, `moveOne`) then takes them one file per transaction under the same conditions as any
  removal, none skipped, and leaves a file whose conditions don't hold yet for 30 minutes. A file whose vault copy has a
  different hash is never counted, since it would never move.
- **"Bring the files back"** (`POST …/family-vault/bring-back`, owner, recent sign-in; and as a disconnect choice): every
  group sent with no local copy becomes "sent, keep a local copy" (so nothing is removed again, and a confirmed move
  waiting is dropped), and `vault_connection_state.bring_back_at` asks the job to copy each file held only in the vault
  back into Montra, oldest first and one at a time, through `FileBytes` (the owner's own storage when it has a copy, else
  the vault, counted against its daily reads). Each is stored under a new key, `location` back to `montra`, the outbox
  row's `source_key`/`source_removed_at`/`remove_at` cleared (so only a confirmed move takes its copy again), and an audit
  row `file.brought_back` with where it came from. The daily read cap holds the rest until the vault's reset; a file the
  vault doesn't give back is missing (§5a) and the next is asked for. When none is left, the job ends it
  (`finishBringBack`). Choosing "no local copy" again is refused while files are coming back (409 `vault.bringing_back`).
  Settings says it is happening (`VaultConnectionDto.bringingBack`).
- **The disconnect choice: a soft disconnect** (the owner's design decision for 5b2). With no file held only in the vault,
  disconnecting removes the connection with its key, state and outbox, as before. With some, a disconnect that doesn't
  say is refused with their count (409 `vault.files_only_in_vault`), so the web shows the choice:
  - **"Bring the files back"** (`bringBack: true`): as above, then disconnects once they are back; removed when nothing
    is held only in the vault any more, else kept as disconnected for the files the vault didn't give back.
  - **"Disconnect anyway"** (`anyway: true`): the connection row stays, `status = 'disconnected'` (a new status, vault
    rows only), with its outbox and the references Montra reads files back through. Sending stops (`mirror_files` off,
    `file_kinds` empty, so the trigger queues nothing), the key is wiped (`secret_enc` null, allowed only for a
    disconnected row), the state's holds and bring-back cleared, and `vault_due()`/`vault_next()` never count it. Every
    file held only in the vault (the trash included) becomes missing with the reason "Montra was disconnected from
    Family Document Vault, which keeps this file.", audited and told as any missing file, so it appears in "Files to
    provide again". Readers get `vault_disconnected` in words (410 to a person; a permanent failure for a job) and the
    vault is never asked. Opening is refused in words, and the badges stop offering "Open in the vault"
    (`app.vault_disconnected()`, a definer for members). Changing, checking, retrying or moving answers 409
    `vault.disconnected`. The security log says `vault_disconnected` with `kept: true`.
  - **Connecting again** ("Connect again" on the disconnected card) makes a new key for the same row, keeping its groups
    and outbox, and remembers the vault it was disconnected from (`previousIdentity`). When the pasted code checks out
    for the same vault (its installation id), the files missing because of the disconnect aren't any more
    (`file.found_again`, `reconnected: true`) and are read back as before; tested with the same app in the fake given
    the new key. Another vault: the old outbox goes (its documents aren't Montra's to read there) and those files stay
    missing. Cancelling a reconnect before the code goes back to disconnected.
  - **5b1's refusal stays only where it is still needed:** a disconnected connection isn't removed while any file is
    held only in the vault (its references are how the same vault would give them back), and the same 409 says so;
    once each is provided again or deleted, "Remove the connection" removes it.
- **The missing count on an archive's screen:** `ExportJobDto` gains `missingFiles` (from `export_job.missing_files`)
  and `waitingUntil`. The web's archive list shows "N files couldn't be included" with a link to "Files to provide
  again", and the phone's "Your data" the same words; the web fixtures (`missing-files.test.ts`) and the phone's
  `data-settings` module change with it (the phone takes the DTO from `@montra/schemas`).
- **Archives wait once for the daily read cap** (owner default): any archive, a backup (scheduled or asked for) or a tax
  package, all of which are jobs, that meets the vault's daily read cap stops, is queued again for a minute after the
  vault's reset with `vaultWaited` (`JobQueue.enqueue` gains `runAfter`), and shows "Waiting for Family Document Vault's
  daily limit, until …"; that run lists anything still unavailable rather than waiting again. The ZIP begun is finished
  before the job's temporary files go. Files read from the vault before the cap are read again after the reset (a new
  day's allowance); nothing is kept between the runs. While it waits, `vault_file_busy` keeps Montra's copies, as for
  any archive being made.
- **Restore marking:** a file row whose bytes the archive didn't hold (it listed it as missing, or it was in the trash)
  is restored with no key, `location = 'vault'` (Montra holds no copy), and missing with the reason "It wasn't in the
  backup this was restored from.", audited (`file.marked_missing`, `restored: true`), listed in "Files to provide again"
  and told once. Before, such a row was restored as Montra's with a key that named no object. Every restored file's
  `location` and missing columns are now set explicitly, so an archive from before migration 0063 restores too.
- **A possible duplicate** (the owner's clarification, 2026-11-18). A file the vault can still return is never missing
  (`FileBytes` reads it), so nothing changed there; "Files to provide again" already sends the new copy to the vault.
  What existed: receipts' and statements' uploads answered `duplicateOf` from the file's hash (statements warned on the
  web with "Import anyway"; receipts' answer was not shown), intakes the same, and tax forms refuse a byte-for-byte
  duplicate outright (ADR-0052). Payslips and bills had nothing. Reused, minimally: one lookup (`findDuplicate`, the
  earliest file of the workspace with the same hash, held in Montra or only in the vault, not in the trash and not
  missing, never a sealed one), used by receipts' existing check and added to the uploads of payslips, household bills
  and business bills, which now answer the same `ReceiptFileDto` shape as receipts (`duplicateOf`). The web asks
  "This looks like a duplicate of a file already in Montra. Use it anyway?" before a receipt, payslip or bill is made
  from such an upload; cancel leaves it unused. "Files to provide again" answers 409 `file.possible_duplicate` ("This
  looks like a duplicate of “name”, uploaded on date.", the name only for owners, admins or whoever uploaded it) unless
  `?anyway=true`; the web and the phone ask, and going on stores it and sends it to the vault like any other. Tax forms
  keep their refusal; the phone's own receipt and payslip uploads don't warn yet (PR 6).
- **Tests:** `family-vault-move-back.test.ts` (the offer, the count, a wrong count refused and nothing moving without
  the confirmation; the conditions per file, one `moveOne` call each, the mirror and an inactive connection; bringing
  back byte for byte, the cap's wait and resume; the refused plain disconnect, "Disconnect anyway" with every effect,
  reconnecting the same vault and reading back byte for byte, bring back then disconnect both ways; an archive's missing
  count, a backup and a tax package waiting once and then listing; restore marking; the duplicate warning, cancel and
  upload anyway, and `duplicateOf` on receipts (a vault-only file), payslips and bills), the db test (the new status,
  the null key only when disconnected, never due, the definer for members and not staff), the schema tests, web
  `vault.test.ts` and `missing-files.test.ts`, phone `missing-files.test.ts` and `data-settings.test.ts`, and the e2e
  `files-to-provide.spec.ts` (the warning, cancel and upload anyway).

### As built: API keys (2026-11-18)

On `@fdv/client` **0.9.0-dev.65** (`v0.9.0-dev.65/fdv-client-0.9.0-dev.65.tgz`, 509,935 bytes, sha256
`5f97657d1dd676e8…`, checked against the vault side's numbers; pnpm records its integrity), as "API keys (vault
0.9.0-dev.63–65)" above decides. No migration. Where it differs from or adds to that, and why:

- **Contracts.** `ConnectVaultRequest` (`connectionString`, the `secret` when the string doesn't include it, and
  `version` to connect a kept connection again) replaces `StartVaultConnectionRequest` and `PasteVaultCodeRequest`, and
  `POST …/family-vault` takes it; `POST …/family-vault/code` is gone. `ReplaceVaultKeyRequest` is now `version` with
  either `connectionString` or `clientId`, and `secret`. `VaultConnectionDto` loses `publicKey`, `fingerprint`, `newKey`,
  `keyRotation` and `clockOffsetMs`, and gains `key` (`VaultKeyDto`: client ID, name, permissions, created, expires,
  `expiresSoon`), `keyProblem` (`revoked`, `expired`, `invalid`, or `signed` for a connection made before API keys) and
  `actsAs`. The schemas export the vault's shapes (`VAULT_CLIENT_ID_PATTERN`, `VAULT_SECRET_PATTERN`) and
  `VAULT_KEY_WARN_DAYS`. The web fixtures change with them; the phone has no vault connection DTO, so nothing there.
- **Where the code is.** `keys.ts` is now the sealed shape alone; `connection.ts` reads connection strings
  (`readConnectionString`), checks a key's shape before the package sees it, and maps the key 401s and per-action 403s;
  `vault.service.ts` has `connect` (new, or again for a kept connection) and `replaceKey`; `VaultKeyController` holds the
  two routes that carry a secret, outside the idempotency interceptor. The port loses `registerKey`; `VaultCheck` gains
  `appId`, `key` and `actsAs`, and loses `newKeyConfirmed`. `VaultError` gains `key_revoked`, `key_expired`,
  `key_invalid`, `key_signed`, `not_permitted` (with the permission), `old_code`, `secret_needed`, `invalid_key` and
  `other_app`, and loses `other_key`.
- **`config`** gains `auth` (`key`, or `signed` when absent), `clientId`, `key`, `keyProblem`, `keyWarnedFor` (the expiry
  owners were told of) and `actsAs`, and loses `publicKey`, `fingerprint`, `newKey` and `keyId`. `appId` now comes from
  `/apps/me`.
- **The rotation states are left unused**, not removed: `vault_connection_state.key_rotation` stays `none` (its check
  still allows `made` and `registered`), and `key_rotation_at` null. Dropping the column would need a `-- contract:`
  migration for no gain; a later contract migration can take it with anything else unused.
- **A key problem is looked at daily, not every 15 minutes**: nothing changes until an owner pastes a new key, and a
  wrong secret would count toward the vault's ten failed tries a minute.
- **Connecting needs no "start" any more**, so a new connection is never at `stage: register`; the stage stays in the
  DTO for a connection begun before API keys. "Connect again" after a soft disconnect (PR 5b2) pastes a key on the kept
  row with its `version`; the same vault (installation id) resumes reading the files only it holds, as before.
- **Opening** a document of a connection whose key no longer works answers 409 `vault.needs_vault` with the words, and
  wakes the check, as any connection problem does.
- **Tests.** `family-vault.test.ts` (rewritten: connecting with a string with and without the secret; refusals of an
  old string, a missing, malformed or wrong secret, private addresses and another vault, none echoing what was pasted;
  revoked, expired and invalid keys in words; replacing the key, including refusals of the same key, another app and
  another vault; acting as a person and approval; a connection made before API keys, connected and begun; the secret
  nowhere in a DTO, the security log, the process's output or any table but sealed), `family-vault-sending.test.ts` (a
  503 busy with nobody to review, retried and never a failure; the job's key problems, replaced; the 14-day warning,
  once, to owners), `family-vault-feed.test.ts` (a newer family version stays filed and readable, with its new title,
  `sentFile` still the send's own), `family-vault-file-bytes.test.ts` (a key without `documents.download` is
  unavailable, not missing; the secret is in no part of a backup), `vault-port.test.ts`, the schema and web tests, and
  the e2e `family-vault.spec.ts` (connect with the string and the secret apart, acts as itself, replace the key with a
  client ID). The fake generates keys as the vault does, after its owner's second step, and `expireAppKey` stands in
  for time.

### As built: PR 6 (2026-11-18)

The phone, the last PR of the chain. On `@fdv/client` 0.9.0-dev.65 still; no migration. Where PR 6 differs from or adds
to the text above, and why:

- **The link in a body, for the phone.** PR 4's `POST …/family-vault/files/:fileId/open` answers with a 303, and a
  React Native client can't read a redirect's target (its `fetch` follows it, or hides it). A second route,
  `POST …/family-vault/files/:fileId/link` (`?mode=view|download`), does the same checks through the same
  `VaultOpener.open`, which now returns what the link opens as, and answers `{ url, mode }` (`VaultOpenLinkDto`) with
  `cache-control: no-store`, `pragma: no-cache` and `referrer-policy: no-referrer`. It is outside the idempotency
  interceptor, as the redirect is, so a client that sends an idempotency key gets a new link each time and nothing is
  stored for a replay; nothing logs it. A refusal is the same problem answer as the redirect's, with `Retry-After` for the
  vault's hourly limit. Only the phone's client calls it: `@montra/api-client`, which the web uses, has no method for it,
  so the web keeps never holding a link. Tested in `family-vault-feed.test.ts`: the body and its headers, a new link per
  tap, the vault letting the first visit in and turning the second away (`#used`), the audit row, every table (the
  idempotency store included) and the process's output searched for both tokens, the 429 with its wait and no failure
  counted, a download for a type the vault can't show, `cannot_view`, `cannot_open`, 403, 404 and 410.
- **Opening on the phone** (`features/vault.ts` `openInVault`, `ui/Vault.tsx`): on the tap, the app asks for the link
  and hands it at once to the system browser (`Linking.openURL`). The link lives in that one call: it is never put in
  React state, a cache, the offline store or a log, and the result the screen sees doesn't carry it. Only an https link
  is opened: with the development-only `FAMILY_VAULT_ALLOW_LOCAL_HTTP` (D6, amended), a vault on the developer's machine
  answers `http://localhost…` links, which the phone refuses with the general words, since its own `localhost` isn't
  that machine anyway. Afterwards the phone says, in words, that it opened as a download when the vault can't show the type as
  pages, or why it didn't open: the hourly limit with the minutes to wait (from `Retry-After`; the phone's `ApiError`
  gains `retryAfterSeconds`), not allowed, no longer available, a type the vault can't show and won't let Montra
  download, the vault doesn't let Montra open documents, the connection needs a person, disconnected, not filed yet,
  not found, offline.
- **The status, in Your data** beside the owner's own storage (§13 "Your data → Storage"; the brief's "Settings" is the
  same place, reached from Settings), for owners and admins, as the web's card: the API refuses anyone else. It says
  connected, waiting for approval, needs attention (a key that no longer works, in the web's words; the vault needing a
  person, with the vault's own words; the vault out of reach), the key expiring soon, paused, or disconnected with the
  files to provide again; and where, whom Montra acts as, the key's expiry, any hold for the vault's daily limits, the
  counts, files being brought back and when the feed was last read. Files to upload again link to Review. Everything
  that changes the connection is on the web, and the card says so; "not connected" is shown only when the plan has the
  vault. Read online each time; nothing about the connection is kept on the device.
- **Badges** on receipts, payslips, tax forms and household bills: what the web shows (sending, in the Inbox, filed,
  kept only in the vault, not taken with the vault's reason, failed, "No longer available", missing with its reason),
  "In the vault as: …", the newer version, and "Open in the vault" for each file the vault can open. Household bills
  have no badges on the web (its bills screens don't list files); the phone's bill list does, since its rows have the
  files' ids. Statements still have none on either: their screens don't show their files by id. The badges are read
  online for the files on screen (at most the API's 100) and never stand in the way: a failed read shows none.
- **A page kept only in the vault** (the API's 409 `file.in_vault`): a receipt's or payslip's page whose file only the
  vault holds isn't asked for; it is shown in words ("kept in Family Document Vault, not in Montra") with "Open in the
  vault", or as missing, to upload again in Review. Tax forms and bills show no pages on the phone.
- **The duplicate question on the phone's own uploads** (5b2 left it for PR 6), in the web's words, using the uploads'
  `duplicateOf`. Payslips and bills upload online, so the phone asks right after the upload, before the payslip or the
  bill's scan is made; no makes nothing and leaves the upload unused, as on the web. Receipts go through the offline
  capture queue (`@montra/sync`'s `ReceiptUploadQueue`), which runs in the background, so nobody is there to ask at
  upload time: a capture whose page is a possible duplicate stops after its pages upload, in a new `duplicate` state,
  and the Receipts screen's waiting card asks "Use it anyway?" (the receipt is then made, without uploading again) or
  Discard. The queue's uploader may now answer `{ fileId, duplicate }`; a plain id still works, and queues saved before
  read as they did.
- **A test made exact:** `family-vault-file-bytes.test.ts` "can't ask a vault whose connection needs a person" compared
  `next_check_at`, set by Postgres's `now()`, with Node's clock, and failed now and then by a couple of milliseconds; it
  now asks Postgres whether the check is due (`next_check_at <= now()`).
- **Tests:** `family-vault-feed.test.ts` (the body link, above), `packages/schemas/test/vault.test.ts`
  (`VaultOpenLinkDto`), `packages/sync/test/receipt-queue.test.ts` (a duplicate waits, is used anyway once, or is
  discarded, and a clean capture goes at once), and the phone's `vault.test.ts` (the status in each state and its words,
  roles and the plan, the badges and names, a page kept only in the vault, the open flow and each problem's words, the
  link never in the result, the client's calls and `Retry-After`, the duplicate question and the queued state, and every
  key used in the catalog). The phone isn't run on a device here; the bundle builds (`expo export`).

## Consequences

- Montra can hand a household's papers to the place the household already keeps them, without being the only copy.
- For a group sent with no local copy, Montra reads files from somewhere it doesn't run. Every reader of file bytes moves to
  `FileBytes`, and each one must cope with "not available now". This is the largest part of the work and the reason
  ADR-0031 rejected moving files in the first place; the default mode ("sent, keep a local copy") avoids it entirely.
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
- The vault key's secret (a private key before vault 0.9.0-dev.63) adds one more sealed secret per workspace; losing the
  KMS key means pasting a new key, not losing documents. A key expires as its owner chose: owners are warned 14 days
  ahead and paste the next one.
- Two destinations per workspace (a mirror and a vault) means the storage settings and the phone's status line show two
  connections.
- BAK-05 is unchanged: the vault is not where scheduled backups go. A backup archive could be sent to the vault later
  if the vault takes that kind of file.

## API keys (vault 0.9.0-dev.63–65), 2026-11-18

The vault replaced signed requests with API keys in 0.9.0-dev.63, at the owner's choice, as a hard cutover inside v1
(the vault keeps breaking changes inside v1 until its 0.9.0 release, and moves them to v2 with a deprecation period
after). Dev.64 changed the vault's Settings only; dev.65 (APP8) lets a connected app act as itself. Montra moves to
`@fdv/client` 0.9.0-dev.65 in one PR. This section replaces what §2, §7 and §15 say about Montra's key pair and
signing, and what §9 says about a newer version. Everything else stands.

- **The vault makes the key, not Montra** (replaces §2 steps 1–3). An owner of the vault connects Montra in its
  Settings → Connected apps and generates an API key for it: a client ID (`fdvc_` and 22 base64url characters, not
  secret) and a secret (`fdvs_` and 43), with the key's own permissions (some of Montra's scopes) and an expiry (30, 90
  or 365 days, any number up to 3650, or never). The vault shows the secret once, with a connection string
  (`fdvapp2.…`: the address, the client ID, the installation id when known, and the secret only if the owner chose to
  include it). A Montra owner, with a recent sign-in as before (D4), pastes the string, and the secret when the string
  doesn't include it. Montra checks, in order: the string (strictly, through the package; an `fdvapp1.` string from
  before API keys is refused with what to do instead), the key's shape, the address guard (§8, still public HTTPS only,
  although the package itself takes plain http to this machine), the server's own description (a vault that takes apps,
  whose installation id is pinned as before), and `GET /apps/me` with the key. Nothing is saved unless all of it holds.
  There is no key pair, no fingerprint and no "Montra makes a key" step any more.
- **Requests carry the key** (replaces "signed afresh" in §4 and §12): HTTP Basic, `client_id:secret`, through the
  package's `createAppClient({ url, clientId, secret })`. Montra writes no client of its own, as before.
- **The secret is sealed, never shown** (replaces §7's first three points). `secret_enc` holds `{ v: 2, clientId,
  secret }`, sealed with `FieldCrypto` as before. It is unsealed only for one request or one job run, never returned,
  logged, archived or put in a backup, and no DTO carries it. The two requests that carry it (connecting and replacing
  the key) are outside the idempotency interceptor, so not even a hash of a body with the secret in it is stored. The
  client ID, the key's name, permissions, creation and expiry are not secret, and Settings shows them.
- **The clock** (§7's last point) no longer matters to the vault: nothing is signed within a window. Montra still records
  the offset it measures, for support, and no longer warns about it.
- **The key's state.** Each connection check reads `/apps/me`'s `key` (client ID, name, permissions, `created_at`,
  `expires_at` with null for never, `last_used_at`) and stores it. Owners are warned in Settings, and once by a
  `vault_attention` notification, 14 days before it expires (the vault's own `APP_KEY_WARN_DAYS`). The vault's 401s
  about the key are said in Montra's words, which an owner can act on: "The vault key was revoked / has expired / isn't
  valid — an owner needs to paste a new key". Each stops the connection (`needs_vault`), as any connection problem
  does (§12), and marks it as needing a new key. A 403 for a permission the key lacks says which, per action:
  sending without `documents.send` stops the connection, while reading, downloading, opening or deleting without
  theirs stops only that action, with its words. A download the key may not make is the key's problem, not the file's:
  it never makes a file missing (§5a). `429 rate_limited` after ten failed tries a minute is a wait, as other waits
  are.
- **Replacing the key is owner-driven** (replaces §2's rotation). An owner generates a new key in the vault (an app has
  two live keys at most, so it can move to the next one before the old one ends) and pastes its connection string, or
  its client ID, with its secret. Montra checks it with `GET /apps/me`: the same vault (installation id) and the same
  app, then switches, sealing the new key in place of the old one. Until then the old key goes on working. Montra
  never makes, renews or retires a key: the old one is the owner's to revoke in the vault. A vault restore revokes every
  key, and a view link made with a key ends when the key is revoked or expires.
- **Whom Montra acts as** (APP8). A connected app acts as itself by default; `/apps/me` says `acts_as` (`app` or
  `person`) and `acting_as` (the person's name, or the app's own when it acts as itself). Settings shows which. What
  Montra sends that nothing routes goes to the app's "Reviewed by" person; when nobody eligible can review, or a send
  races an owner switching whom the app acts as, the vault answers 503 busy (retriable, with `Retry-After`), which
  Montra waits out with backoff and never counts as a failure, as PR 3 does for any wait. If the owner who connected an
  app acting as itself leaves the household, its keys are revoked, which Montra says as above. Member fields in app
  views may be null; Montra shows what the vault says, or nothing.
- **Newer versions** (replaces §9's "the vault has a newer version" and PR 4's "No longer available" for this case; the
  owner's choice). The app that made a document keeps reading it (the feed, the document, its content, view links) after
  the family adds newer versions. The feed says it `changed` with the new version; Montra updates "In the vault as: …",
  notes the newer version, and keeps it `filed` and readable. The version Montra's send became is kept as it was. The
  exact file Montra sent is still read back only by Montra's own id (`sentFile()`; there is no `?version`), so
  `FileBytes` gets Montra's bytes, not the family's. A delete still needs the current version to be Montra's own send.
- **Connections made before API keys** stop working (the hard cutover; nothing real is connected). Montra never sends
  their sealed Ed25519 key to the vault: they read as needing a new key, in Settings and in words when checked, and the
  job stops them and tells owners once rather than failing quietly. A connected one takes a new key through "Replace the
  key" (the same app at the same vault); one begun but never given its code connects with a connection string. No
  migration: the stored shape is jsonb `config` and the sealed `secret_enc`, and a config saved before has no `auth`, so
  it reads as `signed`.

## Alternatives considered

- **Treat the vault as one more mirror only** (never the record): simplest, and it is the "copy" role. Rejected as the
  only option because the owner wants the vault to be where documents live.
- **Make the vault the record with no backup choice**: Montra would depend on the vault's settings and limits for every
  file read. Kept as an option behind a warning instead, with missing files asked for again (§5a).
- **One role for the whole connection** (a copy, or the record with a backup at Montra, at the owner's storage or
  none), as first written: replaced by a mode per group (owner's clarification, 2026-11-17), so a household can keep a
  local copy of some kinds and not others, and send some kinds and not others.
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
- **A long-lived token instead of signed requests**: not what the vault offered at first, and a token in Montra's database
  is worth more to a thief than a key that only signs within a short window. The vault's owner chose API keys later
  (vault 0.9.0-dev.63): each with its own permissions and expiry, revocable, and sealed in Montra like any secret; see
  "API keys (vault 0.9.0-dev.63–65)".
- **One key pair for all of Montra**: a single leak would reach every household's vault. One per workspace, as agreed.
- **Send files as soon as they're uploaded**: Montra would often need them back for reading and Review, which for a
  group sent with no local copy would cost the vault's daily read cap. Sending after processing avoids it.
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

## Owner's clarification (2026-11-17)

After PR 1, the owner said how the vault should sit beside Montra's storage, in these words:

> Its a choice when someone add vault as the storage, they can choose to keep a local copy of all documents or
> selective documents by type or not even send a specific type to vault and just keep it locally. When I say locally,
> it refers to MonTra provided default storage or the user provided S3/Webdav and vault is additional storage and
> anything filed there are records but user can choose to keep or not not keep local copy and choose to send or not
> send any specific type of document.

Applied as follows (§1, §5, §6, §11, §13, VLT-02, VLT-04):

- The connection-wide role (copy or record) and the record role's backup choice are gone. Each group has a **mode**:
  not sent (kept only locally); sent, keep a local copy; or sent, no local copy.
- A document **filed** in the vault is the household's record in either sent mode. The vault wins on the document's
  name and kind (§9) and never changes the books.
- **"Local"** is read as where Montra normally keeps the file, its own storage. The owner's S3/WebDAV mirror keeps
  following its own per-kind setting; for a group sent with no local copy, Settings says when the mirror still copies
  that kind, and Montra doesn't change the mirror's setting on its own. Montra's copy is removed only once the vault has
  filed the document and, when the mirror copies that kind, the mirror has it (§5).
- Defaults: receipts, statements and bills are sent with a local copy kept; payslips, tax documents and other papers
  are not sent. Only an owner may choose a sent mode for payslips and tax documents, after the warning (§6). Sealed
  copies of identity documents, logos and exports are never sent.
- D9's connection-wide "vault only" option becomes the third mode, per group.

## Defaults taken (owner may revisit)

The other questions were not answered; the ADR's proposal stands for each:

- **D4. Who may connect:** owners only, with a recent sign-in; admins see the status and retry, and may turn payslips
  and tax documents off but not on.
- **D5. How much Montra says about a document:** the vault kind, a title, the date and whom it belongs to; amounts and
  account last-four digits only with "Describe documents in more detail", per connection rather than per group.
- **D6. Montra and the vault on one machine:** no loopback exception; public HTTPS always.
  - _Amended 2026-11-18 for development only:_ `FAMILY_VAULT_ALLOW_LOCAL_HTTP=on` lets a developer connect to a vault on
    the same machine (`http://` or `https://` to `localhost`, `127.0.0.1` or `[::1]`, as an origin), for a live run
    against a local vault preview. It allows nothing else (no private network addresses, no other names), view links
    must still come back on the vault's own origin, and production refuses to start with it. Production keeps D6.
- **D7. Fixed outbound addresses:** none published; the vault's address restriction for Montra stays off.
- **D8. Types the vault can't keep** (CSV, XLS and OFX statement exports): they stay in Montra only, shown as "not a
  type the vault keeps"; no PDF rendering.
- **D9.** Folded into the per-group mode by the owner's clarification: "sent, no local copy" is offered for each group,
  behind its warning, now that missing files are asked for again (§5a). It is no longer a connection-wide option.
- **D10. Deletes:** the vault's document is kept by default when Montra deletes a file for good, at a retention date
  too; "Also delete it in the vault" is an opt-in switch.
- **D11. Plans:** a `familyVault` feature key, on for the existing plans, as `ownStorage` is.
- **D12. Order:** build now. The vault's view links and deletes have shipped, so "sent, no local copy" ships whole; the
  vault's automatic filing comes next on its side and needs no Montra change.
