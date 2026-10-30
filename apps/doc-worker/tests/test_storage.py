from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from montra_doc_worker.errors import PermanentJobError, TransientJobError
from montra_doc_worker.storage import MAX_BYTES, LocalStorage, S3Storage, storage_from_env


def test_local_reads_inside_the_root(tmp_path: Path) -> None:
    (tmp_path / "ws" / "f").mkdir(parents=True)
    (tmp_path / "ws" / "f" / "a.pdf").write_bytes(b"%PDF-1.7")
    assert LocalStorage(tmp_path).read("ws/f/a.pdf") == b"%PDF-1.7"


@pytest.mark.parametrize("key", ["../etc/passwd", "/etc/passwd", "ws/../../x", "ws//x", "", "ws\\x", "./x"])
def test_local_rejects_unsafe_keys(tmp_path: Path, key: str) -> None:
    with pytest.raises(PermanentJobError) as err:
        LocalStorage(tmp_path).read(key)
    assert err.value.code == "storage.bad_key"


def test_local_missing_and_oversized(tmp_path: Path) -> None:
    with pytest.raises(PermanentJobError) as err:
        LocalStorage(tmp_path).read("missing.pdf")
    assert err.value.code == "storage.not_found"
    big = tmp_path / "big.pdf"
    with big.open("wb") as fh:
        fh.truncate(MAX_BYTES + 1)
    with pytest.raises(PermanentJobError) as err:
        LocalStorage(tmp_path).read("big.pdf")
    assert err.value.code == "doc.too_large"


class StubBody:
    def __init__(self, data: bytes) -> None:
        self.data = data

    def read(self, n: int = -1) -> bytes:
        return self.data if n < 0 else self.data[:n]


class StubS3:
    def __init__(self, objects: dict[str, bytes], fail: Exception | None = None) -> None:
        self.objects = objects
        self.fail = fail
        self.calls: list[tuple[str, str, str]] = []

    def head_object(self, Bucket: str, Key: str) -> dict[str, Any]:
        self.calls.append(("head", Bucket, Key))
        if self.fail:
            raise self.fail
        if Key not in self.objects:
            err = Exception("not found")
            err.response = {"Error": {"Code": "404"}}  # type: ignore[attr-defined]
            raise err
        return {"ContentLength": len(self.objects[Key])}

    def get_object(self, Bucket: str, Key: str) -> dict[str, Any]:
        self.calls.append(("get", Bucket, Key))
        return {"Body": StubBody(self.objects[Key])}


def test_s3_reads_validate_and_map_errors() -> None:
    s3 = StubS3({"ws/a.pdf": b"%PDF-1.7"})
    storage = S3Storage(s3, "montra-files")
    assert storage.read("ws/a.pdf") == b"%PDF-1.7"
    assert s3.calls[0] == ("head", "montra-files", "ws/a.pdf")
    with pytest.raises(PermanentJobError) as err:
        storage.read("ws/missing.pdf")
    assert err.value.code == "storage.not_found"
    with pytest.raises(PermanentJobError):
        storage.read("../escape")
    with pytest.raises(TransientJobError):
        S3Storage(StubS3({}, fail=ConnectionError("timeout")), "b").read("ws/a.pdf")


def test_storage_from_env(tmp_path: Path) -> None:
    assert isinstance(storage_from_env({"STORAGE_DIR": str(tmp_path)}), LocalStorage)
    with pytest.raises(RuntimeError):
        storage_from_env({"STORAGE_MODE": "s3"})
    with pytest.raises(RuntimeError):
        storage_from_env({"STORAGE_MODE": "ftp"})
