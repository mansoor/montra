# Montra doc worker (XLS, digital PDF and scanned PDF statement extraction). Build from the repository root:
#   docker build -f apps/doc-worker/Dockerfile -t montra/doc-worker .
FROM python:3.12-slim AS build
ENV PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1
WORKDIR /src
COPY apps/doc-worker/pyproject.toml apps/doc-worker/README.md ./
COPY apps/doc-worker/src ./src
RUN python -m venv /opt/venv \
 && /opt/venv/bin/pip install .

FROM python:3.12-slim AS runtime
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PATH=/opt/venv/bin:$PATH \
    STORAGE_MODE=s3
# Tesseract reads scanned statements (ADR-0012 §9).
# The upgrade: the base image still has apt 3.0.3 (CVE-2026-109518, fixed in 3.0.4). Delete it once the base image has the fix.
RUN apt-get update \
 && apt-get install -y --no-install-recommends --only-upgrade apt libapt-pkg7.0 \
 && apt-get install -y --no-install-recommends tesseract-ocr tesseract-ocr-eng \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --system --uid 10001 --home /nonexistent --shell /usr/sbin/nologin montra
# Aurora requires TLS. libpq reads this file through `sslrootcert` in the connection string.
RUN install -d -m 755 /etc/ssl/certs
ADD --chmod=644 https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem /etc/ssl/certs/rds-global-bundle.pem
COPY --from=build /opt/venv /opt/venv
USER montra
ENTRYPOINT ["python", "-m", "montra_doc_worker"]
