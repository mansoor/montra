# Disaster recovery

Targets (BAK-07): **RPO ≤ 5 minutes, RTO ≤ 4 hours.**

> **Not exercised.** No part of this has been run. The first [restore drill](restore-drill.md) will show what is wrong here, and
> until then the 4-hour figure is a budget, not a measurement. Correct this page after each drill.

## What the targets cover

| Failure                              | RPO you get                       | Meets ≤ 5 min? |
| ------------------------------------ | --------------------------------- | -------------- |
| Writer instance or one AZ lost       | None to seconds (Aurora failover) | Yes            |
| Bad data, bad migration, human error | About 5 minutes (PITR)            | Yes            |
| Whole primary region lost            | **Up to 24 hours** (daily copy)   | **No**         |
| Workload account compromised         | **Up to 24 hours** (daily copy)   | **No**         |

The last two are a known gap. AWS Backup copies to the second region and backup account once a day, and PITR logs stay in the
primary region. If BAK-07 must hold for losing a region, the fix is an Aurora Global Database with a secondary cluster in the second
region. That has a real monthly cost, so it is the owner's decision. Files are better off: S3 replication usually finishes within
minutes.

## Before you start

1. Declare an incident ([incident response](incident-response.md)) and name a lead. Note the time. The RTO clock is running.
2. Stop writes if data is being damaged: scale `api` and `worker` to zero, or turn on the maintenance notice.

```bash
aws ecs update-service --cluster montra-prod --service worker --desired-count 0
aws ecs update-service --cluster montra-prod --service api --desired-count 0
```

3. **Don't delete anything.** Keep the damaged cluster until the incident is closed.

Time budget for a full restore:

| Step                            | Budget     |
| ------------------------------- | ---------- |
| Decide and declare              | 30 min     |
| Restore the cluster             | 90 min     |
| Reconnect services              | 30 min     |
| Reconciliation and checks       | 45 min     |
| Reopen                          | 15 min     |
| **Total, leaving 30 min spare** | **3 h 30** |

The restore time depends on database size, and it is the number the drill needs to measure.

## Scenario A: writer or AZ failure

Aurora promotes a reader by itself, usually within a minute or two. Connection strings use the cluster endpoint, so nothing changes.

1. Check that the cluster is healthy and that a new reader has come up.
2. Check `/readyz`, error rate and queue lag.

If the failover doesn't happen: `aws rds failover-db-cluster --db-cluster-identifier montra-prod`.

## Scenario B: bad data (point-in-time restore)

Use this for a bad migration, an accidental delete or corruption. It restores to a **new** cluster.

1. Find the last good time, in UTC, from logs, the audit log and the deploy history. Go a minute before the damage started.

2. Check it is inside the window:

```bash
aws rds describe-db-clusters --db-cluster-identifier montra-prod \
  --query 'DBClusters[0].[EarliestRestorableTime,LatestRestorableTime]'
```

3. Restore. Use the subnet group, security group and parameter group of the existing cluster.

```bash
aws rds restore-db-cluster-to-point-in-time \
  --source-db-cluster-identifier montra-prod \
  --db-cluster-identifier montra-prod-restored \
  --restore-to-time 2026-01-01T12:00:00Z \
  --db-subnet-group-name montra-prod \
  --vpc-security-group-ids <aurora-security-group> \
  --db-cluster-parameter-group-name <cluster-parameter-group> \
  --kms-key-id <database-key-arn>

aws rds create-db-instance --db-instance-identifier montra-prod-restored-0 \
  --db-cluster-identifier montra-prod-restored \
  --engine aurora-postgresql --db-instance-class db.r6g.xlarge

aws rds wait db-instance-available --db-instance-identifier montra-prod-restored-0
```

4. Run the [reconciliation checks](#reconciliation-checks) on the restored cluster.

5. Decide between a full switch and a partial repair. A full switch loses everything since the restore time. If only a few rows
   were damaged, it can be better to copy them back from the restored cluster into the live one, and keep the live cluster.

6. For a full switch, go to [Reconnect services](#reconnect-services).

## Scenario C: primary region lost

1. Find the latest recovery point in the second region's vault, `montra-prod-replica`:

```bash
aws backup list-recovery-points-by-backup-vault --region <replica-region> \
  --backup-vault-name montra-prod-replica \
  --query 'reverse(sort_by(RecoveryPoints,&CreationDate))[0:3].[RecoveryPointArn,CreationDate,Status]'
```

2. Stand up the stack in the second region. Copy `envs/prod` to a new root with its own state key, and swap `region` and
   `replica_region`. Set `vault_lock_enabled = false` and `cross_account_backup_enabled = false` for now. The Terraform state bucket
   must be reachable. If it was in the lost region, use its replica or rebuild it, so **keep the state bucket's versioning and take a
   copy in the second region**.

3. Restore the recovery point into the new VPC, with `aws backup start-restore-job`. The KMS replica keys are already in that region,
   including the `data` key, so encrypted columns stay readable.

4. Use the replica bucket as the file store. S3 names are global, so the new root needs a different `bucket_prefix`, and it creates
   an empty bucket of its own. Point `S3_BUCKET` and `S3_REGION` at the replica through `extra_environment` in the new root's
   `main.tf`. Task roles only allow the new stack's bucket and key, so add a policy by hand for the replica bucket and its key.
   Terraform doesn't cover this path, so expect manual work. When the primary region returns, replicate the new objects back.

5. Fill in the secrets in the new region and continue at [Reconnect services](#reconnect-services). Cloudflare records move to the
   new ALB when Terraform applies.

6. Tell users what was lost: anything written after the last copy, up to 24 hours. Users of the mobile app may still hold their
   outbox, and it will sync back when they reconnect.

## Scenario D: workload account compromised

Assume the attacker has everything in that account. This is also a security incident, so run
[incident response](incident-response.md) alongside it.

1. From the management account, lock down the workload account (SCP denying everything except your break-glass role).
2. Create a clean account in the organization.
3. Rotate every secret: database passwords, Kratos secrets, Stripe, SES SMTP, Anthropic, Sentry, `METRICS_TOKEN`, Cloudflare token. Treat
   all of them as stolen.
4. From the backup account, copy the latest recovery point from `montra-prod-copies` to a vault in the new account, then restore.
   Vault Lock means the attacker couldn't delete these.
5. **The `data` key is the hard part.** Field-encrypted columns are wrapped by a KMS key in the compromised account. Get a grant or a
   way to re-wrap before closing that account. If that key is destroyed, `_enc` columns can't be decrypted, ever. Don't close the
   old account.
6. Build the stack with Terraform in the new account, and continue at [Reconnect services](#reconnect-services).

## Reconnect services

1. Update the host in `DATABASE_URL`, `DATABASE_ADMIN_URL`, `ADMIN_DATABASE_URL`, `SUPPORT_DATABASE_URL` and `KRATOS_DSN` to the
   new writer endpoint. Keep everything else, including `sslmode=verify-full`.

2. Pick up the new secrets. ECS reads secrets at task start, so tasks have to be replaced.

```bash
for service in kratos kratos-courier worker doc-worker; do
  aws ecs update-service --cluster montra-prod --service "$service" --force-new-deployment
done
```

`api` and `web` use CodeDeploy, which doesn't accept `--force-new-deployment`. Rerun `deploy.yml` for the current version. It will run
migrations, which do nothing if the restored schema is current. If you stopped `api` and `worker`, set their desired counts back.

3. Bring Terraform back in line once things are stable: `terraform state rm` the old cluster and instances, and `terraform import` the
   new ones. Rename or adjust so the identifiers match. Reapply the AWS Backup selection to the new cluster ARN, or backups will silently
   stop covering it. **Check this one.**

## Reconciliation checks

Run from CloudShell in the VPC, as `montra_owner`. Every query must return no rows. See
[`infra/db/reconciliation-checks.sql`](../../infra/db/reconciliation-checks.sql).

```bash
psql "$OWNER_URL" -v ON_ERROR_STOP=1 -f infra/db/reconciliation-checks.sql
```

If a check returns rows, **don't reopen**. A difference in the read models but not the postings can be repaired. An unbalanced entry
means the restore or the ledger is wrong, and it stays a Sev-1 until explained.

## Reopen

- [ ] Reconciliation clean.
- [ ] `/readyz` answers 200. Sign in, open a dashboard, import a small CSV, open a receipt image.
- [ ] Workers are consuming and queue lag is falling.
- [ ] Backups run against the new cluster. Don't assume this. Start an on-demand job and watch it finish.
- [ ] Alarms are on the new resources.
- [ ] Users told, including what was lost. If personal data was exposed, the 72-hour rule in
      [incident response](incident-response.md#breach-notification) applies.
- [ ] Time to recovery and data lost recorded in the post-incident review.
