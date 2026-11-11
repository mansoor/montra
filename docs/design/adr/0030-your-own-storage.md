# ADR-0030: Your own storage for files and backups

- Status: accepted
- Date: 2026-11-10
- Requirements: BAK-03, BAK-04, BAK-05, BAK-08, BAK-09; extends ADR-0019 §7, §8, §11, §15

## Context

The owner asked for "additional storage option along with local storage for keeping the files that scanned and imported by the users
as well as that location can be used for storing scheduled and manual backup files."

Today:

- Every uploaded file (statements, receipts, payslips, invoices, leases) goes only to Montra's own object storage, behind `StoragePort`
  (`LocalStorage` in development, `S3Storage` in production).
- OCR, previews, receipt matching, retention dates (RCP-10, BAK-09) and the storage quota (BAK-08, ADR-0019 §15) all read that copy.
- A scheduled backup (BAK-05) goes out only as an emailed link to a download that expires after 7 days (ADR-0019 §11). Its
  `destination` column and the port were left so a connector could be added.

People want a copy of their documents and backups somewhere they control: a NAS at home, Nextcloud, or a bucket of their own.

## Decision

### 1. Mirror, don't move

Montra keeps its own copy of every file, and a copy is also written to the owner's storage.

- Nothing that reads files changes: OCR, previews, matching, retention, quota, archives.
- A broken connection never loses a file. Copies wait and retry, and the owner sees what's behind.
- Moving the files would make every one of those features depend on a server Montra doesn't run. It would also need a read path
  for each kind of storage, and quota would mean nothing. Rejected.

### 2. First destinations: S3-compatible and WebDAV

Neither needs an app registered in the owner's name. Together they cover most of what people use:

| Kind             | Covers                                                                       | What the owner enters                                                         |
| ---------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `s3`             | AWS S3, Backblaze B2, Wasabi, Cloudflare R2, MinIO (on a NAS too), Synology C2 | Endpoint (blank for AWS), region, bucket, access key id, secret, path style |
| `webdav`         | Nextcloud, ownCloud, Synology WebDAV Server, Apache/nginx WebDAV, Box WebDAV | Folder URL, user name, password (an app password where the server has them)  |

- The S3 client sends checksums only when an operation requires them (`requestChecksumCalculation: WHEN_REQUIRED`). The SDK's newer
  default trailing checksums aren't accepted by every S3-compatible service.
- The WebDAV client is about 150 lines over `node:https`: `PUT`, `MKCOL` for folders, `DELETE`, and a `PROPFIND` for the
  connection check. That's the whole protocol Montra needs, so no new dependency.

**Later destinations** implement the same port (`StorageDestination` in `apps/api/src/storage/destinations/`). They add a `kind`,
a connect flow that ends with a refresh token, and a token refresh before each run. Each needs an OAuth app registered in the
owner's name, with its secret in Secrets Manager:

| Kind           | What to register                                                                                                                                                                                         |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Google Drive   | A Google Cloud project, an OAuth consent screen (brand verification once it's public), and a web OAuth client with Montra's redirect URI. Scope `drive.file`, which sees only files Montra made. |
| OneDrive       | A Microsoft Entra app registration for personal and work accounts, with a redirect URI, a client secret, delegated `Files.ReadWrite.AppFolder` and `offline_access`, and publisher verification.        |
| Dropbox        | A Dropbox App Console app with "App folder" access, scope `files.content.write`, a redirect URI and the app key and secret. Production approval is needed past 50 users.                                 |
| iCloud Drive   | Apple has no API for a server to write to someone's iCloud Drive. The phone can save a backup there through the share sheet already (BAK-04). Not planned.                                               |

### 3. Credentials are sealed and never come back

- The secret part (S3 access key id and secret, WebDAV password) is one JSON value sealed with `FieldCrypto`: AES-256-GCM under the
  workspace's KMS-wrapped key, bound to `storage_destination.secret`. It's stored in `storage_destination.secret_enc`.
- The API never returns it. The DTO says that a secret is set, and shows the last four characters of an S3 access key id so the
  owner can tell keys apart. A change that leaves the secret out keeps the stored one.
- A connection is tested before it's saved: Montra writes a small file under the folder, reads the folder, and deletes the file.
  - A failed write refuses the save with a readable reason (refused credentials, no such bucket or folder, can't reach it, the
    storage is full).
  - A failed delete is allowed, because some people give Montra a key that can't delete (object lock, a B2 key without
    `deleteFiles`). The connection is then marked `canDelete: false`, and pruning old backups is off.
- Connecting, changing and disconnecting go in the security log (`storage_connected`, `storage_changed`,
  `storage_disconnected`), and need a recent sign-in (AUTH-09), like taking a backup.
- **Only owners** can see, connect or change the storage, and RLS enforces it. Owners can already read every file (including
  restricted payslips, ADR-0016 §2), so a copy in their storage shows them nothing new.
- **Where Montra may connect.** Any host is the owner's to name, so the API won't connect to private, loopback, link-local or
  metadata addresses in production (`169.254.169.254` and the like). The address is checked when each connection is made, which also
  covers DNS rebinding. HTTPS is required in production too. `STORAGE_DESTINATIONS_PRIVATE=true` allows both for self-hosting and
  development, and it's the default outside production. A NAS at home is reached through its public name, as it would be from
  anywhere else.

One connection per workspace for now (a unique index). The table has its own id, so allowing several later means dropping that
index.

### 4. Folder layout and readable names

Everything goes under one root folder, by default `Montra/<workspace name>`. The owner can change it. It's saved when the connection
is made, so renaming the workspace doesn't split the folder.

```
Montra/Smith household/
  receipts/2026/2026-11-10 Costco receipt (9c41d07e).jpg
  statements/2026/2026-11-02 chase-oct (b81d22a0).csv
  payslips/2026/…   invoices/2026/…   leases/2026/…   other/2026/…
  backups/Smith household-backup-2026-11-10 (5b2f81aa).zip
```

- Files are named `<upload date> <original name> (<last 8 hex digits of the file id>).<extension>`. The id keeps names unique and
  lets a copy be traced back to Montra. It's the last digits because Montra's ids are UUIDv7, whose first digits are a timestamp
  shared by everything made in the same minute. The date and year are the upload's, in UTC.
- Names are cleaned of characters that Windows, macOS or S3 treat specially, shortened to 120 characters, and given an extension from
  the MIME type when they have none.
- The path is saved with the copy, so a later change of root folder or naming doesn't lose track of what was written.
- Archives made by "Back up now" and scheduled backups go in `backups/`, named like the download plus the short id.

### 5. Copying: an outbox, a system job, retries and a visible status

- **`app.storage_mirror_item`** has one row per file and connection: `pending`, `done`, `failed` or `skipped`, with attempts, the next
  attempt, the last error and the path written.
- **A trigger on `app.file`** (security definer) adds a `pending` row when a file is stored, if the workspace has an active connection
  that copies that kind. So every way a file arrives is covered: receipts, payslips, statements, business files and restores. It
  then schedules the system job `storage.mirror`, which wakes the worker through NOTIFY. Exports aren't files people uploaded, and
  are never copied this way.
- **The job** (`StorageMirrorJobs`) reads which connections have work due through a definer function, then works through each
  connection under an owner's RLS context:
  - It claims a batch with `for update skip locked` and a 10-minute lease, so two workers never copy the same file, and a crash
    only delays one.
  - It reads Montra's copy, writes it, and marks the row `done`.
  - It stops after 2 minutes and reschedules itself. When nothing is due, it schedules itself for the earliest next attempt.
  - The worker also schedules it at start-up, so nothing waits for a new upload.
- **Retries** back off at 1 minute, 5 minutes, 15 minutes, 1 hour, 3 hours, 6 hours, 12 hours, then daily. After 10 attempts (about
  4 days) a row is `failed` and stays that way until the owner presses "Try again". A file in the trash when its turn comes is
  `skipped`, and goes back to `pending` if it's restored.
- **Backfill.** Connecting asks "Also copy the N files already in Montra" (on by default). "Copy existing files" does the same later.
  Both add `pending` rows for every file not in the trash, and skip files that already have a row.
- **Status the owner sees:** the last copy that worked, the last error and when, and counts of pending, copied and failed files.
  The connection's own state is `active`, `paused` (by the owner), or `failing` (5 failures in a row with no success between).
  Changing to `failing` sends one notification to each owner (`storage_failing`), with no file names in it. A success puts it back
  to `active`.
- **Which kinds** are copied is per connection: statements, receipts, payslips, invoices, leases and other. All are on by default.

### 6. Deletion: your copy is yours

- **Trash** never touches the copy, and restoring from the trash changes nothing there either.
- **Deleted for good** (30 days after the trash, or at a retention date): Montra **keeps** the copy by default.
  The owner's storage is their archive.
  - The connection has a switch, "Also delete my copy when Montra deletes a file for good" (`delete_with_montra`, off by default).
  - When it's on, a trigger on deleting from `app.file` turns a copied row into `delete` instead of removing it, and the job deletes
    the copy, then the row.
  - A row with nothing copied yet is simply removed.
- **Disconnecting** removes the connection, its sealed secret and its rows. It never deletes anything in the owner's storage.
- **A purged workspace** (account deletion, ADR-0019 §12) loses its connection and secret along with everything else. Copies stay:
  Montra no longer holds the means to reach them, and they were the owner's to keep.
- **Old backups.** "Keep the last N backups" (`keep_backups`, default 12; 0 keeps all) is the one place Montra deletes without the
  switch, and only files it wrote to `backups/`. It's off when the test found that Montra can't delete.

### 7. Backups to your storage

- **"Back up now"** gets "Also save a copy to <storage>" (`saveToStorage`), on by default when a connection exists. The archive is
  made exactly as before. It's still downloadable from Montra for 7 days.
- **A scheduled backup** gets a destination: `email_link` (as before) or `storage`.
  - With `storage`, the notification says the backup was saved there, or that saving it failed, rather than linking to a download.
    The download still exists for 7 days either way.
  - A schedule can have a **password** now. Montra derives the key in the request (scrypt, ADR-0019 §8) and keeps only the key,
    wrapped by the KMS port, plus the KDF parameters, in `backup_schedule`. It never keeps the password. Every scheduled archive is
    then a `.montra` file that only that password opens. Changing or removing the password replaces the wrapped key. A forgotten
    password still can't be recovered.
- **Copying the archive** uses the same job and retries as files. `export_job` records where it went and how that went:
  `destination_id`, `destination_status` (`pending`, `done`, `failed`, `pruned`), `destination_path`, `destination_error`.
  - The archive is read from Montra's copy, so retries work until that copy expires after 7 days. The row is then `failed`.
  - Archives are streamed from a temporary file. A single PUT (up to 5 GB) is enough for today's sizes; restore uploads are capped at
    1 GB (ADR-0019).
- **Encryption on the way and at rest.** Copies travel over HTTPS (required in production). Files are copied as Montra holds them.
  A backup is encrypted only when it has a password. Encrypting every copy under a Montra-held key was rejected: a copy you can't
  open without Montra isn't yours.

### 8. Quota and costs

- Copies don't count against `workspace.storage_quota_bytes` (BAK-08). They're on the owner's storage, and Montra's copy is already
  counted.
- Copying costs Montra egress bandwidth: about the size of each file once, plus backups. That's small next to what's stored.

## Consequences

- Each new table is excluded from archives with a reason (catalog test): a connection holds a secret, and copy state belongs to a
  connection that a restore can't bring back.
- A copy can lag by minutes, or by days when the storage is down. The status says so.
- Owners can end up with copies of files Montra has since deleted. That's the default they asked for.
- BAK-05 gains the owner's own S3-compatible or WebDAV storage beside the emailed link, but stays partial: the requirement names
  Google Drive, OneDrive and Dropbox, which wait for app registration (§2), and iCloud, which has no server API.
- The private-address check stops a NAS that's only reachable inside a home network, unless Montra is self-hosted with
  `STORAGE_DESTINATIONS_PRIVATE=true`.

## Alternatives considered

- **Move files instead of mirroring**: see §1.
- **Copying in the upload request**: it makes every upload as slow and as fragile as the slowest storage. The outbox makes it
  neither.
- **One job per file**: thousands of jobs for a backfill, and no natural place for a per-connection status. One sweep per connection
  is simpler and reports better.
- **Rclone as a sidecar**: it covers every provider, but it's another process with credentials on disk, and its errors are hard to
  show to a person.
- **Deleting copies with Montra's files by default**: makes someone's archive shrink without them doing anything. Rejected by the
  owner in favour of the switch.
