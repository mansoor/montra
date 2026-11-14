"""Settings from the environment, or from files (ADR-0050 §2).

Any setting ``NAME`` can be given as ``NAME_FILE``, a path to a file holding the value, the way Docker and
Kubernetes secrets arrive. Setting both is an error. Empty values count as not set, as ECS fills every secret
it's given.
"""

from __future__ import annotations

import os
from collections.abc import Mapping
from pathlib import Path

# Everything the worker reads. Secrets are the point, but any of them may come from a file.
SETTINGS = (
    "DATABASE_URL",
    "LOG_LEVEL",
    "STORAGE_MODE",
    "STORAGE_DIR",
    "S3_ENDPOINT",
    "S3_BUCKET",
    "S3_REGION",
    "S3_ACCESS_KEY",
    "S3_SECRET_KEY",
)


def resolve_secret_files(env: Mapping[str, str] | None = None) -> dict[str, str]:
    """Returns the environment with each ``NAME_FILE`` among SETTINGS read into ``NAME``."""
    source = os.environ if env is None else env
    out = {k: v for k, v in source.items() if v != ""}
    for name in SETTINGS:
        path = out.get(f"{name}_FILE")
        if not path:
            continue
        if name in out:
            raise RuntimeError(f"Set {name} or {name}_FILE, not both")
        try:
            value = Path(path).read_text(encoding="utf-8")
        except OSError as exc:
            raise RuntimeError(f"{name}_FILE: can't read {path} ({exc.strerror})") from exc
        # One trailing line break is dropped, since editors and `echo` add one.
        out[name] = value.removesuffix("\n").removesuffix("\r")
    return out
