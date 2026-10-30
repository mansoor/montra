"""Error types that decide whether a job is retried (transient) or failed for good (permanent)."""


class PermanentJobError(Exception):
    """The input can never succeed (corrupt file, wrong type, no text layer). Fails the job without retry."""

    def __init__(self, code: str, detail: str = "") -> None:
        super().__init__(f"{code}: {detail}" if detail else code)
        self.code = code
        self.detail = detail


class TransientJobError(Exception):
    """A temporary problem (storage or database unavailable). The queue retries with backoff."""
