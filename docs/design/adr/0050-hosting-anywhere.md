# ADR-0050: Hosting anywhere: own servers first, any cloud later

- Status: accepted (amends ADR-0020's infrastructure; AWS stays as one target)
- Date: 2026-11-14
- Accepted: 2026-11-14, with the owner's choice of where to start (§11)

## Context

The owner wants to start on their own servers and move to AWS, Azure, GCP or another provider later, whichever costs
least then. Phase 11's infrastructure is written only for AWS (`infra/terraform`, `infra/deploy`, `deploy.yml`), and
none of it has been applied.

The application itself is tied to AWS in only a few places:

| Part                | Today                                                                    | Tied to AWS?                        |
| ------------------- | ------------------------------------------------------------------------ | ----------------------------------- |
| Database            | PostgreSQL 16 with RLS; nothing Aurora-only                              | No                                  |
| Job queue           | Postgres (ADR-0011). Redis is in the dev compose file, but nothing uses it | No                                |
| Compute             | Four images: `api` (also the worker), `web`, `doc-worker`, `kratos`      | No; ECS is only how they're run     |
| Files               | `STORAGE_MODE=s3`: the S3 API with an endpoint, so MinIO works locally   | No, but Azure Blob isn't S3         |
| Key wrapping        | `KMS_MODE=aws` (AWS KMS) or `local` (a master key in `MASTER_KEY`)       | Yes, unless the key sits in the env |
| Secrets             | Secrets Manager, put into the environment by ECS                         | Only in how they arrive             |
| Email               | SMTP (SES in the Terraform)                                              | No                                  |
| Edge                | Cloudflare DNS, WAF and rate limits                                      | No                                  |
| Backups             | AWS Backup, with Vault Lock and copies to a second region and account   | Yes                                 |
| Alarms              | CloudWatch and SNS. Metrics are Prometheus (`/internal/metrics`)         | Alarms only                         |
| Deploy              | ECR, ECS and CodeDeploy, through `deploy.yml` with an AWS role           | Yes                                 |
| Errors, payments, AI, push, texts | Sentry, Stripe, Anthropic, Expo, Twilio (ADR-0049)         | No                                  |

So moving clouds means changing how Montra is run, not the application. This ADR makes that a rule, closes the three
gaps in the application (key wrapping, secrets and storage), and adds a target for running on the owner's own servers.

## Decision

### 1. What Montra needs, on any platform

Montra runs anywhere that provides:

- **containers** for the four images, the same images everywhere;
- **PostgreSQL 16** with `citext` and `pg_trgm`, and a superuser or a role that can create the three roles in
  `infra/db/production-roles.sql`;
- **S3-compatible object storage**;
- **an SMTP server** (in practice a sending service, see Consequences);
- **a way to put secrets** in environment variables or files.

All configuration is environment variables. The application never calls a cloud's own API for configuration or
discovery. The one exception is key wrapping (§3), and that has a non-cloud adapter.

### 2. Secrets from the environment or from files

- Every secret setting can also be given as `<NAME>_FILE`, a path to a file holding the value, as Docker and Kubernetes
  secrets provide them. The API, the doc-worker and Kratos's start-up read both. Setting both is an error, and an empty
  value counts as not set.
  - **The API** (`apps/api/src/secret-files.ts`) takes `_FILE` for every setting in `config.ts`, and its command-line
    tools for `DATABASE_ADMIN_URL`. The migration command in `@montra/db` does too.
  - **The doc-worker** (`montra_doc_worker/settings.py`) takes it for every setting it reads.
  - **Kratos's image** is distroless, with no shell for a script, so its entrypoint is a small Go program
    (`infra/kratos/entrypoint`). It turns `NAME_FILE` into `NAME` for the settings that can hold a secret (`DSN`,
    `SECRETS_*`, `COURIER_*`, `SELFSERVICE_*`, `OAUTH2_PROVIDER_*`), then runs `kratos` with the same arguments. Other
    `_FILE` variables are left alone: the base image's `SSL_CERT_FILE` is a path, not a secret.
  - `VAULT_TOKEN_FILE` is the one file read again on every use, so a token that a Vault Agent renews is picked up
    without a restart.
- Where the files come from is the platform's business:
  - on own servers, root-only files on an encrypted disk;
  - on AWS, Secrets Manager through ECS;
  - on Azure, Key Vault references;
  - on GCP, Secret Manager mounted as files.

### 3. Key wrapping: a port with several adapters

Workspace data keys are wrapped by a master key (design 03 §12). `KMS_MODE` gets two more modes:

- **`local`**, allowed in production. The master key comes from `MASTER_KEY_FILE`, not an environment variable, and
  start-up refuses a key file that others can read. The key is backed up separately from the database: a database
  backup and its key together are the whole of everyone's data.
- **`vault`**: the Transit engine of HashiCorp Vault or OpenBao. The master key never leaves Vault, as with AWS KMS,
  and Vault runs anywhere.
- **`aws`**, unchanged.
- **`gcp` and `azure`**, added when a move to one is decided. Each is one class behind the same two-method port.

Moving between modes is a command, `crypto:rewrap`. It unwraps each workspace's data key with the old adapter and wraps
it with the new one, in batches, and records progress so it can resume. Nothing else is re-encrypted, because the data
keys don't change.

How that works, as built:

- **While keys move, the service runs.** `KMS_MODE` is the new mode and `KMS_PREVIOUS_MODE` the old one. New keys are
  wrapped with the new mode, and a key the new mode can't unwrap is tried with the old one. The old local key is
  `PREVIOUS_MASTER_KEY_FILE`, or `MASTER_KEY_FILE` when moving away from local.
- **The stored keys are the record of progress.** A key the new mode already unwraps is skipped, so the command can be
  stopped and run again without a table of its own. Each new wrapping is checked to unwrap before it is written, and it
  is written only if the row hasn't changed since it was read.
- **Every wrapped key moves**, not only the workspaces': a backup schedule's key, a restore's key, and the key inside a
  queued backup job.
- **It runs as the database owner** (`DATABASE_ADMIN_URL`), because it reads every workspace's keys past row level
  security and `montra_app` can't update them.
- Moving within AWS KMS or within Vault isn't Montra's job: both rotate their own keys. Rotating a local key is a move
  from local to local, with the old key as `PREVIOUS_MASTER_KEY_FILE`.
- The steps are in `docs/runbooks/key-wrapping.md`.

### 4. Files: the S3 API is the contract

- Montra stores files through the S3 API with an endpoint. That covers AWS S3, Cloudflare R2, Backblaze B2, Wasabi,
  Google Cloud Storage (through HMAC keys), and self-run stores such as Garage, SeaweedFS or MinIO.
- **On own servers,** a hosted S3-compatible bucket is recommended over running a store. The durability comes without
  running it, and the files are off the server already.
- **Azure Blob** isn't S3-compatible. A move to Azure either keeps a bucket elsewhere, or adds an Azure adapter beside
  `s3` in the API and the doc-worker.
- **Encryption at rest is the bucket's.** Montra doesn't seal files itself; on AWS the bucket's default is SSE-KMS
  (`storage.ts`). The providers above all encrypt at rest by default. A bucket for Montra must be private, with an
  access key scoped to that bucket alone.

### 5. A target for own servers: Docker Compose

`infra/selfhost/` holds a production Compose stack for one server, with a second one optional:

- **Caddy** in front, with TLS certificates from Let's Encrypt, routing `app.`, `api.` and `auth.` to `web`, `api` and
  `kratos`.
- **The services:** `api` (two replicas), `worker`, `web`, `doc-worker`, `kratos` and its courier, with health checks
  and restart policies. Only Caddy's ports are published.
- **PostgreSQL 16** in a container on its own volume, or a managed database's URL instead.
- **Backups** (§7).
- **Optional:** Prometheus and Grafana, and Vault for `KMS_MODE=vault`.
- **Cloudflare** stays in front for DNS, WAF and rate limits. A Cloudflare Tunnel is supported, for servers that can't
  or shouldn't open inbound ports, and is the default for a server at home (§11).

It comes with an env file template and a setup script that checks the requirements in §1. Two runbooks go with it:
`selfhost-setup.md` and `selfhost-operations.md` (updates, restore and rotating keys).

### 6. Deploying: one build, a step per target

- `deploy.yml` builds the images once and pushes them to the **GitHub Container Registry**, which isn't tied to any
  cloud. A cloud target may copy them to its own registry.
- A deploy step per target, chosen per environment:
  - **`selfhost`:** over SSH, it runs the migrations as a one-off container, then pulls the images and replaces the API
    replicas one at a time behind Caddy, with health checks. The other services restart in turn.
  - **`aws`:** the existing ECS and CodeDeploy scripts.
- **Zero downtime** depends on migrations staying backward compatible (`check-migrations.mjs`, ADR-0020 §13), which
  doesn't change.

### 7. Backups that don't belong to one cloud

- **The database:** pgBackRest (or WAL-G) writes full and incremental backups and archives WAL every 60 seconds, to an
  S3-compatible bucket at another provider. Point-in-time recovery keeps the 5-minute RPO.
- **Immutable copies:** the backup bucket uses object lock (supported by S3, B2 and R2) in place of AWS Backup's Vault
  Lock. The retention choice in `docs/STATUS.md` (BAK-01 or BAK-09) still has to be made first.
- **Files:** a nightly `rclone sync` to a second provider, keeping versions for 30 days.
- **The master key and the secrets** are backed up separately, offline (§3).
- **The restore drill** (`docs/runbooks/restore-drill.md`) gets a self-hosted version that restores to a scratch server
  and runs the same reconciliation checks.
- **On AWS,** AWS Backup can stay, or the same tools can be used everywhere. That's decided when moving.

### 8. Monitoring that moves with the app

- Metrics stay Prometheus. Alerts are Prometheus Alertmanager rules, or Grafana Cloud's, kept in
  `infra/observability`, instead of CloudWatch alarms.
- Uptime checks and the status page run at a provider that isn't hosting Montra. That was already needed, because the
  status page can't run on the stack it reports on.
- Sentry stays. GlitchTip, which takes the same SDK, is an option for keeping error reports on own servers.

### 9. Infrastructure as code per provider

- `infra/terraform` stays as the AWS target. It isn't renamed, to keep its history.
- A new provider gets its own folder when a move is decided, built against the needs in §1.
- The self-hosted target isn't Terraform. The servers come from the owner, and Compose plus a setup script describe what
  runs on them.

### 10. Moving from one platform to another

The runbook `moving-platforms.md` sets out the order:

1. Build the new target and fill its secrets.
2. Copy the files with `rclone sync`, then keep them in step until the switch.
3. Replicate the database with logical replication, so the switch takes minutes, not a dump and restore.
4. Move the master key: either rewrap to the new adapter (`crypto:rewrap`), or bring the `local` key over.
5. Switch DNS in Cloudflare. Stop the old writers first.
6. Run the reconciliation checks. Keep the old platform read-only for 30 days.

### 11. Where Montra starts: a home server, then a VPS

The owner's decision on accepting this ADR (2026-11-14): **Montra starts on a server at home, shared with family and
friends. It moves to a VPS when real customers come.** The Consequences below still hold, and are accepted for that
first stage, where the people relying on it know it runs at home. What this changes in the build:

- **A Cloudflare Tunnel is the default way in, not an option.** `cloudflared` runs beside Caddy and connects out to
  Cloudflare, so the home router opens no inbound ports, and a dynamic IP address doesn't matter: nothing points at it.
  Cloudflare still gives DNS, TLS at the edge, WAF and rate limits. Publishing ports 80 and 443 stays possible for the
  VPS, where Caddy gets its own certificates as in §5.
- **Email goes through a sending service over SMTP** from the first day (Postmark, Mailgun, SES or similar), with SPF,
  DKIM and DMARC on the domain. Nothing tries to deliver mail from the home connection.
- **Power and disks are the owner's problem.** The setup runbook asks for a UPS that shuts the server down cleanly, disks
  in a mirror with SMART monitoring and an alert, and backups off the house (§7). The operations runbook says what to do
  after a power cut and when a disk fails.
- **`BILLING_MODE=off`** for family and friends: no Stripe account, no plans enforced. Turning billing on is part of the
  move to a VPS, with ADR-0049's plans.
- **The master key is a local file** (`KMS_MODE=local` from `MASTER_KEY_FILE`), backed up offline apart from the
  database backups. Vault is the step up when it's worth running.
- **The move to a VPS** follows `moving-platforms.md` (§10), the same as any other move. Because the images, the Compose
  stack and the backups are the same, it's mostly copying data and switching the tunnel or DNS.

## Build order

1. **The application changes:** `_FILE` secrets, `KMS_MODE=local` allowed in production from a file, `KMS_MODE=vault`,
   and `crypto:rewrap`.
2. **The self-hosted target:** `infra/selfhost`, pushing images to GHCR, the `selfhost` deploy step, and the setup and
   operations runbooks.
3. **Portable backups and alerts:** pgBackRest, rclone and Alertmanager rules, and the self-hosted restore drill.
4. **`moving-platforms.md`.** A GCP or Azure adapter and Terraform only when a move is decided.

## Consequences

- **Own servers mean owning what the cloud did:** patching the OS, disk encryption, failed disks, power and network,
  monitoring and backups. The launch checklist (pen test, restore drill, DPAs) applies the same.
- **Email can't come from own servers.** A home or VPS IP sending mail is mostly spam-foldered. The API's mail and
  Kratos's courier use a sending service over SMTP (SES, Postmark, Mailgun or similar), with SPF, DKIM and DMARC on the
  domain.
- **Hosting from a home connection** brings its own limits: upload speed, a dynamic IP, power cuts, and ISP terms that
  can forbid running servers. A Cloudflare Tunnel solves the inbound port and the IP. The rest is why a rented server
  or VPS is the better start.
- **One server is one point of failure.** Montra goes down with the server, and recovery is a restore from backups
  within the RTO. A second server running a Postgres standby is the next step when uptime matters more than cost.
- **AWS work isn't wasted.** It's one target among others.
- **A master key in a file** is only as safe as the server. Vault is the step up without a cloud.

## Alternatives considered

- **Kubernetes from the start.** Portable across every cloud's Kubernetes, but it's more to run than one or two
  servers need. The images and the `_FILE` secrets are the same, so a Helm chart can come later.
- **Staying AWS-only.** Simplest to finish, but it ties the price to one provider, which is what the owner wants to avoid.
- **A cloud-neutral layer such as Pulumi or Crossplane over all of them.** It hides the differences that matter
  (managed Postgres versions, KMS, object lock), and Montra's needs are already small enough to describe once (§1).
- **Sealing every file with the workspace key before upload.** It would make the provider's encryption irrelevant, but
  the doc-worker would then need to unwrap keys to read a statement, and every existing file would need rewriting.
  Worth revisiting if a provider's encryption at rest isn't trusted.
- **MinIO on the server for files.** Possible, but a store on the same server shares its failures, and a hosted
  S3-compatible bucket costs little for this size.
