# ADR-0021: Build Kratos from its release tag with patched dependencies

- Status: proposed
- Date: 2026-11-04

## Context

Kratos v1.3.1 had 89 high or critical Trivy findings, and OPS-06 asks for criticals to be fixed within 72 hours. The newest
release, v26.2.0 (March 2026), doesn't get there. Scanned on 2026-11-04 with `--severity HIGH,CRITICAL --ignore-unfixed`:

| Image                                              | Critical | High |
| -------------------------------------------------- | -------- | ---- |
| `oryd/kratos:v1.3.1`                               | 6        | 83   |
| `oryd/kratos:v25.4.0`                              | 6        | 71   |
| `oryd/kratos:v26.2.0`                              | 4        | 65   |
| `oryd/kratos:v26.2.0-distroless`                   | 2        | 54   |
| `infra/kratos/Dockerfile` (v26.2.0, built here)    | 0        | 0    |

The two criticals left in the distroless image are in `pgx`, the driver Kratos uses for every Postgres connection. Ory has
commits after v26.2.0 on `master`, up to July 2026, but no newer tag.

## Decision

`infra/kratos/Dockerfile` builds the v26.2.0 tag from source: it checks the tag still points at the expected commit, raises the
vulnerable modules with `go get`, builds with a patched Go 1.26 and no cgo, and copies the binary onto
`gcr.io/distroless/static-debian13`. Local Compose builds the same image, so what is tested locally is what ships.

Kratos' own code isn't changed. Only module versions and the Go toolchain differ from Ory's release.

Also set `secrets.pagination` (`KRATOS_PAGINATION_SECRET`), as CVE-2026-33503 tells operators to. Unset, Kratos uses a publicly
known default for its pagination tokens.

## Consequences

- We own a build Ory doesn't test. Their test suite has not been run against these module versions. `scripts/kratos-smoke.mjs`
  checks the flows Montra uses, and has to be run after every rebuild.
- Findings no longer go away by bumping an image tag. When Trivy reports a Kratos module, raise it in the Dockerfile. Renovate
  raises the Go image and `KRATOS_VERSION` (and then `KRATOS_COMMIT` needs changing by hand), but not the module list.
- SQLite is gone from the binary, so `dsn: memory` no longer starts. Nothing uses it: every environment sets `DSN`.
- The image has no shell, so debugging needs `docker cp` or a debug sidecar. Nothing in Terraform or Compose runs a command in it.
- Deploys and the `security.yml` image job get slower, because Kratos compiles on each uncached build (about 4 minutes here).
- **Remove this when Ory ships a release that scans clean:** go back to `FROM oryd/kratos:<version>-distroless` and drop the build
  stage.

Four high findings have no fix available from their maintainers, so `--ignore-unfixed` doesn't fail on them. They're accepted for
now, and looked at again each monthly round:

| Finding                            | Module                               | Why it doesn't apply                                                                                                                                                 |
| ---------------------------------- | ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CVE-2026-41567, CVE-2026-42306     | `github.com/docker/docker` v28.3.3   | Bugs in the Docker daemon's `docker cp`. Only API type packages are linked, through a test helper in `ory/x`. No daemon code is in the binary, and no daemon is reachable. |
| CVE-2026-116587                    | `github.com/go-jose/go-jose/v3` v3.0.5 | Slow validation of crafted RSA keys in untrusted JWKs. v3 is linked only by `ory/x/jwksx`, for JWK URLs in the operator's config. Fixed in v4, which is on 4.1.8. Reaching it would take a hostile URL we configured ourselves. |
| CVE-2026-32286                     | `github.com/jackc/pgproto3/v2` v2.3.3 | A crash on a malformed reply from a malicious Postgres server. Linked through `pgconn` v1, which `ory/x/popx` imports. Connections use `pgx/v5`, and the server is our own Aurora over `verify-full`. |

## Alternatives considered

- **Ory's v26.2.0 image.** Fails the OPS-06 bar, with criticals in the database driver.
- **Accepting the findings in writing.** Not reasonable for a memory-safety bug on the path to the identity database when a fix
  exists.
- **An untagged `master` build.** It would carry unreleased behaviour changes into authentication, not just dependency fixes.
- **Ory Network.** ADR-0006 allows it, but moving identity to a managed service is a far bigger decision than this finding.
