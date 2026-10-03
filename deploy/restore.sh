#!/usr/bin/env bash
set -Eeuo pipefail
[[ $# -eq 1 ]] || { echo "Usage: $0 backups/file.dump" >&2; exit 1; }
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"; cd "$ROOT"
file="$1"; [[ -s "$file" ]] || { echo 'Backup file not found or empty.' >&2; exit 1; }
[[ -f "${file}.sha256" ]] && sha256sum -c "${file}.sha256"
read -r -p 'This replaces the current database. Type RESTORE to continue: ' confirmation
[[ "$confirmation" == RESTORE ]] || { echo 'Cancelled.'; exit 1; }
COMPOSE=(docker compose -f docker-compose.company.yml)
"${COMPOSE[@]}" stop app
cat "$file" | "${COMPOSE[@]}" exec -T database sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists --no-owner --no-acl --exit-on-error'
"${COMPOSE[@]}" up -d app
echo 'Restore completed. Verify /api/health and application record counts.'
