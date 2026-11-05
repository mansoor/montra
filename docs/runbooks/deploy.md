# Deploy

> **Not exercised.** `deploy.yml` and the scripts in `infra/deploy` passed `actionlint` and `shellcheck`, but have never run
> against AWS. Do the first real deployment on `dev` and correct this page.

## Which tag goes where

| Tag            | Environment | From                                       |
| -------------- | ----------- | ------------------------------------------ |
| `vX.Y.Z-dev.N` | `dev`       | `develop`                                  |
| `vX.Y.Z-rc.N`  | `staging`   | `release/*`                                |
| `vX.Y.Z`       | `prod`      | `main`; the workflow refuses anything else |

You can also run `deploy.yml` by hand from the Actions tab. If `AWS_ROLE_ARN` isn't set on the environment, the workflow skips
with a notice and stays green.

GitHub asks for approval on each job that names a protected environment, so `prod` asks more than once per run.

## What a deployment does

1. Builds the four images and pushes them to ECR, tagged with the commit and attempt. Tags are immutable.
2. Runs Kratos migrations, then ledger migrations as `montra_owner`, each as a one-off ECS task.
3. Rolls out `kratos` and `kratos-courier`, then `worker` and `doc-worker` (ECS rolling update with the circuit breaker).
4. Starts a CodeDeploy blue/green deployment of `api`, then `web`:
   - new (green) tasks start next to the old (blue) ones;
   - 10% of traffic moves, and after 5 minutes the rest does;
   - blue stays up for 15 minutes, which is the window for an instant rollback.

CodeDeploy rolls back by itself if the green tasks fail health checks, or if the `montra-<env>-5xx-rate` alarm fires.

Why only two services are blue/green: CodeDeploy needs a load balancer, so workers can't use it. Kratos has one, but the API
reaches it through Cloud Map, which the CodeDeploy controller doesn't support.

Worker tasks get SIGTERM and 120 seconds to finish. Jobs that don't finish are requeued by `app.requeue_stale_jobs()`.

Environment changes in Terraform take effect at the next deployment, because each deployment starts from the latest task
definition.

## Migrations: expand and contract (OPS-04)

During a deployment, old and new code run against the same database, and migrations run first. So **each migration must work
with the code before it**. Mobile apps stay on old versions for longer still.

| Step       | Release | What                                                                          |
| ---------- | ------- | ----------------------------------------------------------------------------- |
| Expand     | N       | Add the new column or table. Nullable or with a default. Old code ignores it  |
| Dual write | N       | New code writes both, reads old                                               |
| Backfill   | N       | Fill old rows in batches, in a job or a later migration                       |
| Switch     | N+1     | New code reads new                                                            |
| Contract   | N+2     | Drop the old column, once no running code or supported mobile version uses it |

Avoid in one step: renaming a column, adding `NOT NULL` without a default, dropping anything still read, or a long lock on a
big table. Use `create index concurrently`. It can't run inside a transaction, and the runner applies each migration in one, so
check how to do this before you need it.

Migrations are append-only once merged. A migration that has run can't be rolled back by the workflow. Fix forward with a new
one.

## Rollback

**During a deployment, or within 15 minutes after:** stop the deployment in the CodeDeploy console, choosing "stop and roll
back". Traffic returns to blue at once.

```bash
aws deploy stop-deployment --deployment-id <id> --auto-rollback-enabled
```

**After that:** deploy the previous good version. Check which tag it was in ECR. Rerun `deploy.yml` from the previous good tag
in the Actions tab, or re-tag if the run has expired. This also reruns migrations, which do nothing if they have already run.
The old code must work with the current schema. Expand and contract is what guarantees that.

**Kratos' schema isn't expand and contract.** Its migrations are Ory's. From v1.3.1 to v26.2.0, the old version fails sign-in and
identity changes on the migrated schema, so stop Kratos for that upgrade, and before going back run this from the new image:
`kratos migrate sql down -e --steps 23 --yes`. Tried on a local database only. Check this again for each new Kratos version.

**Workers, doc worker and Kratos:** the circuit breaker rolls back tasks that won't start. For a bad version that does start,
deploy the previous tag as above, or point the service at the previous task definition:

```bash
aws ecs update-service --cluster montra-<env> --service worker --task-definition montra-<env>-worker:<previous-revision>
```

**A bad migration:** don't roll back the code first if the old code can't run on the new schema. Write a forward fix. If data was
damaged, go to [disaster recovery](disaster-recovery.md).

## Announcing maintenance (OPS-03)

Blue/green means routine releases need no announcement. If work could affect users, post the in-app banner 48 hours ahead and
update the status page. Design 07 §8 plans a `system_notice` table for the banner. It isn't in the migrations at the time of
writing, so check that it exists.

## Checks after a deployment

- [ ] `/readyz` answers 200 on the API.
- [ ] The 5xx rate and dashboard p95 on the SLO dashboard haven't moved.
- [ ] Queue lag is normal and no queue is stuck.
- [ ] Sign in on web. Open the dashboard. Import a small CSV.
- [ ] Sentry shows no new error groups.
