# ADR-0011: Postgres job queue instead of BullMQ/Redis

- Status: accepted (supersedes the BullMQ choice in 02 §6)
- Date: 2026-10-30

## Context
Phase 2 needs background jobs (import parsing, commit and undo, document extraction), consumed by a Node
worker and by the Python doc worker (pdfplumber, xlrd). BullMQ is Node-only, and Redis would be one more
stateful service to run, back up and secure. ADR-0008 already uses Postgres LISTEN/NOTIFY for fan-out.

## Decision
`app.job` is the queue:
- **Dequeue:** `app.dequeue_job(queue, worker)` uses `FOR UPDATE SKIP LOCKED`.
- **Wake-ups:** inserts fire `pg_notify('montra_jobs', queue)`, so idle workers wake at once and otherwise poll.
- **Finishing:** `complete_job` stores the result and enqueues an optional follow-up (`then_job`), used for chains
  such as `doc.extract → import.parse`. `fail_job` retries with exponential backoff (30 s × 4ⁿ) up to
  `max_attempts`, or fails permanently.
- **Recovery:** `requeue_stale_jobs` recovers jobs from crashed workers.
- **Workspace scope:** jobs carry `workspace_id`, and handlers run inside the same RLS unit of work as API
  requests. Members can read their workspace's jobs for progress.

## Consequences
- **One store:** jobs are enqueued in the same transaction as the data that needs them (e.g. the import batch), so
  there are no lost or orphaned jobs.
- **Polyglot:** any language with a Postgres driver can be a worker.
- **Throughput:** comfortably handles thousands of jobs per minute, which covers R1. If queue volume outgrows
  Postgres, the definer-function interface lets us swap in SQS or BullMQ behind the same worker API.
- **Redis** stays optional (rate limits and caches, P3+), not required.
