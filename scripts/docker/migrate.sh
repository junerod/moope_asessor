#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/_common.sh"
ensure_env_docker
"${COMPOSE[@]}" --env-file .env.docker run --rm migrate
