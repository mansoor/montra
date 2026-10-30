"""Reads uploaded files from object storage: a local directory (development) or S3-compatible storage."""

from __future__ import annotations

import os
from pathlib import Path, PurePosixPath
from typing import Any, Protocol

from .errors import PermanentJobError, TransientJobError

MAX_BYTES = 25 * 1024 * 1024


class Storage(Protocol):
    def read(self, key: str) -> bytes: ...


def validate_key(key: str) -> str:
    """Rejects absolute paths, traversal and empty segments; returns the normalized key."""
    if not key or "\\" in key or "\x00" in key:
        raise PermanentJobError("storage.bad_key", "empty or invalid storage key")
    path = PurePosixPath(key)
    if path.is_absolute() or any(part in ("..", ".", "") for part in key.split("/")):
        raise PermanentJobError("storage.bad_key", "storage keys must be relative and must not contain '..'")
    return str(path)


class LocalStorage:
    def __init__(self, root: Path) -> None:
        self.root = root.resolve()

    def read(self, key: str) -> bytes:
        path = (self.root / validate_key(key)).resolve()
        if self.root not in path.parents:
            raise PermanentJobError("storage.bad_key", "storage key escapes the storage root")
        try:
            size = path.stat().st_size
        except FileNotFoundError as exc:
            raise PermanentJobError("storage.not_found", key) from exc
        except OSError as exc:
            raise TransientJobError(f"storage unavailable: {exc}") from exc
        if size > MAX_BYTES:
            raise PermanentJobError("doc.too_large", f"{size} bytes exceeds the 25 MB limit")
        return path.read_bytes()


class S3Storage:
    def __init__(self, client: Any, bucket: str) -> None:
        self.client = client
        self.bucket = bucket

    def read(self, key: str) -> bytes:
        key = validate_key(key)
        try:
            head = self.client.head_object(Bucket=self.bucket, Key=key)
        except Exception as exc:
            code = getattr(exc, "response", {}).get("Error", {}).get("Code", "")
            if code in ("404", "NoSuchKey", "NotFound"):
                raise PermanentJobError("storage.not_found", key) from exc
            raise TransientJobError(f"storage unavailable: {exc}") from exc
        if int(head.get("ContentLength", 0)) > MAX_BYTES:
            raise PermanentJobError("doc.too_large", "file exceeds the 25 MB limit")
        try:
            body: bytes = self.client.get_object(Bucket=self.bucket, Key=key)["Body"].read(MAX_BYTES + 1)
        except Exception as exc:
            raise TransientJobError(f"storage unavailable: {exc}") from exc
        if len(body) > MAX_BYTES:
            raise PermanentJobError("doc.too_large", "file exceeds the 25 MB limit")
        return body


def default_storage_dir() -> Path:
    # apps/doc-worker/src/montra_doc_worker/storage.py → repository root
    return Path(__file__).resolve().parents[4] / ".data" / "storage"


def storage_from_env(env: dict[str, str] | None = None) -> Storage:
    env = dict(os.environ) if env is None else env
    mode = env.get("STORAGE_MODE", "local")
    if mode == "local":
        return LocalStorage(Path(env.get("STORAGE_DIR") or default_storage_dir()))
    if mode == "s3":
        import boto3  # imported lazily: only S3 deployments need it

        client = boto3.client(
            "s3",
            endpoint_url=env.get("S3_ENDPOINT") or None,
            aws_access_key_id=env.get("S3_ACCESS_KEY"),
            aws_secret_access_key=env.get("S3_SECRET_KEY"),
            region_name=env.get("S3_REGION", "us-east-1"),
        )
        bucket = env.get("S3_BUCKET")
        if not bucket:
            raise RuntimeError("S3_BUCKET is required when STORAGE_MODE=s3")
        return S3Storage(client, bucket)
    raise RuntimeError(f"unknown STORAGE_MODE: {mode}")
