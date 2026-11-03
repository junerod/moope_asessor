#!/usr/bin/env bash
# Sobe stack local completa (postgres + migrate + app + worker + scheduler)
set -euo pipefail
source "$(dirname "$0")/_common.sh"
ensure_env_docker

echo "→ build + up"
"${COMPOSE[@]}" --env-file .env.docker up -d --build

echo "→ aguardando health"
for i in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:${ASSESSOR_HTTP_PORT:-3010}/api/health" >/dev/null 2>&1; then
    break
  fi
  sleep 2
done

echo
"${COMPOSE[@]}" ps
echo
curl -fsS "http://127.0.0.1:${ASSESSOR_HTTP_PORT:-3010}/api/ready" || true
echo
echo "Admin: http://localhost:${ASSESSOR_HTTP_PORT:-3010}/admin"
echo "Bootstrap admin: npm run docker:bootstrap-admin"
