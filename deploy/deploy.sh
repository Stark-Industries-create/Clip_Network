#!/usr/bin/env bash
# Deploys the latest code on the VPS: backs up the database, pulls, rebuilds and restarts.
# Database migrations run automatically when the API container starts.
#
#   sudo ./deploy/deploy.sh            # pull the current branch, then rebuild
#   sudo ./deploy/deploy.sh --no-pull  # rebuild what is already on disk (e.g. after rsync)
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$REPO_DIR/.env.production"
COMPOSE=(docker compose -f "$REPO_DIR/docker-compose.prod.yml" --env-file "$ENV_FILE")
cd "$REPO_DIR"

if [[ ! -f "$ENV_FILE" ]]; then echo "Run deploy/setup-vps.sh first (.env.production is missing)." >&2; exit 1; fi

if "${COMPOSE[@]}" ps --status running --services 2>/dev/null | grep -qx postgres; then
  echo "==> Backing up the database before deploying"
  BACKUP_DIR="$REPO_DIR/backups" ./scripts/backup-postgres.sh
fi

if [[ "${1:-}" != "--no-pull" && -d .git ]]; then
  echo "==> Pulling the latest code"
  git pull --ff-only
fi

echo "==> Building and restarting (the worker finishes its current job first, up to 10 minutes)"
"${COMPOSE[@]}" up -d --build --remove-orphans

echo "==> Waiting for the API"
for _ in $(seq 1 60); do
  if curl -fsS http://127.0.0.1:8080/api/readyz >/dev/null 2>&1; then
    "${COMPOSE[@]}" ps
    docker image prune -f >/dev/null
    echo "Deployed."
    exit 0
  fi
  sleep 5
done
echo "The API did not become ready. Recent API logs:" >&2
"${COMPOSE[@]}" logs --tail 80 api >&2
exit 1
