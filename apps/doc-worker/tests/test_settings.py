from __future__ import annotations

from pathlib import Path

import pytest

from montra_doc_worker.settings import resolve_secret_files
from montra_doc_worker.storage import LocalStorage, storage_from_env


def test_reads_name_file_into_name(tmp_path: Path) -> None:
    (tmp_path / "db").write_text("postgres://montra_app@db/montra\n", encoding="utf-8")
    (tmp_path / "s3").write_bytes(b"secret-key\r\n")
    env = resolve_secret_files(
        {
            "DATABASE_URL_FILE": str(tmp_path / "db"),
            "S3_SECRET_KEY_FILE": str(tmp_path / "s3"),
            "LOG_LEVEL": "",
        }
    )
    assert env["DATABASE_URL"] == "postgres://montra_app@db/montra"
    assert env["S3_SECRET_KEY"] == "secret-key"
    # Empty means not set, as ECS fills every secret it's given.
    assert "LOG_LEVEL" not in env


def test_refuses_both_and_names_an_unreadable_file(tmp_path: Path) -> None:
    (tmp_path / "db").write_text("x", encoding="utf-8")
    with pytest.raises(RuntimeError, match="DATABASE_URL or DATABASE_URL_FILE, not both"):
        resolve_secret_files({"DATABASE_URL": "y", "DATABASE_URL_FILE": str(tmp_path / "db")})
    with pytest.raises(RuntimeError, match="S3_ACCESS_KEY_FILE: can't read"):
        resolve_secret_files({"S3_ACCESS_KEY_FILE": str(tmp_path / "missing")})


def test_storage_settings_can_come_from_files(tmp_path: Path) -> None:
    (tmp_path / "dir").write_text(str(tmp_path / "files"), encoding="utf-8")
    storage = storage_from_env({"STORAGE_MODE": "local", "STORAGE_DIR_FILE": str(tmp_path / "dir")})
    assert isinstance(storage, LocalStorage)
    assert storage.root == (tmp_path / "files").resolve()
