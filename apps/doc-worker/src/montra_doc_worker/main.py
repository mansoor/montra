"""Entry point: `python -m montra_doc_worker` or `montra-doc-worker`."""

from __future__ import annotations

import logging

from .queue import Worker
from .settings import resolve_secret_files
from .storage import storage_from_env

DEFAULT_DSN = "postgres://montra_app:montra_app@localhost:5432/montra"


def main() -> None:
    env = resolve_secret_files()
    logging.basicConfig(
        level=env.get("LOG_LEVEL", "INFO"),
        format='{"t":"%(asctime)s","level":"%(levelname)s","logger":"%(name)s","msg":"%(message)s"}',
    )
    worker = Worker(env.get("DATABASE_URL", DEFAULT_DSN), storage_from_env(env))
    worker.install_signal_handlers()
    worker.run_forever()


if __name__ == "__main__":
    main()
