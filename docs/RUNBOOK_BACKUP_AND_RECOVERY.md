# StockSense AI — Runbook: Automated Database Backup & Recovery

## 1. Overview
This document specifies the standard operating procedures for automated and manual backup generation, SHA-256 archive verification, isolated test restoration, and retention management for StockSense AI PostgreSQL instances.

---

## 2. Backup Architecture & Tooling

### Script Inventory
- `scripts/backup_postgres.sh`: Performs compressed database dumps via `pg_dump`, streams to `gzip -9`, computes SHA-256 digests, and enforces retention limits.
- `scripts/verify_backup.sh`: Verifies archive presence, cryptographic checksums, gzip decompression integrity, and PostgreSQL header markers.
- `scripts/restore_postgres_validation.sh`: Automates dry-run restorations into an isolated validation database to confirm schema integrity, table counts, and Prisma migration consistency.

### File Format & Naming Convention
- Archive: `backups/postgres/stocksense_db_YYYYMMDD_HHMMSS.sql.gz`
- Checksum: `backups/postgres/stocksense_db_YYYYMMDD_HHMMSS.sql.gz.sha256`

---

## 3. Retention Policy & Safeguards

1. **Default Retention**: 7 days (`RETENTION_DAYS=7`).
2. **Last-Backup Safeguard**: The retention enforcement logic explicitly checks the total number of remaining backups before pruning. If only 1 valid backup exists in the backup directory, pruning is skipped regardless of file age.
3. **Atomic Pruning**: A checksum file is pruned only when its corresponding archive file is successfully removed.

---

## 4. Operational Procedures

### Creating a Manual Backup
```bash
# Run using default configuration
./scripts/backup_postgres.sh

# Or override configuration via environment variables
DOCKER_CONTAINER=stocksense-postgres DB_NAME=stocksense_db RETENTION_DAYS=14 ./scripts/backup_postgres.sh
```

### Verifying Backup Archive Integrity
```bash
./scripts/verify_backup.sh backups/postgres/stocksense_db_20261118_222757.sql.gz
```

### Performing Isolated Restore Validation (Dry-Run)
> [!IMPORTANT]
> The restore script contains a strict safety check preventing execution against `stocksense_db` or any database containing `prod`. Dry runs must only target isolated scratch databases.

```bash
# Restores to stocksense_restore_val_tmp, verifies Prisma migrations & row counts, then drops temporary database
./scripts/restore_postgres_validation.sh backups/postgres/stocksense_db_20261118_222757.sql.gz

# To retain the validation database for inspection:
./scripts/restore_postgres_validation.sh backups/postgres/stocksense_db_20261118_222757.sql.gz stocksense_restore_val_tmp --keep
```

---

## 5. Automated Scheduling Reference
To schedule automated nightly backups at 02:00 UTC via standard cron (do not activate without operational approval):

```cron
0 2 * * * cd /path/to/stocksense && ./scripts/backup_postgres.sh >> /var/log/stocksense/backup.log 2>&1
```
