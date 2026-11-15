# Self-hosted backups and alerts

Backups and alerts for Montra on its own server, none of them tied to one cloud
([ADR-0050](../design/adr/0050-hosting-anywhere.md) §7–8). Setting up the server is in
[self-hosted setup](selfhost-setup.md); proving the backups work is the
[self-hosted restore drill](selfhost-restore-drill.md).

| What                  | How                                                                                  | Where it goes                         | Recovery point |
| --------------------- | ------------------------------------------------------------------------------------ | ------------------------------------- | -------------- |
| The database          | pgBackRest in the Postgres container: WAL archived every 60 s, a weekly full and daily differential backups | A bucket at another provider, with object lock, encrypted before it leaves | About a minute |
| Files                 | `rclone sync` of the files bucket, nightly                                           | A bucket at a second provider, keeping old versions for 30 days | A day          |
| The master key and `secrets/` | By hand, offline                                                             | A password manager and a printed or USB copy | When they change |
| Alerts                | Prometheus, Alertmanager and node-exporter (profile `monitoring`)                    | Email to you                          |                |

> **Tried locally only.** pgBackRest, the stanza, a full backup and a restore into a second stack were run on Docker
> Desktop against MinIO with object lock (see §7). No real B2 or R2 bucket, and no real email from Alertmanager.

**Decide retention first.** `docs/STATUS.md` still has BAK-01 or BAK-09 open: monthly copies kept a year conflict with
deleted data ageing out within 35 days. The defaults here keep about five weeks (four weekly fulls), which suits BAK-09.
Object lock makes the choice hard to undo, so settle it before turning lock on.

## 1. The buckets

Use a provider other than the one holding the files, so one account problem can't take both. Backblaze B2 and
Cloudflare R2 both work, and both support object lock.

1. **Database backups:** a private bucket, with **object lock** on (B2: "Object Lock" when creating the bucket; R2:
   bucket lock rules). Set a default retention of **14 days**, in compliance mode where the provider offers a choice.
   Then nobody who gets hold of the key, or the server, can destroy the last two weeks of backups. Keep it shorter than
   pgBackRest's own retention (about five weeks): pgBackRest deletes expired backups, and a longer lock would make
   those deletes fail.
2. **Files backup:** a private bucket with **versioning** on and a lifecycle rule that deletes noncurrent versions after
   **30 days**. Object lock is optional here.
3. One access key per bucket, scoped to that bucket alone, with read, write and delete (pgBackRest expires old backups;
   rclone deletes files that were deleted).

## 2. Settings

In `.env`:

```bash
BACKUP_S3_ENDPOINT=https://s3.us-west-004.backblazeb2.com     # the backup bucket's S3 endpoint
BACKUP_S3_BUCKET=montra-db-backups
BACKUP_S3_REGION=us-west-004
FILES_BACKUP_S3_ENDPOINT=https://<account>.r2.cloudflarestorage.com
FILES_BACKUP_S3_BUCKET=montra-files-backup
FILES_BACKUP_S3_REGION=auto
```

`./setup.sh secrets` generates `backup_cipher_pass`, the passphrase pgBackRest encrypts with, and makes empty files for
the keys. Fill in `backup_s3_access_key`, `backup_s3_secret_key`, `files_backup_access_key` and
`files_backup_secret_key` with `sudoedit`.

**Back up `backup_cipher_pass` offline, with the master key.** Without it the database backups can't be read; without
the master key, what they hold can't be read. Keep both apart from the backups themselves.

Restart Postgres so it starts archiving (`docker compose up -d postgres`), then create pgBackRest's stanza and the first
full backup:

```bash
sudo ./backup.sh init
```

## 3. The schedule

`./setup.sh cron` writes `/etc/cron.d/montra` (run as root, because the scripts read `secrets/`):

| When                    | What                    |
| ----------------------- | ----------------------- |
| Sundays 02:15           | `backup.sh db full`     |
| Monday to Saturday 02:15 | `backup.sh db diff`    |
| Daily 03:45             | `backup.sh files`       |
| Every 5 minutes         | `backup.sh status`      |

Output goes to `/var/log/montra-backup.log`. The WAL is archived continuously by Postgres itself, whatever cron does.

`backup.sh status` reads `pgbackrest info` and `pg_stat_archiver` and writes the ages into
`infra/selfhost/metrics/montra_backup.prom` for node-exporter. It needs `jq` on the server (`sudo apt install jq`).

## 4. Alerts

```bash
cp ../observability/alertmanager/alertmanager.example.yml alertmanager.yml   # then fill in the addresses
sudoedit secrets/alert_smtp_password
# add monitoring to COMPOSE_PROFILES in .env, e.g. COMPOSE_PROFILES=tunnel,monitoring
docker compose up -d
```

That starts Prometheus (30 days of data), Alertmanager and node-exporter, on the internal network only. The rules are
`infra/observability/prometheus/rules`: the SLO alerts from Phase 11, plus `selfhost.yml`:

| Alert                     | When                                                            | Severity |
| ------------------------- | --------------------------------------------------------------- | -------- |
| `BackupStatusMissing`     | `backup.sh status` hasn't reported for 30 minutes, or ever      | page     |
| `DatabaseBackupStale`     | No full or differential backup in 26 hours                      | page     |
| `DatabaseFullBackupStale` | No full backup in 8 days                                        | ticket   |
| `WalArchiveFailing`       | The last WAL archive attempt failed, and none has worked since  | page     |
| `FilesBackupStale`        | The files bucket wasn't copied in 26 hours                      | ticket   |
| `ScrapeTargetDown`        | An API replica or node-exporter unreachable for 5 minutes       | page     |
| `DiskMirrorDegraded`      | The RAID mirror lost a disk                                     | page     |
| `DiskAlmostFull`, `DiskFillingUp` | Under 10% free, or full within a day at this rate      | page, ticket |
| `ClockNotSynchronized`    | NTP lost for 30 minutes                                         | ticket   |

Nothing on the server can say the server is down. Use an **outside uptime check** too
([operations §5](selfhost-operations.md#5-health-and-logs)). The UPS reports through NUT's own email (`NOTIFYCMD`).

To look at Prometheus: `ssh -L 9090:localhost:9090` won't work, as nothing is published; use
`docker compose exec prometheus wget -qO- 'localhost:9090/api/v1/alerts'`, or publish 9090 on `127.0.0.1` in a
`compose.override.yaml` and tunnel to it. Grafana Cloud's free tier can take the same rules and the dashboards in
`infra/observability/grafana` with a remote-write, if you'd rather have graphs.

## 5. When an alert fires

- **`WalArchiveFailing`:** `docker compose exec -u postgres postgres pgbackrest --stanza=montra check` says why. Usually
  the bucket's key, the network, or the bucket is full. The WAL waits on the server (up to 4 GB, then pgBackRest drops
  it to protect the disk, and point-in-time recovery has a gap until the next full backup). Once fixed, it catches up by
  itself; take a full backup if the queue overflowed.
- **`DatabaseBackupStale`:** `tail -50 /var/log/montra-backup.log`, then run `sudo ./backup.sh db diff` by hand.
- **`FilesBackupStale`:** run `sudo ./backup.sh files` and read rclone's error.
- **`BackupStatusMissing`:** cron isn't running the job: `systemctl status cron`, and check `/etc/cron.d/montra`.

## 6. On AWS

The AWS target keeps AWS Backup (ADR-0050 §7 leaves that to the move). These tools work there too; that's decided when
moving.

## 7. What was tested

| What                                                                                          | Result |
| --------------------------------------------------------------------------------------------- | ------ |
| `promtool check rules` and `test rules` for `selfhost.yml` (and the existing SLO rules)       | Pass   |
| `promtool check config` for `prometheus.selfhost.yml`; `amtool check-config` for the example  | Pass   |
| `shellcheck` on `backup.sh` and the Postgres entrypoint                                       | Pass   |
| The Postgres image with pgBackRest, the stanza, a full backup and `backup.sh status` against MinIO with object lock | See [STATUS](../STATUS.md) |
| A real bucket at B2 or R2, an email from Alertmanager, a month of cron                         | Not tried |
