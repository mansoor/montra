"""Runs the worker against the real Postgres queue (migration 0006).

Uses DATABASE_URL (app role) for the worker and DATABASE_ADMIN_URL (owner role) to set up and inspect jobs.
Jobs are inserted with a very high priority so this test claims its own jobs first even on a shared dev DB.
"""

from __future__ import annotations

import json
import os
import uuid
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import psycopg
import pytest
from psycopg.rows import dict_row

from montra_doc_worker.queue import Worker
from montra_doc_worker.storage import LocalStorage

from . import fixtures

APP_URL = os.environ.get("DATABASE_URL", "postgres://montra_app:montra_app@localhost:5432/montra")
ADMIN_URL = os.environ.get("DATABASE_ADMIN_URL", "postgres://montra_owner:montra_owner@localhost:5432/montra")


@pytest.fixture
def admin(migrated_database: None) -> Iterator[psycopg.Connection[Any]]:
    try:
        conn = psycopg.connect(ADMIN_URL, autocommit=True, row_factory=dict_row)
    except psycopg.OperationalError as exc:
        pytest.fail(f"Postgres is required for queue tests ({ADMIN_URL}): {exc}")
    with conn:
        has_queue = conn.execute(
            "select to_regprocedure('app.dequeue_job(text,text)') is not null as ok"
        ).fetchone()
        if not has_queue or not has_queue["ok"]:
            pytest.fail("migration 0006 (job queue) is not applied; run `pnpm db:migrate`")
        yield conn


def enqueue(
    admin: psycopg.Connection[Any], payload: dict[str, Any], *, then_job: dict[str, Any] | None = None
) -> str:
    job_id = str(uuid.uuid4())
    admin.execute(
        """insert into app.job (id, workspace_id, queue, type, payload, priority, max_attempts, then_job)
           values (%s, null, 'doc', 'doc.extract', %s::jsonb, 1000000, 2, %s::jsonb)""",
        (job_id, json.dumps(payload), json.dumps(then_job) if then_job else None),
    )
    return job_id


def job(admin: psycopg.Connection[Any], job_id: str) -> dict[str, Any]:
    row = admin.execute("select * from app.job where id = %s", (job_id,)).fetchone()
    assert row is not None
    return row


def run_until_done(worker: Worker, admin: psycopg.Connection[Any], job_id: str) -> dict[str, Any]:
    with psycopg.connect(APP_URL, autocommit=True, row_factory=dict_row) as conn:
        for _ in range(20):
            if not worker.run_once(conn):
                break
            if job(admin, job_id)["status"] != "queued":
                break
    return job(admin, job_id)


@pytest.fixture
def cleanup(admin: psycopg.Connection[Any]) -> Iterator[list[str]]:
    ids: list[str] = []
    yield ids
    admin.execute(
        "delete from app.job where id = any(%s::uuid[]) or (payload ->> 'previousJobId') = any(%s)",
        (ids, ids),
    )


def test_processes_an_xls_job_and_enqueues_the_follow_up(
    admin: psycopg.Connection[Any], tmp_path: Path, cleanup: list[str]
) -> None:
    (tmp_path / "ws1").mkdir()
    (tmp_path / "ws1" / "statement.xls").write_bytes(fixtures.make_xls())
    follow_up = {"queue": "import", "type": "import.parse", "payload": {"batchId": "b-1"}}
    payload = {"storageKey": "ws1/statement.xls", "fileType": "xls", "fileName": "statement.xls"}
    job_id = enqueue(admin, payload,
                     then_job=follow_up)  # fmt: skip
    cleanup.append(job_id)

    done = run_until_done(Worker(APP_URL, LocalStorage(tmp_path), "test-worker"), admin, job_id)

    assert done["status"] == "succeeded", done["error"]
    assert done["progress"] == 100
    result = done["result"]
    assert result["kind"] == "grid" and result["textLayer"] is True and result["pages"] is None
    assert result["sheets"][0]["rows"][0] == ["Date", "Description", "Amount", "Balance", "Count"]
    chained = admin.execute(
        "select * from app.job where payload ->> 'previousJobId' = %s", (job_id,)
    ).fetchone()
    assert chained is not None
    assert (chained["queue"], chained["type"], chained["payload"]["batchId"]) == (
        "import",
        "import.parse",
        "b-1",
    )
    assert chained["payload"]["previousResult"]["kind"] == "grid"


def test_permanent_errors_fail_without_retry(
    admin: psycopg.Connection[Any], tmp_path: Path, cleanup: list[str]
) -> None:
    (tmp_path / "scan.pdf").write_bytes(fixtures.make_scanned_like_pdf())
    job_id = enqueue(admin, {"storageKey": "scan.pdf", "fileType": "pdf"})
    cleanup.append(job_id)
    done = run_until_done(Worker(APP_URL, LocalStorage(tmp_path), "test-worker"), admin, job_id)
    assert done["status"] == "failed"
    assert done["attempts"] == 1
    assert done["error"].startswith("pdf.no_text_layer")


def test_transient_errors_are_retried_with_backoff(
    admin: psycopg.Connection[Any], tmp_path: Path, cleanup: list[str]
) -> None:
    class FlakyStorage:
        def read(self, key: str) -> bytes:
            raise OSError("storage timeout")

    job_id = enqueue(admin, {"storageKey": "x.pdf", "fileType": "pdf"})
    cleanup.append(job_id)
    with psycopg.connect(APP_URL, autocommit=True, row_factory=dict_row) as conn:
        assert Worker(APP_URL, FlakyStorage(), "test-worker").run_once(conn)
    row = job(admin, job_id)
    assert row["status"] == "queued"
    assert row["error"] == "storage timeout"
    assert row["run_after"] > row["updated_at"]  # backed off, not immediately runnable
