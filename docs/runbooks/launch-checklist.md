# Launch checklist

From closed beta to `v1.0.0` on `main`. Tick items only with evidence, and link to it. **Everything is open today.**

Blockers known at the time of writing are in bold.

## 1. Infrastructure in place

- [ ] `dev` built from [first-time setup](first-time-setup.md), with corrections made to the runbooks.
- [ ] `staging` built the same way.
- [ ] `prod` built. Vault Lock cooling-off period passed on purpose, after the retention decision below.
- [ ] **Decide: BAK-01 keeps monthly backups for 12 months, BAK-09 says deleted data ages out within 35 days.** This has to be settled before the
      lock sets.
- [ ] **Decide: the 5-minute RPO doesn't hold for losing a region, because copies are daily.** Accept this in writing, or add an Aurora Global
      Database. See [disaster recovery](disaster-recovery.md#what-the-targets-cover).
- [ ] Alarm topic connected to a pager. A test alarm reached the person on call.
- [ ] Prometheus or Grafana Cloud chosen and scraping. Dashboards loaded. Metric names checked against what the API really exposes, including job and
      AI metrics from the worker process.

## 2. Closed beta

- [ ] Beta users invited on `staging` or a beta deployment, with real statements from their real banks.
- [ ] Support channel staffed. Bug reports reach someone.
- [ ] Import failures by bank format reviewed each week, and new profiles added.

### R1 exit metrics, measured in the beta

| Metric                                          | Target           | Measured | Evidence |
| ----------------------------------------------- | ---------------- | -------- | -------- |
| Auto-categorization accepted without edit       | ≥ 85% (month 1)  |          |          |
| A month of statements imported and reviewed     | < 10 minutes     |          |          |
| Dashboard p95 with 50,000 transactions (NFR-07) | < 2 s            |          |          |
| 5,000-row import parse (NFR-07)                 | < 10 s before AI |          |          |
| Open Sev-1 or Sev-2 security findings           | None             |          |          |

The requirements also list these for R1, to track through the beta: CSV imports needing manual mapping after the first time < 5%, balanced budget ≥ 70%
of active users, 30-day retention ≥ 50%.

Run [`infra/load`](../../infra/load/README.md) on `staging` with a workspace of 50,000 transactions. So far the scripts have only run locally, on almost
no data. One short local run put the 5,000-row parse at about 6 to 9 seconds, close to the limit, so look at this early.

## 3. Security

- [ ] **`security.yml` green.** On the last local scan these were open and will fail the workflow: `fastify` 5.11.3 (4 high) and `nodemailer` 8.0.11
      (3 high) in the API image, and `postcss` 8.4.31 (2 high) in web. Kratos now scans clean, built from source ([ADR-0021](../design/adr/0021-kratos-built-from-source.md)), which
      still needs the owner's decision and a first run on staging.
- [ ] **External pen test** done, on `staging`, with a written report. Allow for the fixes as well as the test. No Sev-1 or Sev-2 open.
- [ ] Cross-workspace access tested by the pen tester (RLS), and staff access limited to `support_grant`.
- [ ] Secrets rotated after the pen test, if testers had any.
- [ ] Tabletop of [incident response](incident-response.md), with names filled in for the roles.
- [ ] AUTH-05 wording checked: the requirement says an emailed **link**, and the current flow sends a **code**, with the same single use and 30 minutes.
      Accept the code, or change it.

## 4. Backups and recovery

- [ ] **First [restore drill](restore-drill.md) passed**, in an isolated account, with reconciliation clean and under 4 hours.
- [ ] Copies confirmed in the second region and the backup account.
- [ ] A deleted recovery point refused in a locked vault.
- [ ] A deleted file restored within 30 days.

## 5. Legal (OPS-11)

- [ ] **Legal review** of the terms of service and privacy policy, by a qualified lawyer. Notification duties by jurisdiction confirmed.
- [ ] Cookie consent where required.
- [ ] **A signed DPA with every AI and OCR provider**, plus sub-processors: Anthropic, and any failover provider that is turned on. OCR runs locally with
      Tesseract today, so list it if that changes.
- [ ] DPAs or equivalent terms with other processors that touch personal data: AWS, Cloudflare, Stripe, Sentry, Expo push.
- [ ] Privacy policy lists all of those.
- [ ] Sentry and log scrubbing checked: no financial data arrives there.

## 6. Application

- [ ] WCAG audit fixes done.
- [ ] Billing tested with Stripe test mode end to end, including failed payments and lapsed plans (OPS-08). Live keys only in `prod`.
- [ ] Store billing and app review in progress or done, if in R1.
- [ ] Device checks on iOS and Android closed (see `docs/STATUS.md`).
- [ ] Minimum mobile version set (OPS-04).
- [ ] Help center and guided tours live (OPS-09).
- [ ] Public status page live (OPS-03). This isn't in the Terraform.
- [ ] SES production access granted. Email passes SPF, DKIM and DMARC. DMARC reports reviewed before tightening the policy.

## 7. Release path

1. [ ] Cut `release/1.0` from `develop`. Only fixes go on this branch from now on. Merge fixes back to `develop`.
2. [ ] Tag `v1.0.0-rc.1` on `release/1.0`. `deploy.yml` sends it to `staging`.
3. [ ] Run the checks in [deploy](deploy.md#checks-after-a-deployment), the load tests and the Playwright suite against it.
4. [ ] For each fix, tag `v1.0.0-rc.N` and repeat. Keep the release stable for at least a week of beta use before going on.
5. [ ] Update `CHANGELOG.md`, `docs/STATUS.md` and `docs/design/status.json`.
6. [ ] Open a PR from `release/1.0` to `main`. CI green. Owner approves.
7. [ ] Merge to `main`. Tag `v1.0.0` on that commit. `deploy.yml` checks that the commit is on `main`, then goes to `prod` after approval.
8. [ ] Merge `main` back into `develop`.
9. [ ] Watch for 24 hours: SLO dashboard, Sentry, queues, the first nightly reconciliation and the first backup.
10. [ ] Open sign-ups in stages. Keep a way to pause them.

## Rollback plan for launch day

See [deploy](deploy.md#rollback). No destructive migrations in the release. The `v1.0.0-rc.N` image of the last good candidate is the one to fall back to, but images are built per
environment, so deploy that commit through `deploy.yml` to `prod` rather than reusing a staging image.
