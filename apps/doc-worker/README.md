# Montra doc worker

Python worker that turns uploaded statements into grids for the import pipeline (Phase 2, IMP-05). It
consumes `doc.extract` jobs from the Postgres job queue (ADR-0011):

- **XLS**: legacy Excel workbooks, read with `xlrd`.
- **PDF**: digital PDF statements, read with `pdfplumber`.

CSV and XLSX are parsed by the Node worker. Scanned PDFs (no text layer) are refused with
`pdf.no_text_layer`; OCR arrives in Phase 3.

## Run

```bash
python3 -m venv apps/doc-worker/.venv
apps/doc-worker/.venv/bin/pip install -e "apps/doc-worker[dev]"
apps/doc-worker/.venv/bin/python -m montra_doc_worker      # or: montra-doc-worker
```

Tests, lint and typecheck (also wired into Turbo as `test`, `lint`, `typecheck`):

```bash
pnpm --filter @montra/doc-worker test        # pytest; queue tests need Postgres (see below)
pnpm --filter @montra/doc-worker lint        # ruff
pnpm --filter @montra/doc-worker typecheck   # mypy --strict
```

The scripts fail with an install hint when the Python dev dependencies are missing. They never skip silently.

## Environment

| Variable                                                                  | Default                                                      | Meaning                                                                                 |
| ------------------------------------------------------------------------- | ------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| `DATABASE_URL`                                                            | `postgres://montra_app:montra_app@localhost:5432/montra`     | App role, used to claim and finish jobs through the queue functions                     |
| `DATABASE_ADMIN_URL`                                                      | `postgres://montra_owner:montra_owner@localhost:5432/montra` | Tests only: sets up and inspects jobs, and applies migrations to an empty test database |
| `STORAGE_MODE`                                                            | `local`                                                      | `local` or `s3`                                                                         |
| `STORAGE_DIR`                                                             | `<repo>/.data/storage`                                       | Root for `local` mode; keys are relative paths below it                                 |
| `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_REGION` | —                                                            | `s3` mode (MinIO locally, S3 in production)                                             |
| `LOG_LEVEL`                                                               | `INFO`                                                       | Logs are JSON lines                                                                     |

## Queue behaviour

- **Claiming:** jobs are claimed with `app.dequeue_job('doc', worker_id)` (`FOR UPDATE SKIP LOCKED`). The worker
  wakes on `LISTEN montra_jobs`, polls every 5 s, and calls `app.requeue_stale_jobs()` every minute.
- **Success:** `app.complete_job(id, result)` stores the result. If the job has `then_job`, the follow-up is
  enqueued with `previousJobId` and `previousResult` (e.g. `doc.extract → import.parse`).
- **Permanent failures:** corrupt file, wrong type, no text layer, missing file or unsafe key. These call
  `app.fail_job(id, code, true)` and are not retried.
- **Transient failures:** storage or database problems call `app.fail_job(id, msg, false)`, which retries
  with backoff (30 s × 4ⁿ).
- **Shutdown:** SIGTERM or SIGINT finishes the current job, then exits.

## Contract

Payload of `doc.extract`:

```json
{ "workspaceId": "…", "fileId": "…", "storageKey": "ws/…/file.pdf", "fileName": "file.pdf", "mime": "application/pdf", "fileType": "xls" | "pdf" }
```

Result:

```json
{
  "kind": "grid",
  "sheets": [
    {
      "name": "Statement",
      "rows": [
        ["Date", "Description", "Amount", "Balance"],
        ["10/02/2026", "COFFEE SHOP", "-4.50", "995.50"]
      ]
    }
  ],
  "pages": 1,
  "textLayer": true,
  "statement": {
    "openingBalance": "$1,000.00",
    "closingBalance": "$1,234.56",
    "periodStart": "2026-10-01",
    "periodEnd": "2026-10-31",
    "accountLast4": "1234",
    "currency": "USD"
  }
}
```

The result follows these rules:

- **Cells:** every cell is a string, exactly as displayed. The Node importer parses numbers, dates and sign
  conventions.
- **XLS values:** numbers follow the cell's number format without float noise, and date cells become
  `YYYY-MM-DD`.
- **Fields:** XLS results have `pages: null` and `statement: null`.

### PDF extraction rules

1. Ruled tables come from `extract_tables`. Unruled statements are rebuilt from word positions, using the header
   line (Date / Description / Amount / Debit / Credit / Balance …) as column anchors. Right-aligned numbers snap
   to the nearest column edge.
2. A row starts with a date (`10/02`, `10/02/2026`, `2026-10-02`, `02.10.2026`, `Oct 02`, `02 Oct 2026`).
3. A line with no date and no amount, directly below a row, continues that row's description.
4. These are dropped: repeated headers, page footers (`Page 1 of 2`), lines repeated on several pages (the bank
   name and address), and balance lines. Balance lines populate `statement` instead.
5. The statement period is a date range on a line mentioning the period or statement. Numeric dates are read
   US-style unless the first part exceeds 12.

## Security

- **Input checks:** inputs are capped at 25 MB, and magic bytes must match `fileType`.
- **Storage keys:** absolute paths and `..` are rejected, and local paths are resolved and checked against the
  storage root.
- **No evaluation:** `xlrd` reads cached cell values only (formulas are never evaluated), and PDF content is
  never executed.
- **Container:** the image runs as a non-root user.
