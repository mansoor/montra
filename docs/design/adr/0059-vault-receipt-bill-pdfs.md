# ADR-0059: Receipts and bills sent to the vault as one PDF each

- Status: accepted (the owner's decisions of 2026-11-25 are in "Owner's decisions")
- Date: 2026-11-25
- Builds on: ADR-0054 (the Family Document Vault as a storage provider: groups, modes, the outbox, sending once with the
  hash check), ADR-0057 (rendered files as files of their own, the conversion state on the outbox row, "Send again" as a
  new document)
- Amends: ADR-0054 §3 (a receipt's or bill's file no longer goes one at a time) and §5 (their pages stay in Montra in a
  group sent with no local copy), ADR-0057 §1 and §8 ("receipt photos / bills as PDFs" was left for later: this is it)
- Requirements: VLT-14, VLT-15 (§8)

## Context

Montra sends files to the household's vault one file at a time (ADR-0054 §4), and the outbox (`app.vault_item`) is
keyed by file. The owner scanned a two-page utility bill on the phone. Montra kept it as one bill: an `app.document_scan`
of kind `bill` with two `file_ids`, filed as one household bill. The vault received two separate one-page JPEG documents.

What a person captures together is one paper:

- a bill of one, two or many pages;
- a long receipt photographed in parts ("Add the next part" on the phone; several photos per upload on the web);
- a restaurant bill whose items are on one slip, and whose tax, tip and card are on a second slip added as the next part;
- a single receipt with everything on it.

Montra's records already hold their pages in order: `app.receipt.attachment_ids`, `app.household_bill.attachment_ids`,
`app.bill.attachment_ids` (a business's bills), `app.reimbursement.file_ids`, and a bill scan's or intake's `file_ids`
until it is filed. The API already draws and copies PDFs with pdf-lib (ADR-0057).

## Decision

### 1. One record, one PDF (owner's decision 1)

Every receipt and every bill goes to the vault as **one PDF**, a single photo included ("always a PDF").

- **Pages:** one page per photo, in the record's order. A PDF the record holds gives all of its own pages, copied as
  they are (text stays text), in its place in the order.
- **Full quality:** a JPEG goes in as it is (DCTDecode): its bytes are neither decoded nor compressed again. The camera's
  EXIF orientation is applied by how the page draws the image, never by re-encoding it. A PNG is lossless already (pdf-lib
  keeps its pixels; a 16-bit PNG is drawn at 8 bits). A photo's page is Letter's width (8.5 inches) and as tall as its
  shape needs, up to the 200-inch page PDF readers show; the image keeps its full resolution whatever the page's size.
- **WebP:** pdf-lib can't put a WebP photo in a PDF without decoding it, so the API decodes it with `sharp` (owner's
  answer, 2026-11-25), turns it upright by its EXIF orientation and puts it in as a lossless PNG page. Any other kind of
  image, or a page that can't be read, makes the record "not converted": its pages stay in Montra and its badge says
  why; taking that page out (§4) lets the rest go. Phones capture JPEG.
- **Only the PDF goes.** Montra keeps the original pages for itself and sends nothing else: no original attached (unlike
  ADR-0057's "attach the original"). The pages' own outbox rows become `converted` and are never sent.
- **A record that is one PDF already** (a PDF invoice uploaded on its own) goes as it is: it is the record's one PDF, and
  copying its pages into another would only lose what pdf-lib doesn't copy (attachments, form fields, signatures). Once a
  PDF of the record has been made (its pages changed, §4), the record always goes as a made PDF.
- **Which records:** a receipt, a household bill, a business's bill, a reimbursement (its receipts, in the Receipts
  group; a contractor's approved reimbursement becomes a business bill with the same pages, which is the same PDF), and a
  bill scan or intake that wasn't filed (a scan that failed, an intake dismissed). Files another record holds alone go as
  they are, as before: a lease's and a maintenance log's attachments (stored as kind `invoice`, so in the Bills group)
  and an invoice's own PDF.
- **Hints:** the PDF says what its record would (ADR-0054 §3), read through its first page: the receipt's date, the
  bill's date and member, the amount only with "Describe documents in more detail". Its title is "<first page's name>
  (PDF)".

### 2. When it goes

Once the record's pages are complete, never as each photo lands:

- the record exists (the phone uploads a capture's parts one at a time and then creates the receipt once; the web does
  the same), none of its pages is still being read or waits on a person (`app.vault_file_busy`: a receipt `processing` or
  `needs_review`, a scan or intake still open), and its newest page has settled (ADR-0054's two minutes);
- **a page no record holds yet never goes on its own.** It waits (looked at every five minutes for a day, then every six
  hours) for its record. A capture abandoned on the phone, or a photo held back as a possible duplicate, is never sent;
- a receipt in the Trash waits there; restored, it goes.

### 3. The PDF is a file of its own, as ADR-0057 §4

The PDF is stored once as a new `app.file` and sent through the outbox like any file, so everything ADR-0054 §4 relies on
holds without change: the id saved before the first send, the hash check, retries, the daily caps, the not-kept states.
Sending stays idempotent and retry-safe.

- **Data model (migration 0097):** `app.file.rendition` gains `record_pdf`, and `app.file.source_file_ids` (`uuid[]`)
  holds its pages, in page order, as the record held them when it was made. It has no single original
  (`derived_from_file_id` stays null). It has the first page's kind, so it is in the record's group.
- **Why an array on the PDF, not a link from the record:** five kinds of record hold pages, and a bill's pages move from
  its scan or intake to the bill it becomes (and a contractor's reimbursement's to a business bill). Identifying a PDF by
  its pages means "this record's current PDF" is the one whose pages overlap the record's (`source_file_ids && …`), and
  "up to date" is "the same pages in the same order", whichever record holds them now. The same pages are never made
  twice, and no migration is needed on the records.
- **Which record:** `app.vault_file_record(file)` (a definer, for owners and admins: the vault's job reads as an owner and
  some records are their uploader's own or payroll's) answers the record a file is a page of, with its pages in order;
  `other` for a record that holds it alone; nothing for a page no record holds yet.
- **The outbox:** the vault's job marks the record's queued page rows `converted` (`render_options = {"record": true}`,
  `render_state` as ADR-0057) and queues the worker's `record.render` as an owner. The rendering draws the PDF, stores it,
  and in the same transaction gives it a queued outbox row on each vault connection the record's pages are in
  (`queueRecordPdf`). It then records what became of it on the page rows: made or kept (`rendered`), not ready yet (tried
  again in five minutes), not converted (with why, in words), or no record any more.
- **The Trash and retention:** a record's PDF is in the Trash while every page it was made from is, and comes back with
  any of them; when its last page is deleted for good it is marked deleted, so the same retention run removes it. It is
  kept until the latest of its pages' retention dates, or with none while any page has none. It counts toward the quota
  (BAK-08) like any file, and the owner's own S3/WebDAV copy takes it like any file of its kind.
- **Montra's own copy (amends ADR-0054 §5):** in a group sent with no local copy, the pages stay in Montra (they are not
  inside the PDF as files, and the owner wants them kept); the PDF itself follows the group's mode like any sent file.
- **The badge** on each page counts the PDF it is in (`app.vault_file_conversions` gains `combined`;
  `FileVaultSummaryDto.converted.combined`, optional): "Converting to PDF for the vault", "Converted to PDF and sent",
  "Sent as a PDF, in the vault", or "Couldn't be converted" with why. "Send again" isn't offered for a record's PDF:
  changing its pages (§4) is how a new one is made.

### 4. Fixing pages after capture (owner's decision 2)

On the receipt page and the bill page, a person who may change the record can **move a page up or down** and **remove a
page**.

- **API:** `PUT /receipts/:id/pages` (`SetReceiptPagesRequest`: `version`, `fileIds`) and `PUT /household-bills/:id/pages`
  (`SetHouseholdBillPagesRequest`). `fileIds` are the pages the record keeps, in their new order: only pages it holds
  already, each once, and at least one. **Removing the last page isn't allowed**: deleting the record is the way. A
  receipt still being read can't be changed. A stale `version` is a 409.
- **A removed page** goes to the Trash (`deleted_at`) and is deleted for good 30 days later, as any file in the Trash.
- **Nothing is read again.** The receipt's totals, and the bill's amount and dates, stay as they were read, and the
  screen says so ("The totals stay as they were read").
- **A business's bill** keeps its existing `PATCH /bills/:id` with `fileIds`; a change there tells the vault the same way.
  Its screen shows only the first page today, so it gets no page controls here.
- **Splitting** one record into two, or **merging** two, is not in scope.

**How the vault gets the change: a new document, not a version.** The vault's API has versions (`vault_version` is read
from its feed, and a person can add one in the vault), but the app client Montra uses (`@fdv/client` 0.9.0-dev.72,
`createAppClient` in `connection.ts`) offers an app no way to add a version to a document: `send` makes a new intake for
a new external id, and nothing names the document it would add to. So Montra does what ADR-0057 §4 does for "Send
again":

- the PDF the vault has had is set aside (`app.file.superseded_at`): it stays in the vault, and in Montra with its pages,
  but it is no longer the record's current PDF;
- a new PDF is made from the pages as they are now and sent as a new document, under a new id;
- a PDF the vault hasn't had yet is simply replaced.

`app.vault_pages_changed(files)`, called in the transaction that changes the pages, marks the record's page rows: rows
still waiting are looked at again now, and rows the vault had (`pending`, `received`, `filed`) get
`vault_item.pages_changed_at`, which the job treats as due (`vault_due`, `vault_next`). A record the vault never had is
not sent because its pages moved.

### 5. Already-sent items stay as they are (owner's decision 3)

Only new captures, and records whose pages are changed afterwards, go as PDFs. There is no backfill and no re-send: a
receipt or bill whose photos the vault received one at a time before this change keeps those documents, and its page
rows stay as they are. If its pages are later moved or removed, the vault gets one PDF of the record as it is now (a new
document), and the photos it had stay there. "Send existing documents" (ADR-0054 §12) adds files not yet in the outbox,
which now go inside their records' PDFs.

### 6. Where it shows

- **Web:** the receipt page has a "Pages" card (move up, move down, remove, with a confirmation for removing) for a
  receipt of two or more pages; the bills list on the budget page has "Pages (n)" on a bill of two or more pages, which
  opens the same controls.
- **Phone:** the receipt screen already shows the pages (the photos disclosure), so each page there has Move up, Move
  down and Remove. The bills list (2026-11-26) has a "Pages" fold under a bill of two or more pages, for those who
  record, with the same controls and words for each page (Page n, Move up, Move down, Remove with a confirmation) and
  the bill's hint that the amount and dates stay as read. It lists the pages by number, as the web's list does; it
  doesn't show them.

### 7. Other records with several files, unchanged

These go through other paths and are not changed: payslips (`payslip.attachment_ids`, Payslips group, one file at a time
as before), tax forms (`tax_form.file_ids`, one file each today), leases and maintenance logs (`attachment_ids`, kind
`invoice`, sent one at a time as before), payroll I-9 documents (sealed, never sent), statements (ADR-0057).

### 8. Requirements

Added to `docs/requirements/R1-requirements.md`:

| ID     | Requirement                                                                                                                                                                                                   | P   |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- |
| VLT-14 | Each receipt and bill goes to the vault as one PDF of its pages in their order, a single photo included, once its pages are complete; photos go in at full quality, a PDF's pages are copied, and no page is sent on its own. | S   |
| VLT-15 | A person can move a receipt's or bill's pages up or down, or remove one (never the last); the totals aren't read again, and the vault gets the record's new PDF.                                                       | S   |

## Consequences

- The household's vault holds one document per receipt or bill, in the order captured, instead of a document per photo.
- The vault never sees a photo on its own again; a capture that never becomes a record is never sent.
- More storage: each record's PDF is a second copy of its pages (BAK-08 counts it).
- A record whose pages change after it was sent is in the vault twice: the earlier PDF (or photos, before this ADR) and
  the new one. The vault decides what happens to the earlier one; Montra doesn't delete it.
- The API depends on `sharp` (native, with prebuilt libvips) for WebP pages.

## Alternatives considered

- **A new version of the same vault document.** Preferred, and the vault has versions, but the app client offers no way
  to add one (§4). When it does, the record's PDF can go as a version of the first one: `vault_document_id` of the
  superseded PDF's row is the document to add to.
- **A link from each record to its PDF** (`receipt.pdf_file_id`, …). Rejected: five record kinds would need it, and a
  bill's pages move between records (§3).
- **Render on every send.** Rejected for the reason ADR-0057 gives: the hash check needs the same bytes on every attempt.
- **Send the photos as well, or attach them inside the PDF.** Rejected by the owner (decision 1): only the PDF goes, and
  Montra keeps the photos.
- **Re-encode every photo** (to normalise orientation or size). Rejected: it would compress JPEGs again, worse than the
  source.

## Owner's decisions (2026-11-25)

1. **Every receipt and every bill goes to the vault as one PDF**, a single photo included: one page per photo, in capture
   order, at full quality, without compressing again worse than the source. Montra keeps the original photos and sends
   only the PDF. A PDF uploaded as a PDF stays a PDF, and a record that mixes PDFs and photos gives the PDFs' pages and
   the photos, in order. What the user captures together is one document.
2. **Fixing pages after capture:** on the receipt page and the bill page, move a page up or down and remove a page. After
   a change the vault gets the updated PDF, as a version of the same document if the vault and the client allow it, and
   otherwise as ADR-0054/0057 do (§4: a new document). Removing the last page isn't allowed. The totals aren't read again,
   and the screen says so. Splitting or merging records is not in scope. The web is required; the phone only where its
   receipt or bill screen already shows the pages.
3. **Already-sent items stay as they are.** Only new captures, and records whose pages are changed afterwards, go as
   PDFs. No backfill, no re-send.

## Open for the owner

- **WebP pages** (§1): answered 2026-11-25: add `sharp` and decode WebP to a lossless PNG page.
- **Reimbursements** (§1) are treated as receipts (one PDF per reimbursement). Say if they should go page by page as
  before.
- **A single PDF goes as it is** (§1) rather than as a copy of its pages.
- **The earlier PDF in the Inbox** (§4): when a record's pages change while its earlier PDF is still in someone's Inbox
  (not filed), Montra could withdraw it (ADR-0054 §10), so the family isn't asked about an outdated paper. Not done now.
