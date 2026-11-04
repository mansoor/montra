# Restore drill

**Every quarter** (BAK-07). Proves that backups restore and that the restored ledger is correct. A backup nobody has restored is only
a hope.

> **Never run yet.** The first drill is on the [launch checklist](launch-checklist.md), and BAK-07 isn't met until it passes.

| Calendar  | Owner | Last run | Result |
| --------- | ----- | -------- | ------ |
| Quarterly | TBD   | Never    | None   |

## Rules

- **Isolated account.** Restore into a dedicated drill account, never into the production account. No network path to production. No
  production secrets.
- This is real customer data. The same people, access rules and care as production apply. Destroy it at the end.
- The application doesn't send email from a drill. Don't start `worker` or `kratos-courier` unless `MAIL_MODE` is off.

## Before

- [ ] A drill account in the organization, with AWS Backup cross-account copy allowed.
- [ ] The backup account's vault policy allows `backup:CopyIntoBackupVault` towards the drill account's vault.
- [ ] A vault in the drill account, encrypted with a key there.
- [ ] A VPC in the drill account with private subnets, and a place to run `psql`, such as CloudShell in VPC mode.
- [ ] Note the start time. RTO is measured from here.

## Steps

**1. Copy a recovery point from the backup account.** Rotate the source: daily one quarter, monthly the next, so both rules are tested.

```bash
# In the backup account
aws backup list-recovery-points-by-backup-vault --backup-vault-name montra-prod-copies \
  --query 'reverse(sort_by(RecoveryPoints,&CreationDate))[0:3].[RecoveryPointArn,CreationDate]'

aws backup start-copy-job \
  --recovery-point-arn <recovery-point-arn> \
  --source-backup-vault-name montra-prod-copies \
  --destination-backup-vault-arn arn:aws:backup:<region>:<drill-account>:backup-vault:<drill-vault> \
  --iam-role-arn <backup-role-arn>
```

**2. Restore it.** In the drill account:

```bash
aws backup get-recovery-point-restore-metadata \
  --backup-vault-name <drill-vault> --recovery-point-arn <copied-arn>

aws backup start-restore-job \
  --recovery-point-arn <copied-arn> \
  --iam-role-arn <drill-backup-role-arn> \
  --metadata file://restore-metadata.json
```

Then add an instance to the restored cluster with `aws rds create-db-instance`.

**3. Check the master can connect with TLS**, and that non-TLS connections are refused. A restore doesn't always bring the parameter group
with it, so set it to one with `rds.force_ssl = 1`.

**4. Run the reconciliation checks.** Every query must return no rows.

```bash
psql "$OWNER_URL" -v ON_ERROR_STOP=1 -f infra/db/reconciliation-checks.sql
```

They check that postings sum to 0 for each entry (Σ = 0), every entry has at least two postings, and `account_balance_daily` and
`category_activity_monthly` equal the postings. They were tried on a small local database only. On a production-size one they scan
every posting, so note how long they take.

**5. Compare with production.** Row counts should be close to production at the time of the recovery point.

```sql
select 'journal_entry' as t, count(*) from app.journal_entry
union all select 'posting', count(*) from app.posting
union all select 'workspace', count(*) from app.workspace;
```

**6. Test that encrypted columns can be read.** This is the step people skip. Restored `_enc` columns need the production `data` KMS key.
Grant the drill role decrypt on it, for the drill only, and read one value. If you can't read them, the backup isn't a full backup.

**7. Check the files.** Pick ten objects from `app.file` and read them from the replica bucket by `storage_key`. Delete one test object in
a non-production bucket and check that it can be restored through its previous version within 30 days.

**8. Confirm the lock.** In the backup account, try to delete a recovery point. It must be refused. Check that the lock shows compliance
mode.

**9. Note the end time, and destroy everything.** Delete the cluster, without a final snapshot, and the copied recovery point. Remove the KMS
grant from step 6. **Check that the grant is gone.**

## Pass or fail

| Check                               | Target           | Result |
| ----------------------------------- | ---------------- | ------ |
| Time from start to reconciled       | Under 4 hours    |        |
| Age of the newest recovery point    | Under 24 hours   |        |
| Reconciliation checks               | No rows          |        |
| Row counts close to production      | Explained if not |        |
| Encrypted columns readable          | Yes              |        |
| Files readable from the replica     | 10 of 10         |        |
| Recovery point can't be deleted     | Refused          |        |
| Everything destroyed, grant removed | Yes              |        |

Also try a PITR restore inside the production account's region twice a year, to measure the 5-minute RPO: note `LatestRestorableTime`
against the clock.

## After

- [ ] Record the date and results in the table at the top, and keep the output.
- [ ] Open issues for each failure. A failed drill is a Sev-2.
- [ ] Update [disaster recovery](disaster-recovery.md) with what you found, including the real restore time.
