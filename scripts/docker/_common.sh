#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

COMPOSE=(docker compose -f docker-compose.yml)
if [[ "${ASSESSOR_DOCKER_PROD:-}" == "1" ]]; then
  COMPOSE=(docker compose -f docker-compose.yml -f docker-compose.prod.yml)
fi

ensure_env_docker() {
  if [[ ! -f .env.docker ]]; then
    if [[ -f .env.local ]]; then
      echo "→ gerando .env.docker a partir de .env.local"
      # shellcheck disable=SC2016
      awk '
        BEGIN { print "# gerado por scripts/docker — não edite secrets aqui sem necessidade" }
        /^DATABASE_URL=/ {
          print "DATABASE_URL=postgres://assessor:assessor@postgres:5432/moope_assessor"
          next
        }
        /^APP_BASE_URL=/ {
          print "APP_BASE_URL=http://localhost:3010"
          next
        }
        /^NODE_ENV=/ { print "NODE_ENV=production"; next }
        /^ZERNIO_MOCK=/ { print "ZERNIO_MOCK=false"; next }
        { print }
      ' .env.local > .env.docker
      if ! grep -q '^ASSESSOR_HTTP_PORT=' .env.docker; then
        echo "ASSESSOR_HTTP_PORT=3010" >> .env.docker
      fi
      if ! grep -q '^APP_BASE_URL=' .env.docker; then
        echo "APP_BASE_URL=http://localhost:3010" >> .env.docker
      fi
    else
      echo "→ copiando .env.docker.example → .env.docker"
      cp .env.docker.example .env.docker
    fi
  fi
}
