# Montra doc worker (XLS and digital PDF statement extraction). Build from the repository root:
#   docker build -f apps/doc-worker/Dockerfile -t montra/doc-worker .
FROM python:3.12-slim AS base

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app
COPY apps/doc-worker/pyproject.toml apps/doc-worker/README.md ./
COPY apps/doc-worker/src ./src
RUN pip install . \
 && useradd --system --uid 10001 --home /nonexistent --shell /usr/sbin/nologin montra

USER montra
ENV STORAGE_MODE=s3
ENTRYPOINT ["python", "-m", "montra_doc_worker"]
