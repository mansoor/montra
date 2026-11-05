# Production Kratos: the local config and templates baked in, with environment-specific values set through
# environment variables by Terraform (infra/terraform/modules/compute/kratos.tf).
# Build from this directory:
#   docker build -t montra/kratos infra/kratos
#
# Built from Ory's release tag, not `FROM oryd/kratos`: the newest release's image still has critical findings
# (pgx, the Go runtime), and its fixes are only on untagged master. See ADR-0021. When Ory ships a release that scans
# clean, go back to their image and delete the build stage.
FROM golang:1.26.10-alpine AS build
ARG KRATOS_VERSION=v26.2.0
ARG KRATOS_COMMIT=9d7085948039ffb8960160d4979f71527b5cf4d5
RUN apk add --no-cache git
WORKDIR /src
RUN git init -q . \
  && git fetch -q --depth 1 https://github.com/ory/kratos.git "refs/tags/${KRATOS_VERSION}" \
  && git checkout -q FETCH_HEAD \
  && test "$(git rev-parse HEAD)" = "${KRATOS_COMMIT}"
# Each version here is at or above the fix Trivy names. Go's checksum database verifies them.
RUN go get \
  github.com/go-jose/go-jose/v3@v3.0.5 \
  github.com/go-jose/go-jose/v4@v4.1.8 \
  github.com/jackc/pgx/v5@v5.12.0 \
  go.opentelemetry.io/otel@v1.47.0 \
  go.opentelemetry.io/otel/sdk@v1.47.0 \
  golang.org/x/crypto@v0.58.0 \
  golang.org/x/mod@v0.42.0 \
  golang.org/x/net@v0.62.0 \
  golang.org/x/text@v0.43.0 \
  google.golang.org/grpc@v1.85.0 \
  && go mod tidy
# No cgo means no SQLite, which only `dsn: memory` uses. Every environment sets DSN to Postgres.
# Without -buildvcs=false the changed go.mod stamps a "+dirty" version, and Trivy reads that as older than the release.
RUN CGO_ENABLED=0 go build -trimpath -buildvcs=false \
  -ldflags="-s -w -X github.com/ory/kratos/driver/config.Version=${KRATOS_VERSION} -X github.com/ory/kratos/driver/config.Commit=${KRATOS_COMMIT}" \
  -o /usr/bin/kratos .

FROM gcr.io/distroless/static-debian13:nonroot
COPY --from=build /usr/bin/kratos /usr/bin/kratos
COPY kratos.yml identity.schema.json /etc/config/kratos/
COPY templates /etc/config/kratos/templates
# Aurora requires TLS. `sslrootcert` in the DSN points here.
ADD --chmod=644 https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem /etc/config/kratos/rds-global-bundle.pem
USER 10000
EXPOSE 4433 4434
ENTRYPOINT ["kratos"]
CMD ["serve", "-c", "/etc/config/kratos/kratos.yml"]
