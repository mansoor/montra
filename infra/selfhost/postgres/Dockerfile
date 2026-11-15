# PostgreSQL 16 with pgBackRest, for the self-hosted stack (ADR-0050 §7). Built by deploy.yml as `postgres` in GHCR:
#   docker build -t montra/postgres infra/selfhost/postgres
#
# pgBackRest archives the write-ahead log every 60 seconds and takes full and differential backups to an S3-compatible
# bucket at another provider, encrypted before they leave the server. Its settings that aren't secret are in
# pgbackrest.conf; the bucket's keys and the encryption passphrase come from /run/secrets at start (entrypoint.sh).
FROM postgres:16.11-bookworm@sha256:a2420e9555e2224583fe84d0bb3f0b967e69354ae3a0be55a9c14e251388c4eb
# From the PostgreSQL project's apt repository, which the base image already uses for PostgreSQL itself.
RUN apt-get update \
 && apt-get install -y --no-install-recommends pgbackrest \
 && rm -rf /var/lib/apt/lists/* \
 && install -d -o postgres -g postgres -m 0750 /etc/pgbackrest/conf.d /var/log/pgbackrest /var/spool/pgbackrest \
 && pgbackrest version
COPY pgbackrest.conf /etc/pgbackrest/pgbackrest.conf
COPY --chmod=755 entrypoint.sh /usr/local/bin/montra-postgres
ENTRYPOINT ["montra-postgres"]
CMD ["postgres"]
