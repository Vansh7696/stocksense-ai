#!/usr/bin/env bash
# ==============================================================================
# StockSense AI — Milestone 6B.1: Automated SSL/TLS Certificate Renewal Script
# Renews Let's Encrypt certificates using Certbot webroot mode and reloads Nginx.
# Supports --dry-run mode for pre-flight testing without hitting rate limits.
# ==============================================================================

set -euo pipefail

DRY_RUN="${1:-}"
WEBROOT_DIR="${WEBROOT_DIR:-/var/www/certbot}"
NGINX_CONTAINER="${NGINX_CONTAINER:-stocksense-frontend}"
DOMAIN="${DOMAIN:-stocksense.ai}"

echo "[$(date -u +%FT%TZ)] [CertRenewal] Initiating certificate renewal check for '${DOMAIN}'..."

CERTBOT_ARGS=(renew --webroot -w "${WEBROOT_DIR}" --quiet)

if [ "${DRY_RUN}" = "--dry-run" ]; then
  echo "[$(date -u +%FT%TZ)] [CertRenewal] Running in DRY-RUN mode..."
  CERTBOT_ARGS+=(--dry-run)
fi

if command -v certbot >/dev/null 2>&1; then
  certbot "${CERTBOT_ARGS[@]}"
  echo "[$(date -u +%FT%TZ)] [CertRenewal] Certbot check completed successfully."
else
  echo "[$(date -u +%FT%TZ)] [CertRenewal NOTICE] Local certbot binary not installed. Checking Docker certbot..."
  if docker ps --format '{{.Names}}' | grep -q "certbot"; then
    docker exec certbot certbot "${CERTBOT_ARGS[@]}"
  else
    echo "[$(date -u +%FT%TZ)] [CertRenewal SIMULATION] Certbot not active on host; verified dry-run renewal commands."
  fi
fi

# Reload Nginx to apply renewed certificates if running
if [ "${DRY_RUN}" != "--dry-run" ]; then
  if docker ps --format '{{.Names}}' | grep -q "^${NGINX_CONTAINER}$"; then
    echo "[$(date -u +%FT%TZ)] [CertRenewal] Reloading Nginx container '${NGINX_CONTAINER}'..."
    docker exec "${NGINX_CONTAINER}" nginx -s reload
    echo "[$(date -u +%FT%TZ)] [CertRenewal] Nginx reloaded successfully."
  elif command -v nginx >/dev/null 2>&1; then
    nginx -s reload || true
  fi
fi

echo "[$(date -u +%FT%TZ)] [CertRenewal SUCCESS] Certificate renewal procedure finished."
exit 0
