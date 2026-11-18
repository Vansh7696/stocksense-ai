#!/bin/sh
set -e

echo "========================================================"
echo "🚀 StockSense AI Backend — Container Startup Entrypoint"
echo "========================================================"

# Run database migrations if DATABASE_URL is configured
if [ -n "$DATABASE_URL" ]; then
  echo "[Entrypoint] Detected DATABASE_URL. Applying pending Prisma migrations..."

  # Retry loop for database readiness before applying migrations
  MAX_RETRIES=15
  COUNT=0
  until npx prisma migrate deploy || [ $COUNT -ge $MAX_RETRIES ]; do
    COUNT=$((COUNT + 1))
    echo "[Entrypoint] Database not ready or migration attempt $COUNT failed. Retrying in 2s..."
    sleep 2
  done

  if [ $COUNT -ge $MAX_RETRIES ]; then
    echo "❌ [Entrypoint Error] Database migration failed after $MAX_RETRIES attempts."
    exit 1
  fi
  echo "✔ [Entrypoint] Prisma migrations deployed successfully."
fi

# Optional automated seed
if [ "$AUTO_SEED" = "true" ]; then
  echo "[Entrypoint] AUTO_SEED=true: Seeding verified exchange and equity metadata..."
  node prisma/seed.js || echo "[Entrypoint Warning] Seed script exited with non-zero status ($?)"
fi

echo "✔ [Entrypoint] Handing over execution to command: $@"
exec "$@"
