#!/usr/bin/env bash
# ==============================================================================
# StockSense AI — Milestone 6A.2: Automated PostgreSQL Backup Script
# Creates timestamped, gzip-compressed database dumps with SHA-256 checksums
# and safe retention policy enforcement (never deletes the last backup).
# ==============================================================================

set -euo pipefail

# Configuration with safe defaults
DOCKER_CONTAINER="${DOCKER_CONTAINER:-stocksense-postgres}"
DB_USER="${DB_USER:-stocksense_user}"
DB_NAME="${DB_NAME:-stocksense_db}"
BACKUP_DIR="${BACKUP_DIR:-backups/postgres}"
RETENTION_DAYS="${RETENTION_DAYS:-7}"
TIMESTAMP="$(date +%Y%m%d_%H%M%S)"
BACKUP_FILENAME="${DB_NAME}_${TIMESTAMP}.sql.gz"
BACKUP_PATH="${BACKUP_DIR}/${BACKUP_FILENAME}"
CHECKSUM_PATH="${BACKUP_PATH}.sha256"

# Ensure backup directory exists
mkdir -p "${BACKUP_DIR}"

echo "[$(date -u +%FT%TZ)] [Backup] Starting PostgreSQL backup for database: '${DB_NAME}'..."

# Determine dump command: direct pg_dump or via docker exec
if command -v pg_dump >/dev/null 2>&1; then
  echo "[$(date -u +%FT%TZ)] [Backup] Executing native pg_dump..."
  pg_dump -U "${DB_USER}" -d "${DB_NAME}" --no-owner --no-privileges | gzip -9 > "${BACKUP_PATH}"
elif docker ps --format '{{.Names}}' | grep -q "^${DOCKER_CONTAINER}$"; then
  echo "[$(date -u +%FT%TZ)] [Backup] Executing pg_dump via Docker container '${DOCKER_CONTAINER}'..."
  docker exec "${DOCKER_CONTAINER}" pg_dump -U "${DB_USER}" -d "${DB_NAME}" --no-owner --no-privileges | gzip -9 > "${BACKUP_PATH}"
else
  echo "[$(date -u +%FT%TZ)] [Backup ERROR] Neither native pg_dump nor running container '${DOCKER_CONTAINER}' found!" >&2
  exit 1
fi

# Verify gzip archive integrity immediately
echo "[$(date -u +%FT%TZ)] [Backup] Verifying gzip archive integrity..."
if ! gzip -t "${BACKUP_PATH}"; then
  echo "[$(date -u +%FT%TZ)] [Backup ERROR] Gzip archive validation failed for ${BACKUP_PATH}!" >&2
  rm -f "${BACKUP_PATH}"
  exit 1
fi

# Generate SHA-256 checksum
echo "[$(date -u +%FT%TZ)] [Backup] Generating SHA-256 checksum..."
if command -v sha256sum >/dev/null 2>&1; then
  (cd "${BACKUP_DIR}" && sha256sum "${BACKUP_FILENAME}" > "${BACKUP_FILENAME}.sha256")
elif command -v shasum >/dev/null 2>&1; then
  (cd "${BACKUP_DIR}" && shasum -a 256 "${BACKUP_FILENAME}" > "${BACKUP_FILENAME}.sha256")
else
  echo "[$(date -u +%FT%TZ)] [Backup ERROR] Neither sha256sum nor shasum utility available!" >&2
  exit 1
fi

BACKUP_SIZE="$(ls -lh "${BACKUP_PATH}" | awk '{print $5}')"
echo "[$(date -u +%FT%TZ)] [Backup SUCCESS] Backup successfully created:"
echo "  File:     ${BACKUP_PATH} (${BACKUP_SIZE})"
echo "  Checksum: ${CHECKSUM_PATH}"

# ==============================================================================
# Safe Retention Enforcement (never deletes the last remaining valid backup)
# ==============================================================================
echo "[$(date -u +%FT%TZ)] [Retention] Checking retention policy (${RETENTION_DAYS} days)..."

# Count total valid backups currently present
TOTAL_BACKUPS=$(find "${BACKUP_DIR}" -maxdepth 1 -name "${DB_NAME}_*.sql.gz" -type f | wc -l | tr -d ' ')

if [ "${TOTAL_BACKUPS}" -le 1 ]; then
  echo "[$(date -u +%FT%TZ)] [Retention] Only ${TOTAL_BACKUPS} backup exists. Skipping cleanup to preserve the only valid backup."
else
  # Find backups older than RETENTION_DAYS
  OLD_BACKUPS=$(find "${BACKUP_DIR}" -maxdepth 1 -name "${DB_NAME}_*.sql.gz" -type f -mtime "+${RETENTION_DAYS}" | sort)
  
  if [ -n "${OLD_BACKUPS}" ]; then
    echo "[$(date -u +%FT%TZ)] [Retention] Found candidate backups for pruning older than ${RETENTION_DAYS} days."
    for OLD_FILE in ${OLD_BACKUPS}; do
      # Re-evaluate count before each deletion to guarantee at least 1 backup remains
      CURRENT_COUNT=$(find "${BACKUP_DIR}" -maxdepth 1 -name "${DB_NAME}_*.sql.gz" -type f | wc -l | tr -d ' ')
      if [ "${CURRENT_COUNT}" -gt 1 ]; then
        echo "[$(date -u +%FT%TZ)] [Retention] Pruning expired backup: ${OLD_FILE}"
        rm -f "${OLD_FILE}" "${OLD_FILE}.sha256"
      else
        echo "[$(date -u +%FT%TZ)] [Retention] Safeguard triggered: Retaining ${OLD_FILE} as it is the last remaining backup."
        break
      fi
    done
  else
    echo "[$(date -u +%FT%TZ)] [Retention] No backups older than ${RETENTION_DAYS} days found. No files pruned."
  fi
fi

echo "[$(date -u +%FT%TZ)] [Backup] Backup routine finished successfully."
exit 0
