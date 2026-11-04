# ADR-0019: reports, search, notifications and data ownership

Date: 2026-11-04. Status: accepted. Phase 10 (RPT-01..06, RCP-09, NOT-01..03, AUTH-12, NFR-05, NFR-06, BAK-04..06, BAK-08, BAK-09,
OPS-10, OPS-13).

## Context

Phase 10 closes R1's feature set. Four areas share one concern: people must be able to see, question and take out what's theirs,
without any of it weakening who can see what. Nothing here may bypass RLS, send amounts or tenant names further than they need to
go, or lose data on the way out and back in.

## Decisions

1. **One report shape.** Every report in the catalogue returns the same `ReportDto`: columns, rows, totals, an optional chart, and a
   drill filter per row (RPT-03). Filters (RPT-02), saved reports, the web table and PDF, CSV and XLSX export (RPT-04) are each written
   once. Reports with their own richer screens (Schedule C and E, P&L) feed the catalogue from the same services, so the numbers agree.

2. **Reports run under the viewer's RLS, in the base currency when consolidated.** With no entity chosen, entities in another currency
   are converted at the period end's rate, with a note; an amount with no rate is left out and the note says so. General ledger, trial
   balance, balance sheet, P&L and tax summaries need one entity: consolidating them would need eliminations that don't exist yet.

3. **Search reads a parsed query, and notes are matched after decrypting.** `q=coffee >20 tag:travel` is parsed by one pure function
   used by the transaction list and global search. `memo_enc` is encrypted per workspace, so notes can't be indexed in SQL: the most
   recent 5,000 are decrypted in the API and matched there. A blind index would leak word equality and need a backfill. Receipt text
   uses the existing `search` column.

4. **Ask-your-data gets a query plan from AI, and SQL gets the number.** The design said tool use. A single validated plan (metric,
   categories, payee, periods) does the same job with less to go wrong: no loop, no tool results returned to the provider, so no
   financial figure is ever sent. The provider sees the question, the category names and today's date. Every number comes from a query
   under the user's RLS (AIA-05), and an answer shows the filter behind it. With AI off, the feature says so.

5. **Notifications are created for each member, under that member's RLS.** A partner without access to a business gets no notification
   about it. A notification is written once (dedupe key per user), then delivered by channel according to preferences, held during quiet
   hours, and kept in-app only once the daily cap is reached (NOT-03). Push and email say what happened and where, with no amounts or
   balances, because they show on lock screens and pass through third parties. The figures are one tap away, in the app. The one
   exception is the weekly digest's email, which NOT-02 asks to carry last week's spending and which can be turned off.

6. **Email streams and unsubscribing.** Notification email is the non-essential stream and carries `List-Unsubscribe` with a signed
   one-click link (OPS-10). Security and sharing mail isn't affected. SPF, DKIM and DMARC are DNS and SES configuration, done with the
   Terraform in Phase 11.

7. **The archive is built from the database catalog.** Every `app.*` table is either exported or named in an exclusion list with a
   reason, and a test fails when a new table is neither. Secrets (`workspace_key`, `ai_credential`), caches, feeds and read models
   rebuilt by triggers are excluded. `_enc` columns are decrypted into the archive, because a backup under a key the user doesn't hold
   would be useless to them. An archive holds what its requester can read under RLS; only owners can take a whole workspace.

8. **Password protection without storing the password.** The key is derived in the request (scrypt, N=2^17) and wrapped by the KMS
   port for the job. The file is `MONTRABK1\n`, a JSON line of KDF parameters, the AES-256-GCM ciphertext of the ZIP, then the tag.
   Scrypt replaces the design's Argon2id: Node has it built in, and `age` uses it too. A forgotten password can't be recovered.

9. **Restore remaps every id, and order comes from the catalog.** Foreign keys are read from `pg_constraint` to sort tables, breaking
   cycles on nullable columns with a second pass. Every value in a row, including JSON such as a transaction's spec, has its ids
   replaced. People in the archive map to the restoring user, because accounts can't be restored. A restore is one transaction, so it
   works fully or leaves nothing. Checking the result (entries balance, balances match the manifest) happens in that transaction too.

10. **Restoring into an existing workspace adds, and doesn't merge ledgers.** Entities come in as new entities, named "(restored)", so
    existing books can't change. A workspace has only one set of personal books, so personal books need a new workspace. Shared lists such as tags and members map to an existing row with the same unique key. Duplicate
    transactions, found by dedupe key, are counted in the preview for the owner to judge, and not dropped, because dropping one would
    unbalance what's restored.

11. **Scheduled backups go by emailed link for now.** BAK-05 also lists Google Drive, OneDrive, Dropbox and iCloud, which need OAuth
    applications registered in the owner's name. The destination is a column and a port, so a connector is an addition. BAK-05 stays
    partial until then.

12. **Deletion is reversible for 30 days, and purging is a job.** Requesting it blocks the account at once and flags workspaces where the
    user is the only owner. After 30 days the workspace, its files and everything in it are deleted, and the user row is anonymized,
    since rows in other people's workspaces may still name it. Backups age out within 35 days by their own lifecycle (Phase 11).

13. **Trash keeps 30 days.** Transactions and receipts with `deleted_at` can be restored from one list; their files stay until their retention date. After 30 days, rows with no
    remaining ledger entries are deleted. A transaction reversed in a locked period keeps its rows, because the reversal needs them.

14. **Security events are per user.** Sign-ins have no workspace, so `security_event` belongs to the user, separately from `audit_log`.
    It's append-only and shows sign-ins from new devices, MFA changes, exports, restores, deletions and support access (AUTH-12).

15. **Storage is metered per workspace.** The quota is `workspace.storage_quota_bytes` (5 GB by default, until plans arrive in Phase 11),
    checked when a file is stored. Exports and backups don't count: they expire after 7 days, and a full quota mustn't block getting
    your data out.

## Consequences

- A new table must be classified for backup, or its test fails. That's deliberate.
- Restore holds one transaction for its whole run, so a very large workspace will take a while; restores are limited to 1 GB uploads.
- A push or email can feel vague without amounts. That's the trade for not exposing them.
- A report with no rate for a currency shows less than the full picture, and says so.

## Alternatives considered

- **A tool-use loop for questions**: more provider round trips, and tool results would carry amounts to the provider.
- **A blind index for notes**: leaks which notes share words, for a little speed nobody needs at this size.
- **Restoring with original ids**: fails whenever the original still exists, which is the common case.
- **`pg_dump` as the backup**: unreadable to the user, and it can't scope to an entity or respect RLS.
