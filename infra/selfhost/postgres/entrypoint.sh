#!/usr/bin/env bash
# Starts PostgreSQL with pgBackRest set up from the environment and /run/secrets (ADR-0050 §7).
#
#   postgres …        the server. With BACKUP_S3_BUCKET set, the WAL is archived (archive_timeout 60 s), unless
#                     BACKUP_ARCHIVE=off, which a restore drill uses so it never writes into the real repository.
#   pgbackrest …      pgBackRest as the postgres user, e.g. a restore into an empty volume.
#
# pgBackRest has no _FILE settings, so the bucket's keys and the passphrase are written to a file only postgres can
# read, inside the container. `docker compose exec postgres pgbackrest …` reads it too.
#
# The image runs as postgres. Started as root anyway (`-u root`), it still writes that file for postgres and runs
# pgBackRest as postgres, and docker-entrypoint.sh drops to postgres itself.
set -euo pipefail

CONF=/etc/pgbackrest/conf.d/repo.conf
if [ "$(id -u)" = 0 ]; then
  AS_POSTGRES=(gosu postgres)
  CONF_OWNER=(-o postgres -g postgres)
else
  AS_POSTGRES=()
  CONF_OWNER=()
fi

secret() { # the first line of /run/secrets/<name>, or nothing
  local file="/run/secrets/$1"
  [ -r "$file" ] || return 0
  head -n 1 "$file" | tr -d '\r'
}

write_repo_conf() {
  [ -n "${BACKUP_S3_BUCKET:-}" ] || return 1
  local endpoint host port
  endpoint=${BACKUP_S3_ENDPOINT:?BACKUP_S3_ENDPOINT is required with BACKUP_S3_BUCKET}
  endpoint=${endpoint#https://}
  endpoint=${endpoint%%/*}
  host=${endpoint%%:*}
  port=443
  [ "$host" = "$endpoint" ] || port=${endpoint##*:}
  for name in backup_s3_access_key backup_s3_secret_key backup_cipher_pass; do
    [ -n "$(secret "$name")" ] || {
      echo "montra-postgres: /run/secrets/$name is empty; backups need it" >&2
      return 2
    }
  done
  install "${CONF_OWNER[@]}" -m 0600 /dev/null "$CONF"
  {
    echo "[global]"
    echo "repo1-s3-endpoint=$host"
    echo "repo1-storage-port=$port"
    echo "repo1-s3-bucket=$BACKUP_S3_BUCKET"
    echo "repo1-s3-region=${BACKUP_S3_REGION:-auto}"
    echo "repo1-s3-uri-style=${BACKUP_S3_URI_STYLE:-path}"
    echo "repo1-s3-key=$(secret backup_s3_access_key)"
    echo "repo1-s3-key-secret=$(secret backup_s3_secret_key)"
    echo "repo1-cipher-pass=$(secret backup_cipher_pass)"
  } >"$CONF"
}

case ${1:-postgres} in
  postgres)
    status=0
    write_repo_conf || status=$?
    if [ "$status" = 2 ]; then exit 1; fi
    if [ "$status" = 1 ]; then
      echo "montra-postgres: BACKUP_S3_BUCKET isn't set, so the WAL isn't archived and there are no backups." >&2
    elif [ "${BACKUP_ARCHIVE:-on}" = off ]; then
      echo "montra-postgres: BACKUP_ARCHIVE=off: the repository is readable, but nothing is archived to it." >&2
    else
      set -- "$@" -c archive_mode=on -c "archive_command=pgbackrest --stanza=montra archive-push %p" \
        -c archive_timeout=60
    fi
    exec docker-entrypoint.sh "$@"
    ;;
  pgbackrest)
    write_repo_conf || {
      echo "montra-postgres: set BACKUP_S3_ENDPOINT, BACKUP_S3_BUCKET and the backup secrets first" >&2
      exit 1
    }
    exec "${AS_POSTGRES[@]}" "$@"
    ;;
  *)
    exec docker-entrypoint.sh "$@"
    ;;
esac
