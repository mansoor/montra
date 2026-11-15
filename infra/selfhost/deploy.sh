#!/usr/bin/env bash
# Deploys one release on this server, with the service up throughout (ADR-0050 §6):  ./deploy.sh <tag>
#
#   1. pulls the images for <tag>;
#   2. runs the Kratos and ledger migrations as one-off containers, before any new code starts. Migrations stay
#      backward compatible (scripts/check-migrations.mjs), so the old code keeps working against the new schema;
#   3. replaces Kratos, its courier and the auth gateway, then the workers;
#   4. replaces the API replicas one at a time: Caddy sends traffic to the other while one restarts;
#   5. replaces web (Caddy holds requests for up to 30 seconds while it restarts), then Caddy and cloudflared.
#
# To go back, deploy the previous tag; it prints it at the end. deploy.yml runs this over SSH, and it can be run by hand.
set -euo pipefail
cd "$(dirname "$0")"

tag=${1:?Usage: ./deploy.sh <tag>}
[[ $tag =~ ^[A-Za-z0-9._-]+$ ]] || {
  echo "Not an image tag: $tag" >&2
  exit 1
}
[ -f .env ] || {
  echo ".env is missing: see docs/runbooks/selfhost-setup.md" >&2
  exit 1
}
previous=$(sed -n 's/^MONTRA_TAG=//p' .env | tail -n 1)
export MONTRA_TAG=$tag

dc() { docker compose "$@"; }
up() { dc up -d --no-deps --wait --wait-timeout 300 "$@"; }
step() { printf '\n== %s\n' "$*"; }

step "Pulling $tag"
dc pull --quiet

step "Migrations"
up postgres
dc run --rm kratos-migrate
dc run --rm migrate

step "Identity"
up kratos
dc up -d --no-deps kratos-courier
up auth-gateway

step "Workers"
dc up -d --no-deps worker doc-worker

step "API, one replica at a time"
for replica in api-a api-b; do
  up "$replica"
  # Caddy checks each replica every 5 seconds: let it see this one healthy before the other stops.
  sleep 10
done

step "Web"
up web

step "The way in"
dc up -d --wait --wait-timeout 300
dc exec -T caddy caddy reload --config /etc/caddy/Caddyfile

# Recorded only once everything is up, so a failed release leaves the last good tag in .env.
if grep -q '^MONTRA_TAG=' .env; then
  sed -i "s/^MONTRA_TAG=.*/MONTRA_TAG=$tag/" .env
else
  echo "MONTRA_TAG=$tag" >>.env
fi
docker image prune -f >/dev/null

echo
echo "Deployed $tag."
if [ -n "$previous" ] && [ "$previous" != "$tag" ]; then echo "To go back: ./deploy.sh $previous"; fi
