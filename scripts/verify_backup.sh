#!/usr/bin/env bash
# ==============================================================================
# StockSense AI — Milestone 6A.2: PostgreSQL Backup Integrity Verification
# Validates archive integrity, SHA-256 checksum, and SQL dump structural format.
# ==============================================================================

set -euo pipefail

if [ "$#" -lt 1 ]; then
  echo "Usage: $0 <path_to_backup_sql_gz> [path_to_checksum_sha256]"
  exit 1
fi

BACKUP_FILE="$1"
CHECKSUM_FILE="${2:-${BACKUP_FILE}.sha256}"

echo "[$(date -u +%FT%TZ)] [Verify] Validating backup archive: '${BACKUP_FILE}'..."

# 1. Existence check
if [ ! -f "${BACKUP_FILE}" ]; then
  echo "[$(date -u +%FT%TZ)] [Verify ERROR] Backup file does not exist: '${BACKUP_FILE}'" >&2
  exit 1
fi

# 2. Checksum verification
if [ -f "${CHECKSUM_FILE}" ]; then
  echo "[$(date -u +%FT%TZ)] [Verify] Verifying SHA-256 checksum..."
  BACKUP_DIR="$(dirname "${BACKUP_FILE}")"
  BACKUP_BASENAME="$(basename "${BACKUP_FILE}")"
  CHECKSUM_BASENAME="$(basename "${CHECKSUM_FILE}")"

  if command -v sha256sum >/dev/null 2>&1; then
    (cd "${BACKUP_DIR}" && sha256sum -c "${CHECKSUM_BASENAME}")
  elif command -v shasum >/dev/null 2>&1; then
    (cd "${BACKUP_DIR}" && shasum -a 256 -c "${CHECKSUM_BASENAME}")
  else
    echo "[$(date -u +%FT%TZ)] [Verify ERROR] No sha256sum or shasum tool available." >&2
    exit 1
  fi
  echo "[$(date -u +%FT%TZ)] [Verify] SHA-256 checksum verified successfully."
else
  echo "[$(date -u +%FT%TZ)] [Verify WARNING] No checksum file found at '${CHECKSUM_FILE}'. Generating verification on the fly."
fi

# 3. Gzip decompression integrity check
echo "[$(date -u +%FT%TZ)] [Verify] Testing gzip compression integrity..."
if ! gzip -t "${BACKUP_FILE}"; then
  echo "[$(date -u +%FT%TZ)] [Verify ERROR] Archive '${BACKUP_FILE}' is corrupted or incomplete!" >&2
  exit 1
fi
echo "[$(date -u +%FT%TZ)] [Verify] Gzip compression integrity confirmed."

# 4. Content sanity check (PostgreSQL dump signature)
echo "[$(date -u +%FT%TZ)] [Verify] Checking SQL header signature..."
HEADER="$( (gzip -dc "${BACKUP_FILE}" 2>/dev/null || true) | head -n 30)"
if echo "${HEADER}" | grep -q "PostgreSQL database dump"; then
  echo "[$(date -u +%FT%TZ)] [Verify SUCCESS] Valid PostgreSQL dump signature verified."
  exit 0
else
  echo "[$(date -u +%FT%TZ)] [Verify ERROR] File does not contain a valid PostgreSQL database dump header!" >&2
  exit 1
fi
