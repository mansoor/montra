#!/usr/bin/env bash
# Montra on your own server (ADR-0050 §1, §5, §11): secrets, requirement checks and the first start.
#
#   ./setup.sh secrets   make ./secrets, generate what can be generated, and list what you must fill in
#   ./setup.sh check     check the requirements; changes nothing
#   ./setup.sh init      the first start: Postgres, the database roles, migrations, every service, the first backup
#   ./setup.sh cron      installs /etc/cron.d/montra: the backup schedule (docs/runbooks/selfhost-backups.md)
#
# Run it as a user who can use docker, and sudo for the secret files. See docs/runbooks/selfhost-setup.md.
# `check && pass … || fail …` is safe here: pass, warn and fail always succeed.
# shellcheck disable=SC2015
set -euo pipefail
umask 077
cd "$(dirname "$0")"

APP_UID=1000 # every Montra container runs as this user (compose.yaml)
SECRETS=./secrets
SUDO=$([ "$(id -u)" = 0 ] && echo "" || echo sudo)

# Generated here, never overwritten.
GENERATED=(postgres_password master_key auth_gateway_secret metrics_token prometheus_metrics_token kratos_cookie_secret
  kratos_cipher_secret kratos_pagination_secret kratos_webhook_secret backup_cipher_pass)
# Made from generated role passwords (secrets/role_passwords, which only setup.sh reads).
URLS=(database_url database_admin_url admin_database_url support_database_url kratos_dsn)
# Yours to fill in. Required: they must not be empty.
REQUIRED=(s3_access_key s3_secret_key mail_url kratos_smtp_url backup_s3_access_key backup_s3_secret_key
  files_backup_access_key files_backup_secret_key)
# Yours to fill in if you use them: an empty file means not in use.
OPTIONAL=(cloudflare_tunnel_token stripe_secret_key stripe_webhook_secret anthropic_api_key sentry_dsn twilio_account_sid
  twilio_auth_token kratos_sms_channel alert_smtp_password)

# The owner of a secret file. Postgres reads its own as root before it drops privileges; Prometheus and Alertmanager
# run as nobody (65534); every Montra container runs as APP_UID.
owner_of() {
  case $1 in
    postgres_password | role_passwords | backup_s3_access_key | backup_s3_secret_key | backup_cipher_pass) echo 0 ;;
    prometheus_metrics_token | alert_smtp_password) echo 65534 ;;
    *) echo "$APP_UID" ;;
  esac
}

put() { # put <name> <value>: writes a secret file with its owner and mode 0400, unless it exists.
  local name=$1 value=$2 owner tmp
  owner=$(owner_of "$name")
  [ -e "$SECRETS/$name" ] && return 0
  tmp=$(mktemp)
  printf '%s\n' "$value" >"$tmp"
  $SUDO install -m 0400 -o "$owner" -g "$owner" "$tmp" "$SECRETS/$name"
  rm -f "$tmp"
  echo "  made $name"
}

hex() { openssl rand -hex "$1"; }
read_secret() { $SUDO cat "$SECRETS/$1"; }

cmd_secrets() {
  command -v openssl >/dev/null || { echo "openssl is needed to generate secrets" >&2; exit 1; }
  $SUDO install -d -m 0711 "$SECRETS"
  echo "Generating what can be generated (existing files are kept):"
  put postgres_password "$(hex 24)"
  put master_key "$(openssl rand -base64 32)"
  put auth_gateway_secret "$(hex 32)"
  put metrics_token "$(hex 24)"
  put prometheus_metrics_token "$(read_secret metrics_token)" # the same token, readable by Prometheus
  put backup_cipher_pass "$(hex 32)"                           # encrypts the database backups
  put kratos_cookie_secret "$(hex 32)"
  put kratos_cipher_secret "$(hex 16)" # Kratos needs exactly 32 characters
  put kratos_pagination_secret "$(hex 32)"
  put kratos_webhook_secret "$(hex 32)"

  if [ ! -e "$SECRETS/role_passwords" ]; then
    put role_passwords "$(printf 'MONTRA_OWNER_PASSWORD=%s\nMONTRA_APP_PASSWORD=%s\nMONTRA_ADMIN_PASSWORD=%s\nMONTRA_SUPPORT_PASSWORD=%s\nMONTRA_KRATOS_PASSWORD=%s' \
      "$(hex 24)" "$(hex 24)" "$(hex 24)" "$(hex 24)" "$(hex 24)")"
  fi
  local pw
  pw=$(read_secret role_passwords)
  role() { printf '%s\n' "$pw" | sed -n "s/^MONTRA_$1_PASSWORD=//p"; }
  put database_url "postgres://montra_app:$(role APP)@postgres:5432/montra"
  put database_admin_url "postgres://montra_owner:$(role OWNER)@postgres:5432/montra"
  put admin_database_url "postgres://montra_admin:$(role ADMIN)@postgres:5432/montra"
  put support_database_url "postgres://montra_support:$(role SUPPORT)@postgres:5432/montra"
  put kratos_dsn "postgres://montra_kratos:$(role KRATOS)@postgres:5432/kratos?sslmode=disable"

  # Empty placeholders, so Compose can mount them; fill them in with: sudoedit secrets/<name>
  for name in "${REQUIRED[@]}" "${OPTIONAL[@]}"; do put "$name" ""; done

  echo
  echo "Fill these in (sudoedit $SECRETS/<name>), one value per file:"
  echo "  s3_access_key, s3_secret_key     the bucket's access key, scoped to that bucket alone"
  echo "  mail_url                         smtp://<user>:<password>@<host>:587 at your sending service"
  echo "  kratos_smtp_url                  the same server for Kratos: smtp://<user>:<password>@<host>:587/"
  echo "  cloudflare_tunnel_token          the tunnel's token (at home, with COMPOSE_PROFILES=tunnel)"
  echo "  backup_s3_access_key, backup_s3_secret_key       the database backup bucket's key"
  echo "  files_backup_access_key, files_backup_secret_key the files backup bucket's key"
  echo "  alert_smtp_password              the SMTP password Alertmanager sends with (profile monitoring)"
  echo "  anthropic_api_key, sentry_dsn    optional"
  echo "  twilio_*, kratos_sms_channel     optional: texts (SMS_MODE=twilio; infra/kratos/sms-channel.example.json)"
  echo
  echo "Back up secrets/master_key and secrets/backup_cipher_pass now, offline and apart from the database backups"
  echo "(docs/runbooks/key-wrapping.md). Without them no backup can be read."
}

# --- check ------------------------------------------------------------------------------------------------------------
FAILED=0
pass() { printf '  ok    %s\n' "$*"; }
warn() { printf '  WARN  %s\n' "$*"; }
fail() {
  printf '  FAIL  %s\n' "$*"
  FAILED=1
}

env_value() { sed -n "s/^$1=//p" .env | tail -n 1; }

check_secret() { # check_secret <name> required|optional
  local name=$1 kind=$2 file="$SECRETS/$1" stat owner mode
  if ! $SUDO test -f "$file"; then
    fail "secrets/$name is missing (./setup.sh secrets)"
    return
  fi
  stat=$($SUDO stat -c '%u %a' "$file")
  owner=${stat% *}
  mode=${stat#* }
  [ "$owner" = "$(owner_of "$name")" ] || fail "secrets/$name is owned by uid $owner, not $(owner_of "$name")"
  case $mode in 400 | 600) ;; *) fail "secrets/$name has mode $mode: make it 0400" ;; esac
  if [ "$kind" = required ] && [ -z "$($SUDO tr -d '[:space:]' <"$file")" ]; then
    fail "secrets/$name is empty"
  fi
}

reachable() { # reachable <host> <port>
  timeout 5 bash -c "exec 3<>/dev/tcp/$1/$2" 2>/dev/null
}

cmd_check() {
  echo "Software"
  if command -v docker >/dev/null; then pass "docker $(docker version -f '{{.Server.Version}}' 2>/dev/null)"; else fail "docker isn't installed"; fi
  local compose
  compose=$(docker compose version --short 2>/dev/null || true)
  if [ -z "$compose" ]; then
    fail "the docker compose plugin isn't installed"
  elif [ "$(printf '%s\n2.24.0\n' "${compose#v}" | sort -V | head -n 1)" != 2.24.0 ]; then
    fail "docker compose $compose is older than 2.24"
  else
    pass "docker compose $compose"
  fi
  command -v openssl >/dev/null && pass openssl || fail "openssl isn't installed"
  command -v jq >/dev/null && pass jq || fail "jq isn't installed (backup.sh status needs it)"
  [ -d /etc/cron.d ] && pass cron || fail "cron isn't installed (the backups run from /etc/cron.d)"

  echo "Settings"
  if [ ! -f .env ]; then
    fail ".env is missing: cp montra.env.example .env, then fill it in"
  else
    if out=$(docker compose config -q 2>&1); then pass "compose.yaml and .env"; else fail "docker compose config: $out"; fi
    [ -n "$(env_value MONTRA_TAG)" ] && pass "MONTRA_TAG=$(env_value MONTRA_TAG)" || fail "MONTRA_TAG is empty in .env"
    case $(env_value BILLING_MODE) in
      off | '') pass "BILLING_MODE=off (no plans enforced)" ;;
      stripe)
        check_secret stripe_secret_key required
        check_secret stripe_webhook_secret required
        ;;
    esac
    [ -n "$(env_value MONTRA_POSTGRES_TAG)" ] && pass "MONTRA_POSTGRES_TAG=$(env_value MONTRA_POSTGRES_TAG)" ||
      fail "MONTRA_POSTGRES_TAG is empty in .env"
    for name in BACKUP_S3_ENDPOINT BACKUP_S3_BUCKET FILES_BACKUP_S3_ENDPOINT FILES_BACKUP_S3_BUCKET; do
      [ -n "$(env_value "$name")" ] || fail "$name is empty in .env: backups go to buckets at another provider"
    done
    if [[ "$(env_value COMPOSE_PROFILES)" == *monitoring* ]]; then
      [ -f alertmanager.yml ] && pass "alertmanager.yml" ||
        fail "alertmanager.yml is missing: cp ../observability/alertmanager/alertmanager.example.yml alertmanager.yml"
      check_secret alert_smtp_password required
    else
      warn "the monitoring profile is off: nothing will tell you a backup failed (docs/runbooks/selfhost-backups.md §4)"
    fi
  fi

  echo "Secrets"
  if ! $SUDO test -d "$SECRETS"; then
    fail "secrets/ is missing: ./setup.sh secrets"
  else
    for name in "${GENERATED[@]}" "${URLS[@]}" "${REQUIRED[@]}"; do check_secret "$name" required; done
    for name in "${OPTIONAL[@]}"; do check_secret "$name" optional; done
    if [[ "$(env_value COMPOSE_PROFILES)" == *tunnel* ]]; then check_secret cloudflare_tunnel_token required; fi
    if $SUDO test -f "$SECRETS/master_key"; then
      [ "$($SUDO cat "$SECRETS/master_key" | base64 -d 2>/dev/null | wc -c)" = 32 ] &&
        pass "master_key is 32 bytes" || fail "master_key isn't 32 bytes of base64"
    fi
    if $SUDO test -f "$SECRETS/kratos_cipher_secret"; then
      [ "$($SUDO tr -d '\n' <"$SECRETS/kratos_cipher_secret" | wc -c)" = 32 ] ||
        fail "kratos_cipher_secret must be exactly 32 characters"
    fi
  fi

  echo "Services Montra needs (ADR-0050 §1)"
  local endpoint mail host port
  endpoint=$(env_value S3_ENDPOINT)
  if [ -n "$endpoint" ] && curl -sS -o /dev/null --max-time 10 "$endpoint" 2>/dev/null; then
    pass "S3 endpoint $endpoint answers"
  else
    fail "S3 endpoint '${endpoint}' doesn't answer"
  fi
  if $SUDO test -s "$SECRETS/mail_url"; then
    mail=$($SUDO cat "$SECRETS/mail_url")
    host=$(printf '%s' "$mail" | sed -E 's#^[a-z]+://([^@]*@)?([^:/]+).*#\2#')
    port=$(printf '%s' "$mail" | sed -nE 's#^[a-z]+://([^@]*@)?[^:/]+:([0-9]+).*#\2#p')
    port=${port:-587}
    reachable "$host" "$port" && pass "SMTP $host:$port answers" || fail "SMTP $host:$port doesn't answer (some ISPs block outgoing mail ports)"
  fi
  reachable ghcr.io 443 && pass "ghcr.io answers" || fail "can't reach ghcr.io for the images"

  echo "The machine (ADR-0050 Consequences: own servers mean owning what the cloud did)"
  local root avail mem
  root=$(docker info -f '{{.DockerRootDir}}' 2>/dev/null || echo /var/lib/docker)
  avail=$(df -P -BG "$root" 2>/dev/null | awk 'NR==2 { gsub("G", "", $4); print $4 }')
  if [ -n "$avail" ] && [ "$avail" -ge 20 ]; then pass "${avail} GB free for Docker"; else fail "less than 20 GB free for Docker (${avail:-?} GB)"; fi
  mem=$(awk '/MemTotal/ { printf "%d", $2 / 1048576 }' /proc/meminfo 2>/dev/null || echo 0)
  [ "$mem" -ge 4 ] && pass "${mem} GB of memory" || warn "${mem} GB of memory: 4 GB or more is recommended"
  if grep -q 'active raid1' /proc/mdstat 2>/dev/null || { command -v zpool >/dev/null && zpool list -H 2>/dev/null | grep -q .; }; then
    pass "a disk mirror is set up"
  else
    warn "no disk mirror found (mdadm RAID 1 or ZFS): one failed disk would mean a restore from backups"
  fi
  command -v smartctl >/dev/null && pass "smartctl is installed" || warn "smartmontools isn't installed: disks fail without warning"
  if command -v upsc >/dev/null || command -v apcaccess >/dev/null; then pass "UPS software is installed"; else warn "no UPS software (NUT or apcupsd): a power cut stops the server uncleanly"; fi
  lsblk -o TYPE 2>/dev/null | grep -q crypt && pass "an encrypted disk is in use" || warn "no encrypted disk found: the database and secrets sit on the disk as they are"
  [ "$(timedatectl show -p NTPSynchronized --value 2>/dev/null)" = yes ] && pass "the clock is synchronized" || warn "the clock isn't synchronized (sign-in codes and sessions depend on it)"

  echo
  if [ "$FAILED" = 0 ]; then echo "Ready."; else
    echo "Fix the FAIL lines above, then run ./setup.sh check again."
    return 1
  fi
}

cmd_init() {
  cmd_check
  local tag
  tag=$(env_value MONTRA_TAG)
  echo
  echo "== Starting Postgres"
  docker compose up -d --wait postgres
  echo "== Creating the database roles (infra/db/production-roles.sql)"
  # The passwords go in on stdin, so they never appear in a process list.
  read_secret role_passwords | docker compose exec -T postgres bash -c \
    'set -a; . /dev/stdin; set +a; psql -v ON_ERROR_STOP=1 -U postgres -d montra -f /montra-db/production-roles.sql'
  echo "== First release: $tag"
  ./deploy.sh "$tag"
  echo "== pgBackRest: the stanza and a first full backup"
  $SUDO ./backup.sh init
  cmd_cron
  cat <<EOF

Montra is running. Next (docs/runbooks/selfhost-setup.md §10):
  1. Sign up at https://$(env_value APP_HOST) with your own email.
  2. Make yourself staff:
       docker compose run --rm migrate node dist/staff-cli.js <your email> admin
  3. Back up secrets/master_key and secrets/backup_cipher_pass offline, if you haven't yet.
  4. Do a restore drill within the first month (docs/runbooks/selfhost-restore-drill.md).
EOF
}

# --- cron -------------------------------------------------------------------------------------------------------------
cmd_cron() {
  local here tmp
  [ -d /etc/cron.d ] || {
    echo "/etc/cron.d is missing: install cron (sudo apt install cron), then run ./setup.sh cron" >&2
    return 1
  }
  here=$(pwd)
  tmp=$(mktemp)
  cat >"$tmp" <<EOF
# Montra's backups (docs/runbooks/selfhost-backups.md). Written by $here/setup.sh cron.
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
15 2 * * 0   root $here/backup.sh db full >>/var/log/montra-backup.log 2>&1
15 2 * * 1-6 root $here/backup.sh db diff >>/var/log/montra-backup.log 2>&1
45 3 * * *   root $here/backup.sh files   >>/var/log/montra-backup.log 2>&1
*/5 * * * *  root $here/backup.sh status  >>/var/log/montra-backup.log 2>&1
EOF
  $SUDO install -m 0644 -o 0 -g 0 "$tmp" /etc/cron.d/montra
  rm -f "$tmp"
  echo "Installed /etc/cron.d/montra."
}

case ${1:-} in
  secrets) cmd_secrets ;;
  check) cmd_check ;;
  init) cmd_init ;;
  cron) cmd_cron ;;
  *)
    echo "Usage: ./setup.sh secrets | check | init | cron" >&2
    exit 1
    ;;
esac
