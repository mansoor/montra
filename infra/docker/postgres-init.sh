#!/bin/sh
# Runs once when the local Postgres volume is created (docker compose).
set -e
for db in montra montra_test montra_test_api; do
  psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d postgres -v db="$db" -f /bootstrap/bootstrap.sql
done
