# ADR-0057: Statements the vault doesn't keep, sent as PDFs with a cover page

- Status: accepted (2026-11-24; the owner's answers are in "Owner's answers")
- Date: 2026-11-24
- Builds on: ADR-0054 (the Family Document Vault as a storage provider: groups, modes, the outbox, hints, the
  "Describe documents in more detail" switch), ADR-0031 (the destination port and the outbox), ADR-0006 and the import
  pipeline (profiles, reference layouts and AI mapping that turn any statement file into rows), ADR-0037 §5 and BIZ-26
  (sealed numbers shown masked, in full after a recent sign-in)
- Amends: ADR-0054 §3 ("File types": CSV, XLS and OFX statements stay in Montra) and §5 (when Montra may remove its own
  copy)
- Requirements: VLT-02, VLT-03, VLT-04, ACC-02; adds ACC-15, ACC-16, VLT-12 and VLT-13 (§9)

## Context

The vault keeps documents and images. ADR-0054 §3 therefore leaves every statement that isn't a PDF in Montra only,
shown as "not a type the vault keeps". Many statements arrive that way: a CSV or XLS export, an OFX or QIF download, or a
bank's own spreadsheet layout. The household's record in the vault then has gaps for exactly those months.

Montra already understands these files. The import turns each of them, whatever its layout, into the same rows
(date, description, amount, balance) through a saved profile, a reference layout or AI mapping. The import batch also
knows the account, the dates covered, the opening and closing balances, the counts, and whether the balances check
out. The API already draws PDFs with pdf-lib (invoices, payslips, reports, the tax package).

What Montra doesn't hold today: who the account holders are (only a default member) and the full account number (only
the last four digits).

## Decision

### 1. A choice per group for files the vault doesn't keep

Each group that is sent (ADR-0054 §6) gets one more setting, **"Files the vault doesn't keep"**:

| Choice                                     | What happens                                                                 |
| ------------------------------------------ | ---------------------------------------------------------------------------- |
| **Don't send**                             | As today: the file stays in Montra, marked "not a type the vault keeps".     |
| **Convert to PDF and send**                | Montra renders a PDF (§2, §3) and sends that.                                |
| **Convert to PDF, attach the original**    | The same PDF, with the original file attached inside it (a PDF attachment).  |

- The choice applies only where Montra has a renderer. In this ADR that is the **Statements** group (§2). Other groups
  show only "Don't send" until a renderer exists for them.
- The default for Statements is **Convert to PDF, attach the original**. For every other group it is **Don't send**.
- PDFs and images the vault keeps are sent as they are, as today. Turning a receipt photo into a PDF is not part of
  this ADR.
- The setting sits with the destination, not with the group's definition, so the same choice can later be offered for
  the owner's own S3 or WebDAV copy. Only the vault uses it now.

### 2. Render from Montra's rows, never from the raw file

A statement PDF is drawn from the **import batch's parsed rows**, not by parsing the file again. One renderer then
covers every format the import understands, and a new bank layout is covered as soon as the import supports it.

- **Body:** a table with date, description, money out, money in and running balance, in the account's currency. It
  has a page header (account name, period, page n of m) and the batch's totals at the end.
- **A file the import couldn't read** (no committed batch): there is nothing to draw. With "attach the original" the PDF
  is the cover page alone, saying the statement couldn't be rendered, with the original attached. With "Convert to PDF
  and send" the file is not sent and is shown as "couldn't be converted".
- **Large statements** are split into parts. The limit is a setting, `STATEMENT_PDF_MAX_ROWS` (default 5,000 rows per
  PDF). Each part is its own document, titled "part n of m".
- Rendering runs in the Node job worker, as a system job, after the import is committed or when a backfill (ADR-0054
  §12) reaches the file.

### 3. The cover page, on rendered files only

Every rendered PDF starts with one cover page. Original PDFs get none (owner's answer 6). The cover is built from one
**document summary** model, so other kinds of document can use it later. For a statement:

- account name, institution and account type;
- account holders (§5), or the default member's name, or the book's name when neither is set;
- account number (§6): **the last four** by default; see below;
- currency, and the statement period: the statement's own dates when the file had them, else the first and last
  transaction dates;
- opening and closing balance, money in, money out, the number of transactions, and whether the balances check out;
- the original file's name, format and SHA-256, the date it was imported, and "Rendered by Montra from the imported
  rows".

**What the cover says follows the "Describe documents in more detail" switch** (ADR-0054 D5), as the hints do:

- **Off:** account name, institution, type, holders, currency and period only. No amounts and no account number.
- **On:** everything above, with the account number as set by **"Account number on the cover"**: **Last four**
  (default), **Full** or **None**. Choosing **Full** is owner-only, needs a recent sign-in, shows a warning ("The full
  number will be in the vault, where the vault decides who can see it") and goes in the security log.

### 4. A rendered PDF is a file of its own

The PDF is stored once as a new file, linked to the file it came from, and sent through the outbox like any other
file. Everything ADR-0054 §4 relies on then holds without change: the id saved before the first send, the hash check
against the vault's copy, retries and the not-kept states.

- **Data model:** `app.file` gains `derived_from_file_id` (the original) and `rendition` (`statement_pdf`). A
  rendered file belongs to the same group as its original and is never itself rendered again.
- **Hints:** the same as the original's (ADR-0054 §3), with the title "<file name> (PDF)" and the statement's end date
  as its date. The holder member, when §5 links one, is the "belongs to" hint.
- **When it is made again:** if the cover settings, the holders or the account change before the PDF is sent, the
  unsent PDF is replaced. Once the vault has it, it is not redone; a person can press "Send again", which sends a new
  version. Undoing the import drops a PDF not yet sent; one already in the vault stays there (documents go one way,
  VLT-05), and Montra marks it "import undone".
- **Montra's own storage:** the rendered PDF counts toward the quota (BAK-08) like any file. It goes in the Trash and
  follows retention with its original.

### 5. Account holders (owner's answer 1)

Accounts get a list of **holders**: up to `ACCOUNT_MAX_HOLDERS` (a setting, default 4) names, each optionally linked to
a family member. Joint accounts list both. Holders are shown and edited on the account (web and phone) and used on the
cover page. The default member stays as it is (who an account's spending belongs to); holders are who the bank says
owns it.

### 6. The full account number (owner's answer 2)

Montra may keep an account's full number, as it now keeps a business's EIN (BIZ-26):

- stored sealed with the app's field encryption, with the last four kept beside it, so every screen and DTO still shows
  "••••1234";
- shown in full one at a time after a recent sign-in, each view in the audit log;
- typed in on the account's settings by an owner or admin; never in a log, an error or an AI request;
- in a backup archive in full, sealed again on restore, as BIZ-26 does;
- on the cover only as §3 allows.

### 7. Montra's own copy

For a group sent with **no local copy** (ADR-0054 §1, §5), Montra may remove the **original** only when the vault has
filed a PDF with the original attached. A PDF without the attachment loses the original's exact content, so then the
original stays in Montra and Settings says why. The rendered PDF itself follows the group's mode like any sent file.

### 8. Not in this ADR

- **PDF/A.** The PDFs are ordinary PDFs with embedded fonts and document metadata. Making them conforming PDF/A for
  long-term archiving is a backlog item (owner's answer 3). It may mean rendering in the document worker with
  reportlab instead of pdf-lib.
- **Bank feeds.** A feed's batches have no file. Making a monthly statement PDF for a feed account would reuse §2–§4,
  but is not done now (owner's answer 4).
- Renderers for other groups (receipt photos as PDFs, bills), and covers on original PDFs.

### 9. Requirements

Added to `docs/requirements/R1-requirements.md` by the first PR:

| ID     | Requirement                                                                                                                                                                                  | P   |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- |
| ACC-15 | An account lists its holders by name, each optionally a family member, so joint accounts show everyone the bank says owns them.                                                               | S   |
| ACC-16 | An account can keep its full number, sealed at rest, shown masked to its last four and in full one at a time after a recent sign-in, each view logged.                                        | S   |
| VLT-12 | For each group sent to the vault, the owner chooses what happens to files the vault doesn't keep: not sent, converted to PDF and sent, or converted with the original attached inside the PDF. | S   |
| VLT-13 | A statement converted for the vault is drawn from its imported rows, with a cover page summarising the account, holders, period and balances, limited by the detail switch.                   | S   |

## Consequences

- Statements exported as CSV, XLS, OFX, QIF or a bank's own layout reach the vault as readable PDFs, and with the
  default the exact original travels inside them.
- One renderer serves every format the import can read. A format Montra can't import can still go, as a cover page
  with the original attached, but isn't rendered.
- Montra holds more sensitive data: full account numbers, sealed and step-up gated as EINs are.
- More storage: each rendered PDF is a second file. Large statements become several documents.
- A PDF made from rows is Montra's rendering, not the bank's statement. The cover says so, and the attached original is
  the evidence.

## Alternatives considered

- **Render each format directly** (a CSV-to-PDF tool, a spreadsheet printer). Rejected: it would need a parser per
  format and bank layout, which the import already has, and couldn't build the cover's balances and checks.
- **Render on every send instead of storing the PDF.** Rejected: the hash check against the vault's copy needs the same
  bytes on every attempt, and rendering again on retries wastes work.
- **Send the original and let the vault render it.** Rejected: the vault keeps documents and images and decides what it
  accepts; Montra can't rely on it to read bank formats.
- **Covers on every file.** Deferred (owner's answer 6): an original PDF is already the bank's own document.

## Plan

1. **Accounts:** holders and the sealed full number (migration, DTOs, web and phone account settings, reveal, backup).
   ACC-15, ACC-16.
2. **Rendering:** the `derived_from_file_id`/`rendition` columns, the document summary model, the statement renderer
   and cover page, the render job, the split by `STATEMENT_PDF_MAX_ROWS`. VLT-13.
3. **Sending:** the per-group "Files the vault doesn't keep" setting and "Account number on the cover", the outbox using
   the rendered file, §7's rule for removing the original, Settings and the per-file status. VLT-12.

Each PR has tests against the package's fake vault (ADR-0054 §15). Tests check:

- a CSV, an XLS and an OFX statement each give a PDF whose rows and totals match the batch;
- the cover follows the detail switch and the account-number setting;
- an unreadable file follows §2;
- the original is removed only when attached;
- an undone import drops an unsent PDF;
- no full account number appears in a DTO, an error, the audit log or a PDF unless "Full" was chosen.

## Owner's answers (2026-11-24)

1. Account holder names are added to Montra (§5).
2. Montra may keep the full account number (§6).
3. PDF/A is added later; it goes on the backlog (§8).
4. Not for bank feeds now (§8).
5. Besides converting to PDF and uploading, there is an option not to upload files that aren't PDFs (§1).
6. For now, a cover page only on rendered files (§3).
7. The suggested defaults are taken: Statements are converted with the original attached, covers on rendered files,
   and the account number on the cover is the last four.

## As built: PRs 2 and 3 (2026-11-24)

PR 1 (accounts: holders and the sealed full number, migration 0091) is described in `docs/STATUS.md` §7g. Where PRs 2
and 3 differ from or add to the text above, and why:

- **Rendering (PR 2, migration 0092).** `apps/api/src/renditions/`: the document summary (`document-summary.ts`), the
  renderer (`statement-pdf.ts`, pdf-lib with embedded Noto fonts, the same bytes for the same input) and
  `StatementRenditions` (render, store, the `statement.render` job). The original is attached to part 1 only; the
  other parts' covers say so. A rendering is never queued for the vault by the trigger that queues uploads: the vault
  asks for it (below). A file with two committed imports renders the latest.
- **The settings live in the vault connection's `config`** (`groups[].unkept`, `coverNumber`), not in a column, as the
  groups' modes do. That keeps them with the destination (§1): a later S3/WebDAV copy can read the same shape. A group
  without a renderer takes only "Don't send"; the API refuses the others for it.
- **Full on the cover** needs an owner and a recent sign-in, and is in the security log (`vault_changed`, the choice
  only). As ACC-16 audits a reveal, it is also in the audit log (`vault.cover_number_full`), as is each cover made with
  it (`statement.full_number_on_cover`). With the detail switch off the number is `none` whatever the setting, so
  changing it then remakes nothing.
- **The original's outbox row becomes `converted`** (migration 0093) once its import is committed. It is never sent
  itself. It keeps how far the conversion got (`render_state`: rendering, rendered, not converted, import undone) and
  what the PDFs were made with (`render_options`). Each PDF gets an outbox row of its own in the transaction that
  stores it, so the vault's id, hash check, retries and not-kept states (ADR-0054 §4) hold unchanged. An import
  committed or undone nudges the row through a definer (`app.vault_conversion_due`): imports run as whoever made them,
  and the outbox is for owners and admins.
- **"Send again"** marks the PDFs the vault has `app.file.superseded_at`. They stay in the vault, and in Montra with
  their original (Trash, retention), but are no longer its current rendering, so a new one is made with today's
  settings and sent as a new document. The vault's client offers Montra no way to add a version to an existing
  document, so "a new version" is a new document.
- **§7.** The original goes only once the vault has filed the PDF marked `carries_original`, under ADR-0054 §5's other
  conditions. Reading it back reads that PDF as any file and takes the attachment whose SHA-256 is the original's.
- **Where it shows.** The web's import history (Statements and Imports) shows each statement file's vault state from
  `FileVaultSummaryDto.converted`, with Send again for owners and admins. The phone lists no statement files, so it only
  knows the new status and count.
- **Not done:** the holder member as the "belongs to" hint (statements send no person hint yet), and remaking an unsent
  PDF when only the holders or the account change (the next settings change or import does).
