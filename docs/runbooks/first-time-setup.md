# First-time setup

What the owner must create by hand before Terraform can run, and the order of the first apply.

> **Not exercised.** No step here has been run against a real account. Start with `dev` and expect corrections.

Do `dev` first, then `staging`, then `prod`. Times are rough guesses.

## 1. Accounts and services

### AWS

- [ ] An AWS Organization with a **workload account** and a separate **backup account**. Cross-account copies only work
      inside one organization. Keep root credentials for the backup account offline, with different people from the
      workload account where you can.
- [ ] In the management account, under AWS Backup settings, turn on **cross-account backup** and **cross-account
      monitoring**. Copies fail without this.
- [ ] In the backup account, create a role called `montra-terraform`. Terraform in the workload account assumes it to
      manage the vault there. Trust the principal that runs Terraform. It needs `backup:*` on vaults and `kms:*` to create
      one key.
- [ ] Choose two regions and set `region` and `replica_region`. Check that Aurora PostgreSQL 16 and SES are in both.
- [ ] Create the Terraform state bucket and lock table once per account. Turn on bucket versioning and encryption.

```bash
aws s3api create-bucket --bucket <state-bucket> --region us-east-1
aws s3api put-bucket-versioning --bucket <state-bucket> --versioning-configuration Status=Enabled
aws s3api put-bucket-encryption --bucket <state-bucket> \
  --server-side-encryption-configuration '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'
aws s3api put-public-access-block --bucket <state-bucket> \
  --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
aws dynamodb create-table --table-name <lock-table> \
  --attribute-definitions AttributeName=LockID,AttributeType=S \
  --key-schema AttributeName=LockID,KeyType=HASH --billing-mode PAY_PER_REQUEST
```

### Cloudflare

- [ ] One **zone per environment**, for example `montra.example` and `montra-staging.example`. A zone holds one ruleset
      per phase, so environments can't share one.
- [ ] Plan for production: **Pro** at least, for the managed WAF rulesets and a 60-second rate-limit period. **Business**
      lets the challenge count only failed sign-ins (`rate_limit_count_failures_only = true`). Without it, every POST
      counts, so a person signing in correctly is counted too. On a Free zone, set `managed_waf_enabled = false` and
      `rate_limit_period_seconds = 10`.
- [ ] An API token limited to these zones, with Zone Settings, DNS, Zone WAF and Firewall Services edit. Pass it as
      `CLOUDFLARE_API_TOKEN`. Never put it in a file.

### GitHub

- [ ] Environments `dev`, `staging` and `prod`. Add required reviewers on `prod`.
- [ ] Set the variables `AWS_ROLE_ARN` and `AWS_REGION` on each environment after step 2. Until then `deploy.yml` skips.

### Stripe

- [ ] Products and the Pro monthly and yearly prices. Put the price ids in `terraform.tfvars`.
- [ ] A webhook endpoint at the API's billing webhook route. Keep the signing secret for step 4.
- [ ] Test mode keys for `dev` and `staging`, live keys for `prod` only.

### Sentry

- [ ] A project per environment. Keep the DSN for step 4.

### SES

Terraform creates the identity and DNS records, but these are by hand:

- [ ] **Request production access** in each sending region. New accounts are in the sandbox and can only send to verified
      addresses. AWS reviews the request, so allow a few days.
- [ ] Create **SMTP credentials** (SES console, or an IAM user with `ses:SendRawEmail` on the identity). The SMTP password
      is derived from the IAM key. It isn't the key itself.

### Decide before the first production apply

- [ ] **Vault Lock.** Production has `vault_lock_enabled = true` in compliance mode. For 3 days after apply you can still
      delete the lock. After that nobody can, including AWS. The vaults, and the cost of what is in them, stay until every
      backup ages out.
- [ ] **Retention.** BAK-01 keeps monthly snapshots for 12 months. BAK-09 says a deleted account's data ages out of backups
      within 35 days. Those two conflict, and a compliance lock makes it permanent. Decide which wins, or change the privacy
      policy wording, **before** the lock sets.
- [ ] **Region-loss RPO.** See [disaster recovery](disaster-recovery.md#what-the-targets-cover). Backups reach the second
      region once a day, so the 5-minute RPO doesn't hold if the whole region is lost.

## 2. First apply, up to the deploy role

Tasks need images and secrets, and images need the deploy role. So apply in stages.

```bash
cd infra/terraform/envs/dev
cp backend.hcl.example backend.hcl            # fill in; git-ignored
cp terraform.tfvars.example terraform.tfvars  # fill in; git-ignored
export CLOUDFLARE_API_TOKEN=...

terraform init -backend-config=backend.hcl
terraform plan -target=module.stack.module.ci -target=module.stack.module.database
terraform apply -target=module.stack.module.ci -target=module.stack.module.database
```

Several environments in one AWS account: set `create_github_oidc_provider = false` on all but the first.

This creates the network, certificate, keys, Aurora, ECR, secrets (empty) and the deploy role. Take the role from
`terraform output deploy_role_arn` and set it on the GitHub environment.

## 3. Create the database roles

Production needs `montra_owner`, `montra_app`, `montra_admin`, `montra_support` and, for Kratos, `montra_kratos`.
[`infra/db/production-roles.sql`](../../infra/db/production-roles.sql) mirrors `infra/db/bootstrap.sql`, with real passwords.
Terraform doesn't create these, despite the comment in `bootstrap.sql`, because the passwords would land in its state.

Aurora has no public endpoint. Use **CloudShell in VPC mode**, in a private subnet, with the application security group.

```bash
sudo dnf install -y postgresql16

# Generate passwords. Hex needs no URL encoding. Keep them only until step 4.
for name in OWNER APP ADMIN SUPPORT KRATOS; do
  export "MONTRA_${name}_PASSWORD=$(openssl rand -hex 32)"
done

# The master password is in the secret from `terraform output aurora_master_secret_arn`.
curl -so global-bundle.pem https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem
export PGPASSWORD=$(aws secretsmanager get-secret-value --secret-id <master-secret-arn> \
  --query SecretString --output text | jq -r .password)
export MASTER_URL="postgres://montra_master@<writer-endpoint>:5432/montra?sslmode=verify-full&sslrootcert=global-bundle.pem"

# Check this first. See the note below.
psql "$MASTER_URL" -c "create role bypassrls_check bypassrls" -c "drop role bypassrls_check"

psql "$MASTER_URL" -f production-roles.sql
```

**Check the `BYPASSRLS` step first.** PostgreSQL 16 only lets a role with `BYPASSRLS` create another one. Locally, a plain
`CREATEROLE` user is refused. The Aurora master also has `rds_superuser`, and whether that is enough hasn't been tried. If
Aurora refuses, stop here. `bootstrap.sql` gives `montra_owner` this attribute, so check with whoever owns the migrations
whether the owner role really needs it before changing anything.

The name is `montra_support` here and in the Phase 11 brief. Design 07 §8 calls it `montra_support_ro`. The name must match
what the migrations grant to.

## 4. Fill in the secrets

An ECS task won't start if any secret it names has no value. **So every secret needs a value**, even one you don't use yet.
Terraform doesn't manage the values, and they never reach its state.

```bash
aws secretsmanager put-secret-value --secret-id montra-dev/DATABASE_URL --secret-string "$VALUE"
```

Use the same CA path in every Node and Python string. The images ship the file at that path.

| Secret                  | Value                                                                                                                         |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`          | `postgres://montra_app:<pw>@<writer>:5432/montra?sslmode=verify-full&sslrootcert=/etc/ssl/certs/rds-global-bundle.pem`        |
| `DATABASE_ADMIN_URL`    | The same with `montra_owner`. Migrations only: this is the owner, not the admin console                                       |
| `ADMIN_DATABASE_URL`    | The same with `montra_admin`. Admin console                                                                                   |
| `SUPPORT_DATABASE_URL`  | The same with `montra_support`. Support sessions                                                                              |
| `KRATOS_DSN`            | `postgres://montra_kratos:<pw>@<writer>:5432/kratos?sslmode=verify-full&sslrootcert=/etc/config/kratos/rds-global-bundle.pem` |
| `KRATOS_COOKIE_SECRET`  | `openssl rand -hex 32`                                                                                                        |
| `KRATOS_CIPHER_SECRET`  | `openssl rand -hex 16`. **Exactly 32 characters.** Kratos refuses to start on a longer one                                    |
| `KRATOS_WEBHOOK_SECRET` | `openssl rand -hex 32`. Shared by Kratos and the API                                                                          |
| `KRATOS_SMTP_URL`       | `smtps://<smtp-user>:<url-encoded-smtp-password>@<ses-smtp-endpoint>:465/`                                                    |
| `MAIL_URL`              | The same SMTP details, in the form the API's mailer takes                                                                     |
| `METRICS_TOKEN`         | `openssl rand -hex 32`. Also goes in the Prometheus scrape config                                                             |
| `STRIPE_SECRET_KEY`     | From Stripe                                                                                                                   |
| `STRIPE_WEBHOOK_SECRET` | From Stripe                                                                                                                   |
| `SENTRY_DSN`            | From Sentry                                                                                                                   |
| `ANTHROPIC_API_KEY`     | From Anthropic. Sign the DPA first ([launch checklist](launch-checklist.md))                                                  |

Then clear the passwords from the shell. Close the CloudShell session.

Keep `sslmode=verify-full`. If the CA file is wrong, Node fails with "unable to verify the first certificate". The Node images
also set `NODE_EXTRA_CA_CERTS` to the same file.

## 5. Build the first images

Run `deploy.yml` from the Actions tab, with the environment selected and **build_only** checked. Take the tag from the run
(the commit's first 12 characters, a dash and the attempt number).

## 6. Apply the rest

```bash
terraform plan -var image_tag=<tag>
terraform apply -var image_tag=<tag>
```

Then confirm the alarm subscriptions from the email each address receives. Connect the SNS topic in
`terraform output alarm_topic_arn` to your pager.

## 7. First deployment

Run `deploy.yml` again, without build_only. It migrates both databases and then deploys every service.

Check:

- [ ] `https://api.<domain>/readyz` answers 200.
- [ ] `https://api.<domain>/internal/metrics` answers 403 or 404 from outside.
- [ ] `https://app.<domain>` shows the sign-in page.
- [ ] A recovery email and a verification email arrive and aren't marked as spam. Check the SPF, DKIM and DMARC results in the
      message headers.
- [ ] Metrics appear in CloudWatch under `Montra/<env>`. Worker autoscaling and the queue alarms depend on them.
- [ ] Ten failed sign-ins from one IP get a Cloudflare managed challenge.
- [ ] A backup job has run, and copies are in the second region and the backup account. Wait a day for this one.
- [ ] Vault Lock, in production only: see that the lock shows in the console and note the date the cooling-off period ends.

## 8. Prometheus and Grafana

`infra/observability` holds the rules and dashboards. Terraform doesn't deploy a Prometheus. Design 07 §7 expects Grafana
Cloud or similar. Choose one, load the files, and give it the `METRICS_TOKEN`.
`/internal/metrics` is blocked from the internet, so the scrape must come from inside the VPC.
