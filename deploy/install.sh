#!/usr/bin/env bash
set -Eeuo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
COMPOSE=(docker compose -f docker-compose.company.yml)

command -v docker >/dev/null || { echo 'ERROR: Docker is not installed.' >&2; exit 1; }
docker compose version >/dev/null || { echo 'ERROR: Docker Compose plugin is not installed.' >&2; exit 1; }

if [[ ! -f .env ]]; then
  cp deploy/company.env.example .env
  db_password="$(openssl rand -hex 24)"
  jwt_secret="$(openssl rand -hex 64)"
  admin_initial_password="$(openssl rand -hex 12)"
  sed -i "s/^POSTGRES_PASSWORD=.*/POSTGRES_PASSWORD=${db_password}/" .env
  sed -i "s/^JWT_SECRET=.*/JWT_SECRET=${jwt_secret}/" .env
  sed -i "s/^ADMIN_INITIAL_PASSWORD=.*/ADMIN_INITIAL_PASSWORD=${admin_initial_password}/" .env
  chmod 600 .env
  echo 'Secure environment file created.'
else
  echo 'Existing .env retained.'
fi

mkdir -p backups
chmod 700 backups
app_port="$(awk -F= '/^APP_PORT=/{print $2}' .env)"; app_port="${app_port:-8080}"
"${COMPOSE[@]}" up -d --build database app

echo 'Waiting for application health check...'
ready=0
for _ in {1..60}; do
  if curl -fsS "http://127.0.0.1:${app_port}/api/health" 2>/dev/null | grep -q '"status":"ready"'; then ready=1; break; fi
  sleep 3
done
if [[ "$ready" != 1 ]]; then
  echo 'Application did not become ready. Recent logs:' >&2
  "${COMPOSE[@]}" logs --tail=120 app database >&2
  exit 1
fi

cat <<EOF

BFG CMMS installation completed.
URL: http://SERVER_IP:${app_port}
Initial username: admin
The initial administrator password was generated in .env.
Change it after first login; it is not printed by this installer.
Run deploy/backup.sh immediately to create the first backup.
EOF
