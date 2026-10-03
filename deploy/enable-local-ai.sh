#!/usr/bin/env bash
set -Eeuo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"; cd "$ROOT"
model="${1:-qwen2.5:3b}"
docker compose -f docker-compose.company.yml --profile local-ai up -d local-ai
docker compose -f docker-compose.company.yml exec local-ai ollama pull "$model"
echo
printf 'Set these values in .env:\nLOCAL_AI_BASE_URL=http://local-ai:11434/v1\nLOCAL_AI_MODEL=%s\n' "$model"
echo 'Then run: docker compose -f docker-compose.company.yml up -d --force-recreate app'
