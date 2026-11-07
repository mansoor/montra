# Montra doc worker (XLS, digital PDF and scanned PDF statement extraction). Build from the repository root:
#   docker build -f apps/doc-worker/Dockerfile -t montra/doc-worker .
FROM python:3.12-slim@sha256:b18b261e1b4974b4f321451ad5251ded85abb22c2b8b262da527dda1d031ab30 AS build
ENV PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1
WORKDIR /src
COPY apps/doc-worker/pyproject.toml apps/doc-worker/README.md ./
COPY apps/doc-worker/src ./src
RUN python -m venv /opt/venv \
 && /opt/venv/bin/pip install .

FROM python:3.12-slim@sha256:b18b261e1b4974b4f321451ad5251ded85abb22c2b8b262da527dda1d031ab30 AS runtime
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PATH=/opt/venv/bin:$PATH \
    STORAGE_MODE=s3
# Tesseract reads scanned statements (ADR-0012 §9).
# The upgrade: the pinned base image still has apt 3.0.3 (CVE-2026-109518, fixed in 3.0.4) and zlib1g 1.3.1-1+b1
# (CVE-2026-76844, CVE-2026-85091, fixed in 1.3.1-1+deb13u1). Delete each once the base image has its fix.
RUN apt-get update \
 && apt-get install -y --no-install-recommends --only-upgrade apt libapt-pkg7.0 zlib1g \
 && apt-get install -y --no-install-recommends tesseract-ocr tesseract-ocr-eng \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --system --uid 10001 --home /nonexistent --shell /usr/sbin/nologin montra
# Aurora requires TLS. libpq reads this file through `sslrootcert` in the connection string.
RUN install -d -m 755 /etc/ssl/certs
# When AWS changes this bundle the build fails on the checksum, on purpose: check the new one came from AWS, then update it here
# and in the other Dockerfiles that download it.
ADD --chmod=644 --checksum=sha256:90a6f1a7978a1b1b096dca6c57511ca48d3b8cf052f8e704baf358f34ea2f21b https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem /etc/ssl/certs/rds-global-bundle.pem
COPY --from=build /opt/venv /opt/venv
USER montra
ENTRYPOINT ["python", "-m", "montra_doc_worker"]
