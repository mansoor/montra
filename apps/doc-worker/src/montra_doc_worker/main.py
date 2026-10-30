"""Entry point: `python -m montra_doc_worker` or `montra-doc-worker`."""

from __future__ import annotations

import logging
import os

from .queue import Worker
from .storage import storage_from_env

DEFAULT_DSN = "postgres://montra_app:montra_app@localhost:5432/montra"


def main() -> None:
    logging.basicConfig(
        level=os.environ.get("LOG_LEVEL", "INFO"),
        format='{"t":"%(asctime)s","level":"%(levelname)s","logger":"%(name)s","msg":"%(message)s"}',
    )
    worker = Worker(os.environ.get("DATABASE_URL", DEFAULT_DSN), storage_from_env())
    worker.install_signal_handlers()
    worker.run_forever()


if __name__ == "__main__":
    main()
