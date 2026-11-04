# Observability files

Prometheus rules and Grafana dashboards for the SLOs in design 07 §7 (NFR-13, OPS-07). **These have not run against a
live API.** `promtool` has checked and unit-tested the rules against synthetic series, and the dashboards parse as JSON.

| Path                                      | What                                                                   |
| ----------------------------------------- | ---------------------------------------------------------------------- |
| `prometheus/prometheus.example.yml`       | Scrape config for `/internal/metrics`, with the bearer `METRICS_TOKEN` |
| `prometheus/rules/recording.yml`          | Availability, latency, queue and AI ratios                             |
| `prometheus/rules/alerts.yml`             | Alerts, with burn-rate paging for availability                         |
| `prometheus/tests/alerts.test.yml`        | `promtool test rules` unit tests                                       |
| `grafana/dashboards/slo.json`             | The five SLOs and their detail                                         |
| `grafana/dashboards/import-failures.json` | Import failures by institution and file type                           |
| `grafana/dashboards/ai-accuracy.json`     | Accepted ratio, error rate, outcomes by provider and task              |

Check them:

```bash
docker run --rm -v "$PWD/infra/observability/prometheus":/p --entrypoint promtool prom/prometheus:v2.53.0 check rules /p/rules/recording.yml /p/rules/alerts.yml
docker run --rm -v "$PWD/infra/observability/prometheus":/p -w /p/tests --entrypoint promtool prom/prometheus:v2.53.0 test rules alerts.test.yml
```

## SLOs

| SLO                              | Measured by                                                                        |
| -------------------------------- | ---------------------------------------------------------------------------------- |
| API availability 99.9%           | `montra_http_requests_total`: share of responses that aren't 5xx                   |
| Dashboard p95 < 2 s              | `montra_http_request_duration_seconds` on routes ending in `/dashboard`            |
| Import parse p95 < 10 s, 5k rows | **Not measured in production.** See below                                          |
| Queue lag p95 < 30 s             | `quantile_over_time` over the `montra_job_queue_lag_seconds` gauge, per queue      |
| AI task error rate < 2%          | `montra_ai_calls_total`: `provider_error` and `invalid_output` over all real calls |

## Assumptions about the metrics

The rules follow the metric names in the Phase 11 brief. These parts of the contract need checking against the API once
`/internal/metrics` exists:

- **`route` holds the route pattern**, such as `/v1/workspaces/:workspaceId/dashboard`, not the raw URL. A raw URL would
  have a workspace id in it and blow up the cardinality.
- **`status` holds the numeric code**, such as `503`.
- **`outcome` uses the values in `AiAuditEntry`:** `ok`, `cached`, `off`, `budget`, `invalid_output`, `provider_error` and
  `refused`. `off` and `budget` aren't real calls, so they are left out of the denominator. `refused` isn't counted as an
  error, because the provider worked.
- **Job and AI metrics reach this endpoint.** The worker is a separate process with no HTTP port, and jobs and most AI
  calls run there. The API's endpoint can only show them if they are stored somewhere shared, such as Postgres. If they
  live in the worker's memory, the job failure, AI and import metrics will read zero here, and every alert on them will
  stay silent.

## The import parse gap

The metrics contract has no histogram for parse time, so the 10-second SLO can't be alerted on. The dashboard shows
import queue lag and job failures as a proxy, and `infra/load/import-parse.js` measures the real number before a release.
Adding `montra_import_parse_duration_seconds` with a `rows` bucket would close this gap.
