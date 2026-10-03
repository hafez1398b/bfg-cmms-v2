#!/usr/bin/env bash
set -Eeuo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"; cd "$ROOT"
COMPOSE=(docker compose -f docker-compose.company.yml)
mkdir -p backups; chmod 700 backups
stamp="$(date -u +%Y%m%dT%H%M%SZ)"; output="backups/bfg-cmms-${stamp}.dump"; checksum="${output}.sha256"
"${COMPOSE[@]}" exec -T database sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom --no-owner --no-acl' > "$output"
test -s "$output" || { rm -f "$output"; echo 'Backup failed: empty output' >&2; exit 1; }
sha256sum "$output" > "$checksum"; chmod 600 "$output" "$checksum"
echo "Backup created: $output"
cat "$checksum"
