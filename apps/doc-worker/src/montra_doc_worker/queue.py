"""Postgres job-queue consumer (ADR-0011): claim with SKIP LOCKED, wake on LISTEN, retry via fail_job."""

from __future__ import annotations

import json
import logging
import os
import select
import signal
import socket
import time
import uuid
from collections.abc import Callable
from typing import Any

import psycopg
from psycopg.rows import dict_row

from .errors import PermanentJobError, TransientJobError
from .extract_pdf import extract_pdf
from .extract_xls import extract_xls
from .result import GridResult, OcrTextResult, check_magic
from .storage import Storage

log = logging.getLogger("montra.doc_worker")

QUEUE = "doc"
CHANNEL = "montra_jobs"
POLL_SECONDS = 5.0
REQUEUE_EVERY_SECONDS = 60.0

Handler = Callable[[dict[str, Any], Storage], GridResult | OcrTextResult]


def handle_doc_extract(payload: dict[str, Any], storage: Storage) -> GridResult | OcrTextResult:
    key = payload.get("storageKey")
    file_type = payload.get("fileType")
    if not isinstance(key, str) or not isinstance(file_type, str):
        raise PermanentJobError("doc.bad_payload", "storageKey and fileType are required")
    data = storage.read(key)
    kind = check_magic(data, file_type)
    return extract_xls(data) if kind == "xls" else extract_pdf(data)


HANDLERS: dict[str, Handler] = {"doc.extract": handle_doc_extract}


class Worker:
    def __init__(self, dsn: str, storage: Storage, worker_id: str | None = None) -> None:
        self.dsn = dsn
        self.storage = storage
        self.worker_id = worker_id or f"doc-{socket.gethostname()}-{os.getpid()}-{uuid.uuid4().hex[:6]}"
        self.stopping = False
        self._last_requeue = 0.0

    # -- lifecycle --------------------------------------------------------------------------------------

    def install_signal_handlers(self) -> None:
        def stop(signum: int, _frame: object) -> None:
            log.info("received signal %s; finishing the current job and stopping", signum)
            self.stopping = True

        signal.signal(signal.SIGTERM, stop)
        signal.signal(signal.SIGINT, stop)

    def run_forever(self) -> None:
        """Main loop. Reconnects with backoff when the database goes away."""
        backoff = 1.0
        while not self.stopping:
            try:
                with psycopg.connect(self.dsn, autocommit=True, row_factory=dict_row) as conn:
                    conn.execute(f"LISTEN {CHANNEL}")
                    log.info("doc worker %s listening on %s", self.worker_id, CHANNEL)
                    backoff = 1.0
                    while not self.stopping:
                        self._maybe_requeue(conn)
                        if self.run_once(conn):
                            continue  # more work may be waiting
                        self._wait(conn)
            except psycopg.OperationalError as exc:
                log.warning("database unavailable (%s); retrying in %.0fs", exc, backoff)
                time.sleep(backoff)
                backoff = min(backoff * 2, 30.0)

    def _wait(self, conn: psycopg.Connection[Any]) -> None:
        """Sleeps until a notification for our queue arrives or the poll interval passes."""
        deadline = time.monotonic() + POLL_SECONDS
        while not self.stopping:
            timeout = deadline - time.monotonic()
            if timeout <= 0:
                return
            ready, _, _ = select.select([conn.fileno()], [], [], min(timeout, 1.0))
            if ready:
                for note in conn.notifies(timeout=0, stop_after=50):
                    if note.payload == QUEUE:
                        return

    def _maybe_requeue(self, conn: psycopg.Connection[Any]) -> None:
        now = time.monotonic()
        if now - self._last_requeue >= REQUEUE_EVERY_SECONDS:
            self._last_requeue = now
            row = conn.execute("select app.requeue_stale_jobs() as n").fetchone()
            if row and row["n"]:
                log.warning("requeued %s stale job(s)", row["n"])

    # -- one job ----------------------------------------------------------------------------------------

    def run_once(self, conn: psycopg.Connection[Any]) -> bool:
        """Claims and processes one job. Returns False when the queue is empty."""
        job = conn.execute("select * from app.dequeue_job(%s, %s)", (QUEUE, self.worker_id)).fetchone()
        if not job or job.get("id") is None:
            return False
        job_id = job["id"]
        handler = HANDLERS.get(job["type"])
        log.info("job %s (%s) attempt %s", job_id, job["type"], job["attempts"])
        try:
            if handler is None:
                raise PermanentJobError("job.unknown_type", str(job["type"]))
            conn.execute("select app.job_progress(%s, %s)", (job_id, 10))
            result = handler(job["payload"] or {}, self.storage)
            conn.execute("select app.complete_job(%s, %s::jsonb)", (job_id, json.dumps(result)))
            log.info("job %s succeeded", job_id)
        except PermanentJobError as exc:
            log.warning("job %s failed permanently: %s", job_id, exc)
            conn.execute("select app.fail_job(%s, %s, true)", (job_id, str(exc)))
        except (TransientJobError, OSError) as exc:
            log.warning("job %s failed, will retry: %s", job_id, exc)
            conn.execute("select app.fail_job(%s, %s, false)", (job_id, str(exc)))
        except Exception as exc:  # unexpected bug: retry a few times, then the queue marks it failed
            log.exception("job %s crashed", job_id)
            conn.execute(
                "select app.fail_job(%s, %s, false)", (job_id, f"doc.internal: {type(exc).__name__}")
            )
        return True
