# Self-hosted restore drill

**Every quarter** (BAK-07), for Montra on its own server ([ADR-0050](../design/adr/0050-hosting-anywhere.md) §7). The
self-hosted version of the [restore drill](restore-drill.md): it restores the database from pgBackRest and the files
from the backup bucket onto a **scratch server**, and runs the same reconciliation checks. A backup nobody has restored
is only a hope.

| Calendar  | Owner | Last run | Result |
| --------- | ----- | -------- | ------ |
| Quarterly | TBD   | Never    | None   |

> **Tried locally once** (see the end): a restore into a second Compose project on the same machine, from MinIO. Never
> on a scratch server from a real bucket.

## Rules

- **A scratch server, not the real one.** A spare machine, or a VPS rented for the afternoon. It needs Docker and the
  [setup](selfhost-setup.md) steps 3 and 7, nothing else. No tunnel, no published ports.
- **The drill never writes to the real backup bucket.** It runs with `BACKUP_ARCHIVE=off`, and uses a **read-only key**
  to the backup bucket made for the drill (B2 and R2 can both scope a key to read only).
- This is real people's data: the same care as the real server. Destroy it at the end.
- The drill sends no email: it never starts `worker`, `kratos-courier` or `auth-gateway`.

## Before

- [ ] A read-only key for the database backup bucket, and one for the files backup bucket.
- [ ] From the offline copy: `master_key`, `backup_cipher_pass` and the database URLs (`secrets/`). This also tests that
      the offline copy is complete and current.
- [ ] Note the start time. RTO is measured from here.

## Steps

All commands run in `infra/selfhost` on the scratch server.

**1. Settings.** Copy `.env` from the real server (or `montra.env.example`, filled in the same way), and change:

```bash
COMPOSE_PROJECT_NAME=montra-drill
COMPOSE_PROFILES=
BACKUP_ARCHIVE=off
S3_BUCKET=<the files *backup* bucket>      # the app reads files from the copy
S3_ENDPOINT=<its endpoint>
```

Put the secrets from the offline copy in `secrets/`, replacing the bucket keys with the read-only drill keys:
`backup_s3_*` for the database backups, `s3_*` for the files copy. `./setup.sh check` should pass, apart from the machine
warnings.

**2. Restore the database.** Pick the point to restore to: the latest (`--type=default`, leave out `--target`), or a
moment to prove point-in-time recovery, alternating each quarter:

```bash
docker compose run --rm postgres pgbackrest --stanza=montra info          # the backups there, newest last
docker compose run --rm postgres pgbackrest --stanza=montra restore \
  --type=time --target="2026-11-14 09:30:00+00" --target-action=promote
docker compose up -d --wait postgres                                      # replays the WAL up to the target
```

`run` starts the container from the Postgres image's entrypoint, which writes pgBackRest's settings from the secrets and
runs pgBackRest as `postgres` into this project's own empty volume. Note the time it takes.

**3. Run the reconciliation checks.** Every query must return no rows.

```bash
docker compose exec -T postgres psql -U postgres -d montra -v ON_ERROR_STOP=1 -f - < ../db/reconciliation-checks.sql
docker compose exec -T postgres psql -U postgres -d montra -c 'select * from app.reconcile_books()'
```

**4. Compare.** Row counts should match the real database at the restore point:

```sql
select 'journal_entry' as t, count(*) from app.journal_entry
union all select 'posting', count(*) from app.posting
union all select 'workspace', count(*) from app.workspace;
```

**5. Check the keys and the app.** Every stored key must unwrap with the master key from the offline copy:

```bash
docker compose run --rm crypto check          # "Every key unwraps." and exit 0
docker compose up -d --wait kratos api-a
docker compose exec api-a node -e "fetch('http://127.0.0.1:4000/readyz').then(r=>r.text()).then(console.log)"
```

If any key doesn't unwrap, the backup and the offline copy aren't a full backup: what those keys protect (memos,
account numbers, sealed files) can't be read. Optionally, sign in through an `ssh -L` tunnel to the scratch server and
open a receipt.

**6. Check the files copy.** From the real server, compare the files bucket with its backup:

```bash
docker run --rm -e … rclone/rclone check src:<files bucket> dst:<backup bucket> --one-way --size-only
```

(the same `RCLONE_CONFIG_*` variables as `backup.sh files`). Then delete a test object in the backup bucket and bring
back its previous version, to prove the 30-day versions are there.

**7. Confirm the lock.** With the real backup key (not the drill's), try to delete one object under `montra/backup/` in
the database backup bucket. It must be refused while within the lock period.

**8. Note the end time, and destroy everything:**

```bash
docker compose down -v          # removes montra-drill's volumes, including the restored database
sudo rm -rf secrets .env
```

Revoke the two drill keys at the providers.

## Pass or fail

| Check                                   | Target                                     | Result |
| --------------------------------------- | ------------------------------------------ | ------ |
| Time from start to reconciled           | Under 4 hours                              |        |
| Restore point reached                   | Within a minute or two of the target       |        |
| Newest backup's age at the drill        | Under 26 hours, WAL to within minutes      |        |
| Reconciliation checks                   | No rows                                    |        |
| Encrypted columns and receipts readable | Yes                                        |        |
| Files copy matches                      | `rclone check` finds no differences        |        |
| A locked backup can't be deleted        | Refused                                    |        |
| Offline copy of `secrets/` was enough   | Yes                                        |        |
| Everything destroyed, drill keys revoked | Yes                                       |        |

## After

- [ ] Record the date and results in the table at the top, and keep the output.
- [ ] A failed drill is a Sev-2: fix it before anything else.
- [ ] Update [self-hosted backups](selfhost-backups.md) with what you found.

## Tried locally

On 2026-11-14, on Docker Desktop: a second Compose project (`-p montra-drill`, `BACKUP_ARCHIVE=off`) restored from
MinIO with object lock, standing in for the backup bucket.

| Check                                                         | Result                                    |
| ------------------------------------------------------------- | ----------------------------------------- |
| `pgbackrest restore` into the drill's empty volume             | Completed in 17 s (a 49 MB database)      |
| A row written after the full backup                           | Back, so the WAL replayed                 |
| `archive_mode` in the drill                                   | `off`                                     |
| Reconciliation checks                                         | No rows                                   |
| `schema_migrations` against the original                      | 55 and 55                                 |
| `crypto check`                                                | Runs; the test stack had no workspace keys |

Not done there: a scratch server, read-only keys, the files copy check, a point-in-time target.
