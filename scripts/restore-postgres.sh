#!/usr/bin/env sh
set -eu

# The production compose file requires its env file for variable checks, even for exec.
ENV_FILE="${ENV_FILE:-.env.production}"
COMPOSE_ENV=""
if [ -f "${ENV_FILE}" ]; then COMPOSE_ENV="--env-file ${ENV_FILE}"; fi

if [ "$#" -lt 1 ]; then
  echo "Usage: $0 <path-to-backup.sql.gz>"
  exit 1
fi

BACKUP_FILE="$1"
if [ ! -f "${BACKUP_FILE}" ]; then
  echo "Backup file not found: ${BACKUP_FILE}"
  exit 1
fi

echo "[restore] Restoring ${BACKUP_FILE} into PostgreSQL..."
gunzip -c "${BACKUP_FILE}" | docker compose -f docker-compose.prod.yml ${COMPOSE_ENV} exec -T postgres \
  psql -U "${POSTGRES_USER:-clipnetwork}" -d "${POSTGRES_DB:-clipnetwork}"

echo "[restore] Verification count check:"
docker compose -f docker-compose.prod.yml ${COMPOSE_ENV} exec -T postgres \
  psql -U "${POSTGRES_USER:-clipnetwork}" -d "${POSTGRES_DB:-clipnetwork}" \
  -c "SELECT count(*) AS workspaces FROM \"Workspace\";"
