#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/_common.sh"
ensure_env_docker
"${COMPOSE[@]}" --env-file .env.docker build --no-cache
"${COMPOSE[@]}" --env-file .env.docker up -d
