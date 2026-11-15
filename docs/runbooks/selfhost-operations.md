# Self-hosted operations: updates, power, disks, keys

Running Montra on your own server day to day ([ADR-0050](../design/adr/0050-hosting-anywhere.md) §5–6). Setting it up
is in [self-hosted setup](selfhost-setup.md). Commands run in `/srv/montra/infra/selfhost` as the `montra` user.

Own servers mean owning what a cloud did: patching, disks, power, the network, monitoring and backups. This page is
those jobs.

## 1. Releasing a new version

**From GitHub:** push a tag, or run `deploy.yml` by hand for the environment (see [deploy](deploy.md#which-tag-goes-where)
for which tag goes where). With `DEPLOY_TARGET=selfhost` it builds the images, pushes them to GHCR, copies
`infra/selfhost` to the server and runs `deploy.sh <tag>`.

**By hand on the server**, with a tag that's already in GHCR:

```bash
./deploy.sh <tag>
```

What it does, in order:

1. Pulls the images for the tag.
2. Runs Kratos's migrations, then the ledger's as `montra_owner`, each in a one-off container, **before any new code
   starts**. Migrations stay backward compatible ([deploy](deploy.md#migrations-expand-and-contract-ops-04)), so the
   running version keeps working on the new schema.
3. Replaces Kratos, its courier and the auth gateway, then the job worker and the doc worker. A worker gets 120 seconds
   to finish its job, and a job that doesn't finish is requeued.
4. Replaces `api-a`, waits for it to be healthy, then `api-b`. Caddy checks both every 5 seconds and sends traffic to
   the healthy one.
5. Replaces `web`. Caddy holds requests for up to 30 seconds while it restarts, so a page load may pause but not fail.
6. Brings up anything else (Caddy, cloudflared) and reloads Caddy's configuration.
7. Writes the tag into `.env` as `MONTRA_TAG`, only once all of that worked.

It stops at the first failure and leaves `.env` on the last good tag.

### Going back

```bash
./deploy.sh <previous tag>      # deploy.sh prints it at the end of each run
```

That reruns migrations, which do nothing when they have already run. The previous code works on the current schema
because of expand and contract. Kratos's own migrations aren't expand and contract: before going back over a Kratos
upgrade, read [deploy → Rollback](deploy.md#rollback).

### Checking a release

```bash
docker compose ps                          # every service "running", health "healthy" where it has a check
docker compose logs --since 10m api-a api-b worker
curl -fsS https://api.<domain>/readyz
```

## 2. Patching

- **The OS:** `unattended-upgrades` installs security updates daily. A kernel update needs a reboot. Pick a quiet time
  monthly: `sudo reboot`. Docker restarts the stack itself; if the disks are encrypted with a passphrase, someone has to
  type it.
- **Docker:** updated by apt with the rest. Check `docker compose version` stays at 2.24 or newer.
- **Montra's images** are rebuilt on each release, and their base images are pinned by digest. The monthly round in
  [security patching](security-patching.md) raises them.
- **Caddy, cloudflared and Postgres** are pinned by version and digest in `compose.yaml`. Raise them in a PR, like the
  other digests. A Postgres minor version (16.x) is a drop-in; a major version (17) is an upgrade with `pg_upgrade` or
  a dump and restore, planned separately.

## 3. A power cut

With the UPS and NUT set up ([setup §2](selfhost-setup.md#2-the-machine)), the server shuts down cleanly when the battery
runs low, and starts again when power returns ("restore on AC power loss").

After the power returns:

1. If the disks are encrypted with a passphrase, unlock them at the console.
2. Check everything came back: `docker compose ps`. Postgres replays its log on start; the API waits for it.
3. Look for a failed sync in the mirror: `cat /proc/mdstat` (mdadm resyncs by itself) or `zpool status`.
4. If the server went down **without** a clean shutdown (the UPS failed, or there isn't one), Postgres still recovers
   from its write-ahead log; check its log for errors: `docker compose logs postgres | tail -50`. If it won't start,
   restore from backups ([disaster recovery](disaster-recovery.md)).

While the server is off, Montra is down for everyone. The phone app keeps working offline and syncs when it's back.

## 4. A failing disk

smartd or mdadm emails you (setup §2). Then:

1. **Find which disk:** `cat /proc/mdstat`, `sudo mdadm --detail /dev/md0` (or `zpool status`), and
   `sudo smartctl -a /dev/sdX` for its serial number.
2. **Check the backups are current** before touching anything (step 3 of ADR-0050 sets them up).
3. **Replace it.** mdadm: `sudo mdadm /dev/md0 --fail /dev/sdX1 --remove /dev/sdX1`, shut down, swap the disk, copy the
   partition table from the good disk (`sudo sfdisk -d /dev/sdY | sudo sfdisk /dev/sdX`), then
   `sudo mdadm /dev/md0 --add /dev/sdX1`, and reinstall the boot loader on it. ZFS: `zpool replace`.
4. **Wait for the resync** (`watch cat /proc/mdstat`) before anything else risky.

Montra keeps running on the remaining disk throughout. If both disks fail, or the server is lost, restore onto a new
one from backups ([disaster recovery](disaster-recovery.md)).

## 5. Health and logs

- `docker compose ps` shows each service's health. Health checks: the API's `/readyz`, web's `/`, the auth gateway's
  (which asks Kratos), Kratos's own `/health/ready`, cloudflared's `ready`, Postgres's `pg_isready`.
- Logs: `docker compose logs -f <service>`. They're kept 5 × 10 MB per container.
- Metrics: the API serves Prometheus at `/internal/metrics` on the internal network only (Caddy refuses `/internal/*`
  from outside), with the token in `secrets/metrics_token`. Alerts come with step 3 of ADR-0050.
- An outside uptime check (for example a free UptimeRobot or Better Stack monitor on `https://api.<domain>/readyz`)
  tells you when the whole server is down, which nothing on the server can.

## 6. Rotating secrets

Each secret is a file in `secrets/`. To change one, write the new value, then restart what reads it:

```bash
sudoedit secrets/<name>
docker compose up -d --force-recreate --no-deps <services>
```

| Secret                                      | Restart                                          | Notes                                                        |
| ------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------ |
| `s3_access_key`, `s3_secret_key`            | `api-a api-b worker doc-worker`                  | Make the new key first, then delete the old one              |
| `mail_url`                                  | `api-a api-b worker auth-gateway`                |                                                              |
| `kratos_smtp_url`                           | `kratos kratos-courier`                          |                                                              |
| `kratos_webhook_secret`                     | `kratos kratos-courier api-a api-b worker`       | Webhooks fail between the two restarts: do it quickly        |
| `kratos_cookie_secret`                      | `kratos kratos-courier`                          | Signs everyone out                                           |
| `kratos_cipher_secret`                      | Don't: Kratos can't read what it encrypted before |                                                              |
| `auth_gateway_secret`                       | `auth-gateway`                                   | Resets the attempt counters                                  |
| `metrics_token`                             | `api-a api-b`, and Prometheus                    |                                                              |
| A database role's password                  | the services using that URL                      | `alter role … password` in psql first, then the URL file     |
| `cloudflare_tunnel_token`                   | `cloudflared`                                    | After rotating it in the Cloudflare dashboard                |
| `master_key`                                | Not by editing the file                          | It's a move: [key wrapping §3](key-wrapping.md#3-moving-to-another-mode-or-a-new-local-key) |

After any change, update the offline copy of `secrets/`.

## 7. Restoring

Until step 3 of ADR-0050 (continuous backups), the database is backed up with `pg_dump`. A nightly cron entry, as the
`montra` user, that keeps 14 days on the server and copies them off it:

```bash
docker compose exec -T postgres pg_dump -U postgres -Fc montra > /srv/montra/backups/montra-$(date +%F).dump
```

To restore one into a fresh stack: start Postgres alone, run `./setup.sh init`'s role step, then
`pg_restore -U postgres -d montra --no-owner --role=montra_owner`, and run `infra/db/reconciliation-checks.sql` as in
the [restore drill](restore-drill.md). Restoring needs the `master_key` the backup was made with.

## 8. What was tested

| What                                                                                                         | Result    |
| ------------------------------------------------------------------------------------------------------------ | --------- |
| `setup.sh secrets`, `check` and `init` from nothing, locally on Docker Desktop (images built from this repository, MinIO and Mailpit standing in, no tunnel) | Every service healthy; roles, Kratos and ledger migrations applied |
| Through Caddy: `app.`, `api.` and `auth.`; `/internal/metrics` from outside                                   | Answer; 404 |
| A sign-up through the auth gateway                                                                            | Session made, confirmation email sent |
| A second `deploy.sh` that replaced both API replicas, with `/readyz` called every 0.2 s through Caddy        | 382 of 382 answered |
| A real server, a power cut, a disk swap, rotating each secret                                                | Not tried |
