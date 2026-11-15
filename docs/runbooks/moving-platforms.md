# Moving platforms

How to move Montra from one place to another: from the server at home to a VPS when real customers come
([ADR-0050](../design/adr/0050-hosting-anywhere.md) §11), from a VPS to AWS, or from any of them to another provider. The
order is ADR-0050 §10. The application doesn't change: the same four images, the same settings, the same database.

> **Never done for real.** §3 and §5's database steps were rehearsed locally between two Postgres 16 containers (see the
> end); the rest uses tools tried elsewhere in these runbooks. Rehearse the whole move once against a copy (the
> [restore drill](selfhost-restore-drill.md) makes one) before the real move, and correct this page.

## What moves, and what may not have to

| Part                   | From home to a VPS                                   | To AWS or another cloud                                   |
| ---------------------- | ---------------------------------------------------- | --------------------------------------------------------- |
| Images                 | Nothing: the same GHCR images                        | Nothing, or copied to the cloud's registry                |
| Settings and secrets   | `.env` and `secrets/` copied over                    | Into the cloud's secret store                             |
| Files                  | Nothing: the bucket is already off the server        | Only if the files move to the cloud's own storage (§2)    |
| The database           | Replicated (§3)                                      | Replicated (§3)                                           |
| The master key         | The key file copied over                             | Moved into the cloud's KMS (§4)                           |
| Identity (Kratos)      | Its database, with the ledger's                      | The same                                                  |
| The way in             | The tunnel, or DNS straight to the VPS               | DNS in Cloudflare                                         |
| Backups                | A new pgBackRest stanza on the new server            | The cloud's backups, or the same tools (ADR-0050 §7)      |

Plan for **an hour of the service paused** at the switch (§5), most of it checking. People's phones keep working
offline and sync afterwards. Tell everyone the day before.

## 1. Build the new target

- **A VPS:** follow [self-hosted setup](selfhost-setup.md) on it, with `compose.direct.yaml` (§8 there) and the **same**
  `.env` and `secrets/` as the old server: copy them over (`scp -r`, then fix owners and modes with `./setup.sh check`).
  Then run only the first part of `./setup.sh init`: start Postgres and create the roles. **Don't run `deploy.sh`
  yet**, as that would create the schema the replication brings over (§3).
- **AWS:** `infra/terraform` and [first-time setup](first-time-setup.md), up to but not including the first migration.
- **Elsewhere:** a folder of its own built against ADR-0050 §1, with the same images.

Check the new target can reach the old database privately (§3), the files bucket and the mail server.

## 2. Files

At home and on a VPS, files are already in a hosted bucket (ADR-0050 §4): point the new target at the same bucket, and
skip this.

To move them to another bucket (for example into S3 on AWS):

```bash
# the same RCLONE_CONFIG_SRC_* / DST_* variables as backup.sh files, with DST the new bucket
rclone sync src:<old bucket> dst:<new bucket> --checksum --fast-list
```

Run it again daily until the switch; each run copies only what changed. The last run is in §5, after the old writers
have stopped.

## 3. The database: logical replication

Logical replication copies every table while the old server keeps running, and keeps copying changes, so the switch is
minutes, not a dump and restore. It needs:

- **A private link** from the new database to the old one. The home server has no open port: put both servers on a
  WireGuard or Tailscale network, and publish the old Postgres on that address only, in a `compose.override.yaml` on
  the old server: `services: { postgres: { ports: ['<tailnet ip>:5432:5432'] } }`.
- **`wal_level=logical`** on the old server: add `command: ['postgres', '-c', 'wal_level=logical']` to the same
  override and restart Postgres (`docker compose up -d postgres`, a few seconds' pause). The WAL archiving the image adds
  is kept.
- **A replication login** on the old server, and the tables' owner on the new one able to subscribe:

```sql
-- old server, as postgres (psql -U postgres -d montra). The tables force row level security, so the initial copy
-- needs a role that bypasses it; it can read everything, so drop it at the end (§6).
create role montra_replicator login replication bypassrls password '<generated>';
grant usage on schema app, ref, public to montra_replicator;
grant select on all tables in schema app, ref, public to montra_replicator;
create publication montra_move for all tables;
\c kratos
grant select on all tables in schema public to montra_replicator;
create publication kratos_move for all tables;
```

The new server connects as `postgres` for the schema below, so give its `pg_dump` the old password in `PGPASSWORD`.

```sql
-- new server, as postgres: montra_owner owns every table and bypasses row level security, so it applies the rows
grant pg_create_subscription to montra_owner;
```

**The schema comes from the old database, not from migrations**, so the two are identical (including
`schema_migrations`):

```bash
# on the new server
docker compose exec -T postgres pg_dump -h <old tailnet ip> -U postgres --schema-only montra \
  | docker compose exec -T postgres psql -U postgres -d montra -v ON_ERROR_STOP=1
docker compose exec -T postgres pg_dump -h <old tailnet ip> -U postgres --schema-only kratos \
  | docker compose exec -T postgres psql -U postgres -d kratos -v ON_ERROR_STOP=1
```

Then subscribe. The first copy runs in the background; triggers don't fire for replicated rows, so the ledger's checks
and the audit log aren't run twice:

```sql
-- new server, montra database, as montra_owner
create subscription montra_move
  connection 'host=<old tailnet ip> dbname=montra user=montra_replicator password=<generated>'
  publication montra_move;
-- kratos database, as montra_kratos after `grant pg_create_subscription to montra_kratos`
create subscription kratos_move
  connection 'host=<old tailnet ip> dbname=kratos user=montra_replicator password=<generated>'
  publication kratos_move;
```

Watch it catch up: on the new server `select * from pg_stat_subscription` (and `pg_subscription_rel`, every table
`r` for ready); on the old one, `pg_stat_replication`. Every table has a primary key, which logical replication needs to
apply updates and deletes.

**Don't release a migration while replicating.** Schema changes aren't replicated. Hold releases from §1 to §5.

**A small database** can skip replication: stop the old writers (§5 step 1), take a full backup there
(`sudo ./backup.sh db full`), and restore it on the new server as in the
[restore drill](selfhost-restore-drill.md) with `BACKUP_ARCHIVE=off`, then turn archiving on and take a new full backup.
The pause is then the restore's length, which for a family-sized database is minutes too.

## 4. The master key

Every workspace's data key is wrapped by the master key ([key wrapping](key-wrapping.md)). Either:

- **Keep the same mode:** copy `secrets/master_key` to the new server (owner uid 1000, mode 0400). Nothing else
  changes. This is the move from home to a VPS.
- **Move to another mode** (a cloud KMS, or Vault): [key wrapping §3](key-wrapping.md#3-moving-to-another-mode-or-a-new-local-key).
  Where the new platform can't hold a key file (ECS gives secrets as variables, and production refuses `MASTER_KEY`
  as a variable), **do the move on the old platform before the switch**: give the old services `KMS_MODE=aws` (or
  `vault`) with `KMS_PREVIOUS_MODE=local` and credentials for the new KMS, run `crypto rewrap`, and the rewrapped keys
  replicate across like any other row. Check with `crypto check` on both sides.

## 5. The switch

1. **Stop the old writers.** On the old server: `docker compose stop caddy cloudflared web api-a api-b worker
   doc-worker auth-gateway kratos kratos-courier`. Postgres keeps running. From here the service is paused.
2. **Let replication finish:** on the old server, `select pg_current_wal_lsn()`; on the new, wait until
   `select latest_end_lsn from pg_stat_subscription` has passed it, for both subscriptions.
3. **Carry the sequences across** (logical replication doesn't): on the old server

   ```sql
   select format('select setval(%L, %s, true);', schemaname || '.' || sequencename, last_value)
     from pg_sequences where schemaname in ('app', 'ref', 'public') and last_value is not null;
   ```

   and run its output on the new server, in each database (`montra`, then `kratos`).
4. **Detach:** on the new server, `drop subscription montra_move;` and `drop subscription kratos_move;`.
5. **Files:** the last `rclone sync` (§2), if they move.
6. **Start the new target:** `./deploy.sh <the same tag as the old server> <postgres tag>`. Its migrations find
   everything already applied.
7. **Point the names at it.** Through the tunnel: in Cloudflare Zero Trust, move the three public hostnames to a tunnel
   running on the new server, or turn the tunnel off and point the DNS records at the VPS (proxied). Without a tunnel:
   change the three DNS records in Cloudflare; with the proxy on, it takes effect within a minute.
8. **Check** (§6), then tell everyone it's back.

**Going back** before step 6 is starting the old services again: nothing has written to the new database. After people
have used the new one, going back means replicating the other way first. Decide during §6, not later.

## 6. Check, and keep the old one for 30 days

- `docker compose ps` on the new target: every service healthy.
- The reconciliation checks on the new database must return no rows:
  `docker compose exec -T postgres psql -U postgres -d montra -v ON_ERROR_STOP=1 -f - < ../db/reconciliation-checks.sql`
- `docker compose run --rm crypto check`: every key unwraps.
- Row counts match the old database (the query in the [restore drill](selfhost-restore-drill.md) step 4).
- Sign in, open a transaction with a memo and a receipt, upload a statement, and receive an email.
- **Backups on the new server:** `sudo ./backup.sh init` with its own backup bucket path (a new `repo1-path` or bucket),
  then `./setup.sh cron`. The first full backup is the new starting point.

Then **keep the old server read-only for 30 days**: stop everything but Postgres, remove the publication link, and

```sql
drop publication montra_move;            -- in montra; kratos_move in kratos
drop role montra_replicator;
alter database montra set default_transaction_read_only = on;
alter database kratos set default_transaction_read_only = on;
```

and take the override that published its Postgres away.

Keep its backups and its offline secrets for as long as its backups are retained. After 30 days without needing it,
destroy the old server's data (wipe the disks, or have the provider do it), and retire its keys
([key wrapping §3, step 6](key-wrapping.md#3-moving-to-another-mode-or-a-new-local-key)).

## Checklist

- [ ] The new target built; `.env` and `secrets/` there; it reaches the old database privately
- [ ] Replication running for `montra` and `kratos`, every table ready; no releases meanwhile
- [ ] Files copied (if they move)
- [ ] The master key moved (same mode) or rewrapped (new mode), `crypto check` passes
- [ ] Everyone told about the pause
- [ ] The switch: writers stopped, caught up, sequences, subscriptions dropped, new target started, names moved
- [ ] Checks pass; backups running on the new server
- [ ] Old server read-only; destroyed after 30 days

## What was rehearsed

On 2026-11-14, locally, between two `postgres:16.11` containers, each with `infra/db/production-roles.sql` run:

| Step                                                                                           | Result                     |
| ---------------------------------------------------------------------------------------------- | -------------------------- |
| The schema from the old database with `pg_dump --schema-only`, into the new one                | Works                      |
| A publication for all tables; a subscription owned by `montra_owner` with `pg_create_subscription` | Every table ready      |
| Without `usage` on schema `public` for the replication login, `schema_migrations` never copies (`permission denied for schema public`) | Fixed above |
| A change on the old database while replicating arrives on the new one                          | Works                      |
| The sequences carried across with the `setval` script; the subscription dropped                | Both identity sequences match |
| Row counts in all 149 tables of `app`, `ref` and `public`                                     | Equal                      |
| `infra/db/reconciliation-checks.sql` on the new database                                       | No rows                    |

The data was a test database (one workspace, a few postings), not a real one: it says the steps work, not how long they
take. Kratos's database, the tunnel, the files and the key were not part of it.
