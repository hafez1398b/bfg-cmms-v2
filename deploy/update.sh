#!/usr/bin/env bash
set -Eeuo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"; cd "$ROOT"
./deploy/backup.sh
docker compose -f docker-compose.company.yml up -d --build app
docker compose -f docker-compose.company.yml ps
echo 'Update completed after a verified pre-update backup.'
