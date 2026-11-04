# Terraform

Production infrastructure for Montra on AWS and Cloudflare. **None of this has been applied.** It has only been through
`terraform fmt`, `init -backend=false` and `validate`, which check syntax and types, not whether AWS or Cloudflare
accepts the result. Expect to fix things on the first apply. Start with `dev`.

## Layout

| Path                      | What                                                                                   |
| ------------------------- | -------------------------------------------------------------------------------------- |
| `envs/{dev,staging,prod}` | One root and one state per environment. They differ only in sizing and safety settings |
| `modules/stack`           | Wires everything for one environment                                                   |
| `modules/network`         | VPC, subnets across AZs, NAT, ALB with a TLS 1.2+ policy                               |
| `modules/certificate`     | ACM certificate for the ALB, validated through Cloudflare DNS                          |
| `modules/kms`             | Per-environment keys, multi-region with replicas where a restore needs them            |
| `modules/database`        | Aurora PostgreSQL 16, encrypted, `rds.force_ssl`, PITR, reader                         |
| `modules/storage`         | S3 with SSE-KMS, versioning, 30-day noncurrent lifecycle, cross-region replica         |
| `modules/backup`          | AWS Backup plan, copies to a second region and a separate account, Vault Lock          |
| `modules/compute`         | ECR, ECS Fargate services, CodeDeploy, secrets, autoscaling                            |
| `modules/email`           | SES identity, DKIM, SPF and DMARC records in Cloudflare                                |
| `modules/edge`            | Cloudflare DNS, WAF, rate limiting and managed challenge                               |
| `modules/observability`   | SNS topic, CloudWatch alarms, EventBridge rule for backup failures                     |
| `modules/ci`              | GitHub OIDC role for `deploy.yml`                                                      |

## Use

```bash
cd infra/terraform/envs/dev
cp backend.hcl.example backend.hcl            # git-ignored
cp terraform.tfvars.example terraform.tfvars  # git-ignored
export CLOUDFLARE_API_TOKEN=...
terraform init -backend-config=backend.hcl
terraform plan
```

The order of the first apply matters, because tasks need images and secrets. Follow
[`docs/runbooks/first-time-setup.md`](../../docs/runbooks/first-time-setup.md).

Check without credentials, as CI does:

```bash
terraform fmt -check -recursive infra/terraform
terraform -chdir=infra/terraform/envs/prod init -backend=false
terraform -chdir=infra/terraform/envs/prod validate
```

## How the pieces fit

- **Secrets:** Terraform creates empty Secrets Manager secrets and never sees a value, so nothing sensitive reaches the
  state file. RDS manages the Aurora master password itself.
- **Task definitions:** Terraform registers the first revision with the tag in `image_tag`. `deploy.yml` then registers
  new revisions from the latest one with the image it built. So an environment change in Terraform takes effect at the
  next deployment, not at apply.
- **Blue/green:** only `api` and `web` use CodeDeploy, because it needs a load balancer. `worker`, `doc-worker`,
  `kratos` and `kratos-courier` use rolling updates with the ECS circuit breaker. `kratos` also takes ALB traffic, but
  the API reaches it through Cloud Map, and Cloud Map doesn't work with the CodeDeploy controller.
- **Kratos:** it runs as its own service, with a single-instance courier for email. Its public port is at `auth.<domain>`
  and its admin port is only on the private network. The API can't use Cloud Map (see above), so Kratos calls the API's
  webhook at its public URL, authenticated with `KRATOS_WEBHOOK_SECRET`.
- **Queue lag metric:** ECS autoscaling needs a CloudWatch metric, and the API exposes Prometheus. A collector sidecar on
  API tasks scrapes `/internal/metrics` over localhost and publishes a few metrics to CloudWatch.
- **Cloudflare zones:** use one zone per environment. A zone has one ruleset per phase, so two environments in one zone
  would overwrite each other. Separate zones also avoid needing a paid certificate for names like `api.staging.example`.

## What the plans differ on

| Setting             | dev         | staging    | prod             |
| ------------------- | ----------- | ---------- | ---------------- |
| Aurora instances    | 1           | 2          | 2                |
| PITR window         | 7 days      | 35 days    | 35 days          |
| Backup account copy | no          | yes        | yes              |
| Vault Lock          | no          | no         | yes (compliance) |
| Deletion protection | no          | yes        | yes              |
| CodeDeploy          | all at once | 10% canary | 10% canary       |
| NAT gateways        | 1           | one per AZ | one per AZ       |
