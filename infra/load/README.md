# Load tests

k6 scripts for the performance targets in NFR-07. **NFR-07 has not been measured yet.** The scripts have only been run
to check that they work: briefly, with 2 virtual users, against a local API and worker in Docker, on a workspace with
almost no data. Point them at local or staging only, never at production.

| Script            | What it checks                                                         | Threshold                     |
| ----------------- | ---------------------------------------------------------------------- | ----------------------------- |
| `dashboard.js`    | `GET /v1/workspaces/:id/dashboard`                                     | p95 < 2 s, errors < 1%        |
| `transactions.js` | `GET /v1/workspaces/:id/transactions`                                  | p95 < 1 s, errors < 1%        |
| `import-parse.js` | Upload a generated 5,000-row CSV, then wait until the import is parsed | parse p95 < 10 s, errors < 1% |

NFR-07 sets the dashboard and import numbers. It has no number for the transaction list. The 1-second limit there is our
own, to catch regressions.

## What you need

A running API, a user, a workspace and an account. NFR-07 is about a workspace with **50,000 transactions**, so load one
first or the dashboard number means nothing.

| Variable       | Meaning                                                       |
| -------------- | ------------------------------------------------------------- |
| `BASE_URL`     | API origin. Default `http://host.docker.internal:4000`        |
| `AUTH_TOKEN`   | Bearer token. With `AUTH_MODE=dev`, use `dev:you@example.com` |
| `WORKSPACE_ID` | Workspace to read and import into                             |
| `ACCOUNT_ID`   | Account to import into (`import-parse.js` only)               |
| `VUS`          | Virtual users. Optional                                       |
| `DURATION`     | How long to run, for example `5m`. Optional                   |
| `IMPORTS`      | Number of imports in total (`import-parse.js` only). Optional |

## Run

```bash
docker run --rm -i \
  -e BASE_URL=http://host.docker.internal:4000 \
  -e AUTH_TOKEN=dev:load@example.com \
  -e WORKSPACE_ID=<uuid> \
  grafana/k6:0.54.0 run - < infra/load/dashboard.js
```

k6 exits with a non-zero code when a threshold fails.

`import-parse.js` writes real rows into the workspace and leaves the import batches uncommitted. Use a workspace you can
throw away. It measures from the upload to the batch leaving the parsing state, and needs a worker running. The API on
its own will time out.
