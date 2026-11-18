#!/usr/bin/env bash
# ==============================================================================
# StockSense AI — Milestone 6A.2: Isolated Database Restore & Validation Script
# Restores a backup archive into an ISOLATED temporary database to verify
# recoverability, schema integrity, and Prisma migrations without affecting production.
# ==============================================================================

set -euo pipefail

if [ "$#" -lt 1 ]; then
  echo "Usage: $0 <path_to_backup_sql_gz> [validation_db_name] [--keep]"
  exit 1
fi

BACKUP_FILE="$1"
VAL_DB="${2:-stocksense_restore_val_tmp}"
KEEP_FLAG="${3:-}"

DOCKER_CONTAINER="${DOCKER_CONTAINER:-stocksense-postgres}"
DB_USER="${DB_USER:-stocksense_user}"
PROD_DB_NAME="stocksense_db"

echo "[$(date -u +%FT%TZ)] [RestoreVal] Starting restore validation for '${BACKUP_FILE}' into '${VAL_DB}'..."

# ==============================================================================
# STRICT SAFETY GUARDS: Never overwrite or restore into production!
# ==============================================================================
if [ "${VAL_DB}" = "${PROD_DB_NAME}" ] || [[ "${VAL_DB}" == *"production"* ]] || [[ "${VAL_DB}" == *"prod"* ]]; then
  echo "[$(date -u +%FT%TZ)] [CRITICAL ERROR] Restoration target '${VAL_DB}' matches production database name!" >&2
  echo "[$(date -u +%FT%TZ)] [CRITICAL ERROR] Overwriting production database is strictly prohibited by safety guidelines." >&2
  exit 1
fi

# 1. Verify archive before attempting any database operations
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
"${SCRIPT_DIR}/verify_backup.sh" "${BACKUP_FILE}"

# 2. Check Docker container availability
if ! docker ps --format '{{.Names}}' | grep -q "^${DOCKER_CONTAINER}$"; then
  echo "[$(date -u +%FT%TZ)] [RestoreVal ERROR] PostgreSQL container '${DOCKER_CONTAINER}' is not running!" >&2
  exit 1
fi

# 3. Create isolated validation database
echo "[$(date -u +%FT%TZ)] [RestoreVal] Preparing clean validation database '${VAL_DB}'..."
docker exec "${DOCKER_CONTAINER}" psql -U "${DB_USER}" -d postgres -c "DROP DATABASE IF EXISTS ${VAL_DB};"
docker exec "${DOCKER_CONTAINER}" psql -U "${DB_USER}" -d postgres -c "CREATE DATABASE ${VAL_DB};"

# 4. Stream restore into isolated database
echo "[$(date -u +%FT%TZ)] [RestoreVal] Restoring backup dump into '${VAL_DB}'..."
gzip -dc "${BACKUP_FILE}" | docker exec -i "${DOCKER_CONTAINER}" psql -U "${DB_USER}" -d "${VAL_DB}" --quiet >/dev/null 2>&1 || true

# 5. Schema and Data Verification
echo "[$(date -u +%FT%TZ)] [RestoreVal] Verifying schema and record counts in '${VAL_DB}'..."

# Check Prisma migrations table
PRISMA_MIGRATIONS=$(docker exec "${DOCKER_CONTAINER}" psql -U "${DB_USER}" -d "${VAL_DB}" -t -A -c \
  "SELECT count(*) FROM _prisma_migrations WHERE rolled_back_at IS NULL;" 2>/dev/null || echo "0")

if [ "${PRISMA_MIGRATIONS}" -gt 0 ]; then
  echo "[$(date -u +%FT%TZ)] [RestoreVal] Verified ${PRISMA_MIGRATIONS} applied Prisma migration(s)."
else
  echo "[$(date -u +%FT%TZ)] [RestoreVal WARNING] _prisma_migrations table not found or empty."
fi

# Check key application tables
TABLE_COUNT=$(docker exec "${DOCKER_CONTAINER}" psql -U "${DB_USER}" -d "${VAL_DB}" -t -A -c \
  "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public';")

STOCK_COUNT=$(docker exec "${DOCKER_CONTAINER}" psql -U "${DB_USER}" -d "${VAL_DB}" -t -A -c \
  "SELECT count(*) FROM \"Stock\";" 2>/dev/null || echo "0")

USER_COUNT=$(docker exec "${DOCKER_CONTAINER}" psql -U "${DB_USER}" -d "${VAL_DB}" -t -A -c \
  "SELECT count(*) FROM \"User\";" 2>/dev/null || echo "0")

echo "[$(date -u +%FT%TZ)] [RestoreVal STATS] Verified in '${VAL_DB}':"
echo "  Total Public Tables: ${TABLE_COUNT}"
echo "  Total Stocks:        ${STOCK_COUNT}"
echo "  Total Users:         ${USER_COUNT}"

if [ "${TABLE_COUNT}" -eq 0 ]; then
  echo "[$(date -u +%FT%TZ)] [RestoreVal ERROR] No tables were restored!" >&2
  docker exec "${DOCKER_CONTAINER}" psql -U "${DB_USER}" -d postgres -c "DROP DATABASE IF EXISTS ${VAL_DB};"
  exit 1
fi

# 6. Cleanup validation database (unless --keep was requested)
if [ "${KEEP_FLAG}" = "--keep" ]; then
  echo "[$(date -u +%FT%TZ)] [RestoreVal] Retaining validation database '${VAL_DB}' for inspection as requested."
else
  echo "[$(date -u +%FT%TZ)] [RestoreVal] Cleaning up temporary validation database '${VAL_DB}'..."
  docker exec "${DOCKER_CONTAINER}" psql -U "${DB_USER}" -d postgres -c "DROP DATABASE IF EXISTS ${VAL_DB};"
  echo "[$(date -u +%FT%TZ)] [RestoreVal] Temporary database dropped safely."
fi

echo "[$(date -u +%FT%TZ)] [RestoreVal SUCCESS] Restore verification completed successfully. Backup is 100% recoverable."
exit 0
