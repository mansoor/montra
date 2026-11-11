# ADR-0030: QIF and OFX/QFX files

- Status: accepted
- Date: 2026-11-10

## Context

Quicken for Windows exports QIF, not CSV. Most banks offer OFX or QFX (Quicken's OFX) downloads, with a stable id per
transaction and the statement's closing balance. ADR-0029 left both out: the Switch page sent those users to bank CSVs.

Neither format is a grid:

- **QIF** is records of one-letter fields, ended by `^`, in `!Type:` sections. `!Account` blocks name accounts in a
  multi-account export.
  - Dates are written as the PC's locale writes them, with a two-digit year after `'` from 2000 on (`1/5'26`).
  - Categories are `Cat:Sub/Class`; a category in brackets (`[Savings]`) is a transfer.
  - Splits are repeated `S`/`E`/`$` lines.
  - Files are often Windows-1252.
- **OFX 1.x** is SGML with unclosed leaf tags. **OFX 2.x** is XML. **QFX** adds Intuit's `INTU.*` tags.

## Decision

- **Two new file types, `qif` and `ofx`.** QFX is stored as `ofx`. Migration 0028 widens `import_batch.file_type`.
  - Detection sniffs the content first (`OFXHEADER`, `<OFX>`, or a leading `!Type:`/`!Account`), then the extension.
    A bank's "download.txt" is still read as what it is.
- **Read into a fixed grid with a known mapping.** The readers write columns Account, Date, Payee, Memo, Category,
  Category group, Transfer, Amount, Number and Transaction ID. `analyze()` maps them itself (template `qif`/`ofx`).
  Preview, dedupe, categorization, the mapping step and the switch flow's account split then work unchanged.
  - Every QIF (or OFX) grid has the same columns, so saved import profiles can't tell files apart. The fixed mapping
    always applies. A saved profile only settles a day/month order the user confirmed earlier.
- **QIF dates** are normalized before the usual detection: padding spaces go, and two-digit years become four digits
  (`'26` is 2026; `/26` uses the usual pivot, below 70 is 20xx). Day/month order comes from the data, then the user's
  locale, with the `ambiguous_date_format` warning as for CSVs. The switch flow reads dates with the same locale
  preference.
- **QIF splits keep their total: one row per transaction.** Its category is the splits' common one, or none when
  they differ. That row is what the bank statement shows, so it dedupes and matches against bank imports, and a transfer
  inside a split doesn't half-pair. The parts are lost; Montra's split editor can redo them.
- **QIF transfers.**
  - `[Account]` leaves the row uncategorized and adds "Transfer : Account" to its text, so ADR-0029's pairing (and the
    review queue's transfer step) finds the other side.
  - Quicken's first "Opening Balance" record is the account's opening balance, not a transaction.
- **QIF sections.**
  - Bank, CCard, Cash, Oth A and Oth L sections are transactions; their type suggests the account kind in the switch flow.
  - `!Type:Invst` is skipped with a counted warning (`investment_transactions_skipped:N`).
  - Category, class and memorized lists are skipped silently.
- **OFX statements.**
  - Each `<STMTRS>`/`<CCSTMTRS>` is one account, named from the bank (`<FI><ORG>`), its type and the last 4 digits of
    `ACCTID` ("First Bank Checking ••5678").
  - `TRNAMT` is signed as written. A statement whose amounts are all unsigned is signed by `TRNTYPE`.
  - `XFER` rows get "Transfer" in their text. Investment statements are skipped with the counted warning.
- **FITID in the dedupe key.** When a row has a bank id, it stands in for the description in the exact-duplicate key, so
  a bank renaming a payee between downloads doesn't defeat dedupe. Two same-day, same-amount rows with different ids
  stay distinct.
- **OFX closing balances.**
  - `<LEDGERBAL><BALAMT>` is the batch's closing balance. With no opening in the file, the balance check stays `n_a`.
  - In the switch flow, a new account opens at the closing balance minus the file's rows, so it ends at the bank's figure.
    OFX writes card balances negative when owed, as Montra's rows are.
- **The Switch page** gets Quicken (Windows) (File, File Export, QIF File, one account at a time) and "Your banks (OFX or
  QFX downloads)". The Quicken (Mac) note no longer says QIF can't be read.

## Consequences

- People leaving Quicken for Windows, and anyone whose bank offers OFX/QFX, can switch or import without CSV detours.
- QIF split detail and investment actions aren't brought over. The warning says how many investment records were left
  out.
- An OFX file's balance check needs an opening it doesn't give. Comparing the account's balance with the closing balance
  after commit would be a separate check.
- While a deploy rolls, an old worker given a `qif`/`ofx` batch would read it as CSV and find no rows. That is harmless
  and gone once the deploy finishes.

## Alternatives considered

- **Split rows as separate import rows.** This keeps the categories, but the parts would no longer match the bank's
  single transaction (dedupe, manual-entry matching), and a split with a transfer part would pair only part of the money.
- **A separate parse path for QIF/OFX.** This would mean a second preview, dedupe and commit implementation. The fixed
  grid reuses the tested one.
- **Fingerprint profiles per account for fixed grids.** Profiles exist to remember a column mapping, and these files
  don't need one. Only the confirmed date order carries over.
