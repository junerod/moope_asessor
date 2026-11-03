#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/_common.sh"
ensure_env_docker
svc="${1:-}"
if [[ -n "$svc" ]]; then
  "${COMPOSE[@]}" logs -f --tail=200 "$svc"
else
  "${COMPOSE[@]}" logs -f --tail=100
fi
