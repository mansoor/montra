# ADR-0051: Statements and bills find their account or biller, and learn it

- Status: accepted
- Date: 2026-11-16
- Builds on: ADR-0048 §3 (a scan is read once and suggests where it goes) and §4 (billers and bills); IMP-01..09

## Context

The web imports statements from an account's page: the account is picked first (`/import?account=`). The owner asked
for a Statements screen instead:

> Instead of going to account details and importing the statement, I can do it from the statements screen and the
> system can auto detect the right account and let user confirm the same; after a few imports, the system learns and
> does it automatically. Same should happen for Bills too. If some bill or statement can't be matched automatically
> then it should stay in the review.

And what "automatically" means for statements, as the owner chose it:

> Import if clean: pick the account and import the rows straight away when nothing needs a decision (no column
> mapping, no likely duplicates); anything needing a decision goes to Review. Undo stays available in the statement's
> history.

ADR-0048 §3 already finds a scanned statement's account by the last four digits printed on it, and a scanned bill's
biller by its account number or name. Both only suggest, every time. Nothing is remembered, and nothing finds the
account of a CSV, spreadsheet or OFX file.

## Decision

### 1. A document without a destination is an intake

- A statement uploaded with no account becomes an **intake** (`app.document_intake`, `POST intakes`). Any statement
  file is taken: CSV, XLSX, XLS, PDF, QIF, OFX/QFX, or a photo (JPEG, PNG, WebP).
- A bill scanned with `autoFile` (`POST scans { kind: 'bill', autoFile: true }`) gets an intake when it isn't filed
  automatically. Bills keep their scan path (ADR-0048 §4); without `autoFile` a bill scan behaves exactly as before.
- An intake is the workspace's, not its uploader's (unlike a scan), because Review is shared: anyone who may import
  statements (or record bills, for a bill) can finish it.
- **One reading** (ADR-0048 §3): the file is read once.
  - PDFs, XLS files and photos go to the doc-worker's `doc.extract`. Photos are read with OCR like a scanned PDF.
  - The reading is kept on the intake, and the import is made from it (`previousResult`), as an import from a scan is.
  - CSV, XLSX, QIF and OFX are parsed in the Node worker. Parsing them again for the import costs nothing and gives
    the same grid, so only their signals are kept.

### 2. What identifies the account or biller (signals)

Each file gives at most one **signal**: a stable key that the match memory (§3) is keyed by. The candidates are
found from every detail the file has; the signal is only the most specific one.

| File                 | Signal                                     | Candidates                                                                                                    |
| -------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| PDF, scan, photo     | `last4:1234`, else `issuer:<name>`         | Accounts with the printed last four digits ("account ending 1234"), narrowed by the issuer's name             |
| OFX, QFX             | `ofx:<BANKID or FI ORG>:<hash of ACCTID>`  | Accounts with `ACCTID`'s last four digits                                                                     |
| CSV, XLSX, XLS, QIF  | `last4:1234` from the file name, else `shape:<fingerprint>:<file-name pattern>` | Accounts with those digits; the account a saved mapping profile of the same header fingerprint was saved for |
| Bill (scan)          | `last4:1234` (the bill's account number), else `name:<biller key>` | Billers with those digits, else by name (ADR-0048 §4)                                     |

- **The issuer's name.** The doc-worker is given the institutions on the workspace's accounts
  (`bank_account.institution`) and says which one the statement's text names. No other text comes back from it.
- **The file name.**
  - Its last four digits count only when there is exactly one run of four digits that isn't a year (19xx, 20xx), e.g.
    `Chase1234_Activity_20261101.csv`.
  - Its pattern is the name lower-cased with every run of digits as `#` (`chase#_activity_#`). Banks name their
    exports the same way every month, but two accounts at one bank often share a pattern and a header.
- **The header fingerprint** is the import profile's (IMP-04): file type, normalized header and column count. On its
  own it says which bank, not which account, so it is a signal only together with the file-name pattern.
- **Account numbers aren't stored.** An OFX `ACCTID` is kept only as a hash in the signal; last four digits are
  already stored on accounts and billers.
- When the file gives no signal (a photo with no digits and no issuer), it is matched every time by hand. Nothing is
  learned from it.
- When nothing strong matches, the accounts imported into most recently are offered, as ADR-0048 §3 does. They're
  never picked on their own.

### 3. What is learned (match memory)

- `app.match_memory` holds, per workspace, one row per **kind and signal**: the account or biller it points to, the
  number of **confirmations** in a row, and when it was last confirmed.
- **A confirmation** is a person choosing a target for a document with that signal: on the Statements screen, in
  Review, on the phone's scan screens (an import from a scan, a bill filed from a scan), or by finishing an import the
  memory picked.
  - The same target as the memory's: the count goes up by one.
  - **A different target is a correction:** the memory points to the new target with a count of 1.
- **Automatic** after **3** confirmations of the same signal to the same target, with no correction in between. The
  threshold is a constant (`LEARN_AFTER`), not a setting.
- **Undoing an automatic import** sets the count back to 0, because it may have gone to the wrong account. The
  statement goes back to Review to pick its account.
- An archived account or biller is never picked automatically, whatever the memory says.
- The rule is a pure function in `@montra/importers` (`learnMatch`, `isLearned`), shared by statements and bills.

### 4. Clean, and what happens to an intake

A statement whose signal is learned is imported into its account. The import runs as any other (parse, dedupe,
categorize), and is then **clean** when the existing import checks leave nothing to decide:

- it went straight to preview: no column mapping was needed (`needs_mapping` is the existing check: a confident
  mapping, from a saved profile, a template or the heuristics, and at least one row);
- no likely duplicates (`probable_duplicate` rows);
- no rows in error;
- something to add: not every row is an exact duplicate (the same file again);
- the statement's balance check didn't fail (`mismatch`).

| Detection                                  | What happens                                                                                |
| ------------------------------------------ | ------------------------------------------------------------------------------------------- |
| Learned, and the import is clean           | Committed straight away. "Imported automatically to Checking", with Undo                     |
| Learned, but the import isn't clean        | The import waits in preview, and the intake is in Review with why (e.g. 2 likely duplicates) |
| One candidate, not learned yet             | Suggested: the person confirms it (or picks another). Until then it's in Review              |
| No candidate, several, or unreadable       | In Review, to pick the account                                                               |

- After a confirmation on the web, the import continues in the existing preview, mapping and commit screens.
- From the phone's Review, a confirmed statement is imported if clean (`commitIfClean`); otherwise it waits in preview
  for the web, and the intake stays in Review saying so.
- A bill whose signal is learned is **filed automatically** when its amount and due date were read, through the
  same filing as a confirmed bill (a household bill, or the business's vendor bill). Without both, it's in Review.

### 5. Review

- Review (web `/review`, phone Review) shows open intakes above the transactions to review: **Statements and bills to
  file**, each with its file, why it's there and the suggested account or biller.
- The action picks the account or biller and finishes:
  - a statement is imported into it (and opened in preview on the web);
  - a bill is filed, with the amount and due date read, or typed when they weren't.
- Resolving teaches the memory (§3). An intake can also be dismissed; its file stays.
- Choosing another account for a statement whose import is waiting in preview drops that uncommitted import (it has
  no transactions) and starts one for the chosen account.

### 6. Undo

- An automatic import is an ordinary import batch: undo is the existing 30-day undo (IMP-09), on the Statements
  screen and in the import's history.
- Undoing it also resets its signal's count (§3) and puts the intake back in Review.
- An automatically filed bill is voided from the bill, as any bill is.

### 7. Row-level security

- `document_intake` and `match_memory` have row-level security, enabled and forced:
  - any member of the workspace can read;
  - writing a statement's rows needs a role that imports files (owner, admin, partner, accountant), and a bill's also
    allows members, matching who may file bills (AUTH-18).
- Jobs run as the person who uploaded, as every job does.
- The memory points only at the workspace's own accounts and billers, and is checked against what the person can
  write when it's used.

### 8. Sync (ADR-0013)

Intakes, like imports and scans, aren't synced entities. The phone reads and resolves them online. Accounts and
billers it picks from are those it already has.

### 9. What stays manual

- The first three of every new signal; anything with no signal.
- Every decision inside an import: column mapping, likely duplicates, rows in error and balance gaps.
- Splitting a multi-account export (`accountFilter`) and switching from another app (IMP-13) keep their own screens.
- Payslips (ADR-0048 §3) keep their employer confirmation.
- Bills scanned without `autoFile` and bills typed in. The web's Add a bill keeps its own flow.

## Consequences

- The Statements screen (web) takes any statement without an account. The account page's Import statement still
  imports into that account directly.
- After three confirmations a monthly statement imports itself in one step. A correction costs three more
  confirmations, which keeps two accounts that share a signal from being learned at all.
- An automatic import can still be wrong when a signal really is shared, e.g. two cards of one bank exported with the
  same file name and no digits. The correction reset and Undo are the guard.
- The doc-worker gains photos for statements and the issuer check. Photos need Tesseract, like scanned PDFs.
- Two new tables, both exported in backups (they're the workspace's own learning and work in progress).

## Alternatives considered

- **Learn from the import profile alone.** Profiles are per file shape, which is per bank, not per account. Two
  accounts at one bank would share one.
- **Make the account optional on `import_batch`.** Dedupe, currency, sign convention and categorization all depend on
  the account, so the batch would be half-made until it had one. An intake in front of the batch keeps the import
  pipeline unchanged.
- **Reuse `document_scan` for intakes.** A scan is its uploader's own (ADR-0048 §3); Review is shared. The intake keeps
  the reading it needs, so a person other than the uploader can finish it.
- **Learn after one confirmation, or let the threshold be a setting.** One confirmation can't tell a habit from a
  one-off. A setting is one more thing to explain, and three is what the owner asked for ("after a few imports").
- **Automatic bills by default on the scan path.** The web's Add a bill and older phone builds expect a scan to wait
  for confirmation; `autoFile` keeps them working.
- **Import automatically and let the person fix duplicates afterwards.** The owner chose "import if clean": anything
  needing a decision waits.
