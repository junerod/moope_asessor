#!/usr/bin/env bash
# Cria/promove superadmin (idempotente o bastante para reexecução)
set -euo pipefail
source "$(dirname "$0")/_common.sh"
ensure_env_docker

PORT="${ASSESSOR_HTTP_PORT:-3010}"
BASE="http://127.0.0.1:${PORT}"
EMAIL="${ASSESSOR_ADMIN_EMAIL:-admin@moope.com.br}"
PASS="${ASSESSOR_ADMIN_PASSWORD:-BMW@m00pes}"
NAME="${ASSESSOR_ADMIN_NAME:-MOOPE Admin}"

echo "→ aguardando API em $BASE"
for i in $(seq 1 60); do
  if curl -fsS "$BASE/api/health" >/dev/null 2>&1; then break; fi
  sleep 2
done

echo "→ registrando $EMAIL (ignora se já existe)"
curl -sS -X POST "$BASE/api/auth/register" \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"name\":\"$NAME\",\"password\":\"$PASS\"}" \
  >/tmp/assessor-register.json || true

echo "→ promovendo platform_admin"
"${COMPOSE[@]}" --env-file .env.docker run --rm --no-deps \
  -e DATABASE_URL=postgres://assessor:assessor@postgres:5432/moope_assessor \
  migrate \
  npx tsx scripts/promote-platform-admin.ts "$EMAIL"

echo "→ login teste"
curl -sS -X POST "$BASE/api/auth/login" \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASS\"}" \
  | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{const j=JSON.parse(d); if(!j.access_token){console.error(d); process.exit(1)}; console.log("OK login", j.user.email)})'

echo
echo "Admin: $BASE/admin"
echo "User:  $EMAIL"
