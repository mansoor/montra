# 07 — Security, Privacy and Operations

## 1. Identity and authentication (§13.1)

Identity runs on **Ory Kratos**: self-hosted in our VPC, or Ory Network as a managed
option. It is open source, so the self-hosted edition can use the same stack. See
[ADR-0006](adr/0006-identity-ory-kratos.md).

| Req | How |
| --- | --- |
| AUTH-01 | Kratos flows: password, WebAuthn passkeys, OIDC (Sign in with Apple, Google). |
| AUTH-02 | Minimum length 12, HaveIBeenPwned k-anonymity check (built into Kratos), Argon2id hasher configured, no forced resets. |
| AUTH-03 | `verification` flow is required. The API rejects financial writes until `email_verified_at` is set (onboarding can show demo data). |
| AUTH-04 | TOTP + WebAuthn as second factors, 10 lookup-secret recovery codes, SMS only as a fallback (code via the courier). The AAL2 requirement is enforced for owners by default and always for accountant roles. |
| AUTH-05 | `recovery` flow with a 30-minute one-time link and a neutral response. The API revokes all sessions after a reset and sends a confirmation email. AAL2 is still required. |
| AUTH-06 | Recovery-code login. Without codes: a support identity check with a 72-hour hold, implemented as a `pending_mfa_reset` record and alerts. |
| AUTH-07 | Kratos sessions with rotating refresh on mobile, idle timeout 30 min on web (configurable), and a device list in `session_device`. Mobile biometric unlock gates the stored token. |
| AUTH-08 | Kratos rate limits plus a Cloudflare WAF rule, progressive delay after 5 failures, Turnstile CAPTCHA after repeated failures, and a new-device email alert. |
| AUTH-09 | Privileged-session check (Kratos `privileged_session_max_age` = 10 min) for export, deletion, email/MFA change, accountant invite, and showing full account numbers. |
| AUTH-10/11 | Invite tokens (hashed, 7-day expiry). Email change needs confirmation from both the old and the new address. |

## 2. Authorization (NFR-03, UP-04, BIZ-13)

| Role | Default entity access | Can |
| --- | --- | --- |
| owner | write on all | everything, including billing, deletion, sharing and AI mode |
| partner | write on personal; business/rental **none** by default (configurable per entity) | daily use, budgets, imports |
| viewer | read on granted entities | view and export reports |
| accountant | read (or write if granted) on selected entities; MFA required | journals, trial balance, exports, period close if write |

Policy checks live in one `PolicyService.can(user, action, resource)`, used by guards
and by list-query filters (entity and account visibility). RLS remains the tenant
backstop.

## 3. Data protection

| Layer | Control |
| --- | --- |
| Transit | TLS 1.2+ (TLS 1.3 preferred), HSTS, certificate pinning on mobile for the API host. |
| At rest | RDS/Aurora and S3 encryption with KMS (AES-256). |
| Field level | Envelope encryption (AES-256-GCM) for `_enc` columns, with a per-workspace data key wrapped by KMS and cached in memory for 5 minutes. Rotating a key re-wraps the data keys. |
| Device | Mobile SQLite encrypted (SQLCipher) with its key in Keychain/Keystore, wiped on sign-out (BAK-10). |
| Secrets | AWS Secrets Manager. BYOK AI keys are stored as KMS-encrypted blobs, decrypted only in the gateway process, and never logged. |
| Logs | pino redaction paths (`*.amount`, `*.payee*`, `*.memo`, `authorization`, `*.accountNumber`). No financial data in logs or traces; ids only. |
| Uploads | Presigned PUTs restricted by content type and length, an antivirus scan (ClamAV in the worker) before processing, and image re-encoding to strip EXIF GPS data. |

## 4. Audit (NFR-03, AUTH-12)

`audit_log` is append-only (the app role has no `UPDATE`/`DELETE` grant). It records
every create/update/delete on financial records (with a field diff), sign-ins, MFA
changes, exports, support access, invites and AI provider changes. Users see the security
subset (AUTH-12) and owners see the full log.

## 5. Privacy (NFR-05/06, UP-06)

- No ads and no third-party trackers in the app. Product analytics are self-hosted
  (PostHog self-hosted or similar) and contain no financial data.
- A plain-language privacy page per AI mode lists exactly which fields leave, to whom,
  and the retention terms (generated from the minimizer configuration so the two stay in
  sync).
- Self-service export (CSV/XLSX/JSON + attachments ZIP) and account deletion. Deletion
  soft-deletes immediately, purges from the primary database and object storage within
  30 days (purge job), and the data ages out of backups within 35 days (BAK-09).
- GDPR/CCPA: data subject export = the full export; data processing agreements with
  every AI and OCR provider (OPS-11).

## 6. Backup and restore (§13.2)

| Req | Implementation |
| --- | --- |
| BAK-01 | Aurora continuous PITR (35 days), daily automated snapshots (35 days), monthly manual snapshots via AWS Backup (12 months). |
| BAK-02 | AWS Backup vault copy to a second region **and** a separate backup account with Vault Lock (compliance mode). KMS multi-region keys. |
| BAK-03 | S3 versioning + cross-region replication + Object Lock on the backup bucket; a 30-day noncurrent-version lifecycle gives recoverable deletes. |
| BAK-04 | "Back up now" job → ZIP (`manifest.json`, `data/*.jsonl` per table, `csv/`, `attachments/`), optionally AES-256 encrypted (password via Argon2id KDF, ZIP AES or age format). Download through a presigned URL. |
| BAK-05 | Scheduled exports to Google Drive, OneDrive or Dropbox through OAuth connectors (tokens KMS-encrypted), or an emailed link. iCloud via the mobile Files export. |
| BAK-06 | Restore: upload the archive, validate the manifest and checksums, show a preview (counts per entity, date range, conflicts), then import into a new workspace (default) or merge into an existing one (ids remapped; duplicates detected through dedupe keys). Trash: soft-deleted rows are kept 30 days and restorable from `/trash`. |
| BAK-07 | RPO ≤ 5 min (Aurora PITR), RTO ≤ 4 h (runbook + Terraform). A quarterly restore drill restores into an isolated account and runs the reconciliation checks (Σ postings = 0 per entry, balances equal the read models). |
| BAK-08 | Storage usage meter (`attachment.bytes` summed per workspace) and plan quotas. Receipts are compressed on device to about 1 MB (JPEG/HEIC → WebP/JPEG q≈80, long edge 2,000 px), and the original is kept if the user opts in. |
| BAK-09/10 | See §5 and §3. |

## 7. Observability (NFR-13, OPS-07)

- OpenTelemetry SDK in api/worker → OTLP collector → Grafana Cloud (Tempo, Loki,
  Prometheus) or Datadog. Sentry for errors (web, mobile, api, worker).
- SLOs: API availability 99.9%, dashboard p95 < 2 s, import parse p95 < 10 s for 5k rows,
  queue lag p95 < 30 s, AI task error rate < 2%.
- Business dashboards: import failures by `import_profile.institution` and file type,
  manual-mapping rate, AI accepted-without-edit rate by provider and model, review queue
  size.
- Alerts: on-call paging for SLO burn rates, AI provider error spikes (with automatic
  failover to the secondary provider or to the review queue), backup job failures, and
  `assert_entry_balanced` exceptions (which should never happen).

## 8. Administration and support (§13.5)

- **Admin console** (`apps/web` `/admin`, staff SSO, separate role): account lookup by
  email, plan and billing state, feature flags, import-failure analytics, and a
  reference-data editor (tax lines, mileage rates, merchant aliases, import profiles,
  currencies) with versioning (OPS-01, OPS-05).
- Staff **cannot** read financial tables. The admin API runs under a database role that
  has no grants on the `app.*` financial tables. Support access requires a
  `support_grant` created by the user (72 h default, read-only default, logged, revocable)
  and a support session that sets `app.workspace_id` (OPS-02). Read-only grants are
  enforced in the database: support sessions connect as `montra_support_ro` (SELECT
  only) inside `SET TRANSACTION READ ONLY`.
- Security patching: Renovate + `pnpm audit` + GitHub Dependabot alerts + Trivy image
  scanning. SLA: critical within 72 h, others monthly (OPS-06).
- Incident response and disaster recovery runbooks in `docs/runbooks/` (OPS-12),
  breach notification within 72 h.
- Email: SES with SPF/DKIM/DMARC; transactional and marketing streams separated;
  one-click unsubscribe (OPS-10).
- Maintenance banners: a `system_notice` table drives in-app banners 48 h ahead, plus a
  public status page (OPS-03).
