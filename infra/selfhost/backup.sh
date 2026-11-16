#!/usr/bin/env bash
# Backups for the self-hosted stack (ADR-0050 §7). Run from cron as root (docs/runbooks/selfhost-backups.md):
#
#   ./backup.sh init          once: creates pgBackRest's stanza in the backup bucket, then a first full backup
#   ./backup.sh db full|diff  a full or differential database backup (the WAL is archived continuously anyway)
#   ./backup.sh files         copies the files bucket to the backup bucket at a second provider (rclone sync)
#   ./backup.sh status        writes backup ages for Prometheus (node-exporter's textfile collector)
#   ./backup.sh info          what pgBackRest holds
#
# Each run writes its result to metrics/montra_backup.prom, which the `monitoring` profile turns into alerts.
set -euo pipefail
umask 077
cd "$(dirname "$0")"

METRICS_DIR=${METRICS_DIR:-./metrics}
RCLONE_IMAGE=rclone/rclone:1.71.2@sha256:3103526c506266a9ecdf064efe99bf3677d92ef6407af124d8c56b4f49cbaa51
PG=(docker compose exec -T -u postgres postgres)

env_value() { sed -n "s/^$1=//p" .env | tail -n 1; }
secret() { head -n 1 "secrets/$1" | tr -d '\r'; }
now() { date +%s; }

# record <metric> <labels> <value>: replaces that series in the textfile, atomically.
record() {
  local file="$METRICS_DIR/montra_backup.prom" tmp series=$1
  [ -z "$2" ] || series="$1{$2}"
  install -d -m 0755 "$METRICS_DIR"
  tmp=$(mktemp "$METRICS_DIR/.prom.XXXXXX")
  { [ -f "$file" ] && grep -v -F "$series " "$file" || true; } >"$tmp"
  echo "$series $3" >>"$tmp"
  chmod 0644 "$tmp"
  mv "$tmp" "$file"
}

db_backup() {
  local type=$1
  "${PG[@]}" pgbackrest --stanza=montra --type="$type" backup
  record montra_backup_last_success_timestamp_seconds "kind=\"db_$type\"" "$(now)"
  # A full backup also counts as the latest differential.
  [ "$type" = full ] && record montra_backup_last_success_timestamp_seconds 'kind="db_diff"' "$(now)"
  return 0
}

files_backup() {
  local endpoint bucket
  endpoint=$(env_value FILES_BACKUP_S3_ENDPOINT)
  bucket=$(env_value FILES_BACKUP_S3_BUCKET)
  [ -n "$endpoint" ] && [ -n "$bucket" ] || {
    echo "Set FILES_BACKUP_S3_ENDPOINT and FILES_BACKUP_S3_BUCKET in .env" >&2
    exit 1
  }
  # rclone reads its remotes from the environment; the keys go in that way, never on a command line.
  export RCLONE_CONFIG_SRC_TYPE=s3 RCLONE_CONFIG_SRC_PROVIDER=Other
  RCLONE_CONFIG_SRC_ENDPOINT=$(env_value S3_ENDPOINT)
  RCLONE_CONFIG_SRC_REGION=$(env_value S3_REGION)
  RCLONE_CONFIG_SRC_ACCESS_KEY_ID=$(secret s3_access_key)
  RCLONE_CONFIG_SRC_SECRET_ACCESS_KEY=$(secret s3_secret_key)
  export RCLONE_CONFIG_SRC_ENDPOINT RCLONE_CONFIG_SRC_REGION RCLONE_CONFIG_SRC_ACCESS_KEY_ID RCLONE_CONFIG_SRC_SECRET_ACCESS_KEY
  export RCLONE_CONFIG_DST_TYPE=s3 RCLONE_CONFIG_DST_PROVIDER=Other
  RCLONE_CONFIG_DST_ENDPOINT=$endpoint
  RCLONE_CONFIG_DST_REGION=$(env_value FILES_BACKUP_S3_REGION)
  RCLONE_CONFIG_DST_ACCESS_KEY_ID=$(secret files_backup_access_key)
  RCLONE_CONFIG_DST_SECRET_ACCESS_KEY=$(secret files_backup_secret_key)
  export RCLONE_CONFIG_DST_ENDPOINT RCLONE_CONFIG_DST_REGION RCLONE_CONFIG_DST_ACCESS_KEY_ID RCLONE_CONFIG_DST_SECRET_ACCESS_KEY
  # The backup bucket keeps old versions for 30 days (its lifecycle rule), so a deleted or overwritten file can still
  # be brought back for that long.
  docker run --rm --network "${RCLONE_NETWORK:-bridge}" \
    -e RCLONE_CONFIG_SRC_TYPE -e RCLONE_CONFIG_SRC_PROVIDER -e RCLONE_CONFIG_SRC_ENDPOINT -e RCLONE_CONFIG_SRC_REGION \
    -e RCLONE_CONFIG_SRC_ACCESS_KEY_ID -e RCLONE_CONFIG_SRC_SECRET_ACCESS_KEY \
    -e RCLONE_CONFIG_DST_TYPE -e RCLONE_CONFIG_DST_PROVIDER -e RCLONE_CONFIG_DST_ENDPOINT -e RCLONE_CONFIG_DST_REGION \
    -e RCLONE_CONFIG_DST_ACCESS_KEY_ID -e RCLONE_CONFIG_DST_SECRET_ACCESS_KEY \
    "$RCLONE_IMAGE" sync "src:$(env_value S3_BUCKET)" "dst:$bucket" --checksum --fast-list --stats-one-line -v
  record montra_backup_last_success_timestamp_seconds 'kind="files"' "$(now)"
}

status() {
  local info
  # The newest full and differential backups pgBackRest holds, and whether the WAL is being archived.
  info=$("${PG[@]}" pgbackrest --stanza=montra --output=json info)
  for type in full diff; do
    local stop
    stop=$(printf '%s' "$info" | jq -r --arg t "$type" \
      '[.[0].backup[] | select(.type == $t or ($t == "diff" and .type == "full")) | .timestamp.stop] | max // 0')
    record montra_backup_newest_timestamp_seconds "kind=\"db_$type\"" "$stop"
  done
  local archiver
  archiver=$("${PG[@]}" psql -At -d montra -c \
    "select coalesce(extract(epoch from last_archived_time), 0)::bigint || ' ' || coalesce(extract(epoch from last_failed_time), 0)::bigint || ' ' || failed_count from pg_stat_archiver")
  read -r archived failed failed_count <<<"$archiver"
  record montra_wal_last_archived_timestamp_seconds '' "$archived"
  record montra_wal_last_failed_timestamp_seconds '' "$failed"
  record montra_wal_failed_total '' "$failed_count"
  record montra_backup_status_timestamp_seconds '' "$(now)"
}

case ${1:-} in
  init)
    "${PG[@]}" pgbackrest --stanza=montra stanza-create
    "${PG[@]}" pgbackrest --stanza=montra check
    db_backup full
    ;;
  db)
    case ${2:-} in full | diff) db_backup "$2" ;; *)
      echo "Usage: ./backup.sh db full|diff" >&2
      exit 1
      ;;
    esac
    ;;
  files) files_backup ;;
  status) status ;;
  info) "${PG[@]}" pgbackrest --stanza=montra info ;;
  *)
    echo "Usage: ./backup.sh init | db full|diff | files | status | info" >&2
    exit 1
    ;;
esac
