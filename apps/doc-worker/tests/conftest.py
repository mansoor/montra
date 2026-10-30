"""Test database setup: applies the repository's SQL migrations to an empty database.

The bookkeeping matches the Node runner (`public.schema_migrations` with the SHA-256 of each file), so a
database prepared here stays compatible with `pnpm db:migrate`.
"""

from __future__ import annotations

import hashlib
import os
import re
from pathlib import Path

import psycopg
import pytest

MIGRATIONS = Path(__file__).resolve().parents[3] / "packages" / "db" / "migrations"
ADMIN_URL = os.environ.get("DATABASE_ADMIN_URL", "postgres://montra_owner:montra_owner@localhost:5432/montra")


def apply_migrations(dsn: str) -> list[str]:
    applied: list[str] = []
    with psycopg.connect(dsn, autocommit=True) as conn:
        conn.execute("select pg_advisory_lock(727465)")  # same lock as the Node migration runner
        conn.execute(
            """create table if not exists public.schema_migrations (
                 version integer primary key, name text not null, checksum text not null,
                 applied_at timestamptz not null default now())"""
        )
        done = {row[0] for row in conn.execute("select version from public.schema_migrations").fetchall()}
        for path in sorted(MIGRATIONS.glob("*.sql")):
            m = re.fullmatch(r"(\d{4})_([a-z0-9_]+)\.sql", path.name)
            if not m or int(m.group(1)) in done:
                continue
            sql = path.read_text(encoding="utf-8")
            with conn.transaction():
                # No parameters → psycopg sends the script as-is (multiple statements, $$ bodies, literal %).
                conn.execute(sql)  # type: ignore[call-overload]
                conn.execute(
                    "insert into public.schema_migrations (version, name, checksum) values (%s, %s, %s)",
                    (int(m.group(1)), m.group(2), hashlib.sha256(sql.encode()).hexdigest()),
                )
            applied.append(path.name)
    return applied


@pytest.fixture(scope="session")
def migrated_database() -> None:
    """Brings the test database up to date once per session; a no-op on an already migrated database."""
    try:
        apply_migrations(ADMIN_URL)
    except psycopg.OperationalError as exc:
        pytest.fail(f"Postgres is required for doc-worker tests ({ADMIN_URL}): {exc}")
