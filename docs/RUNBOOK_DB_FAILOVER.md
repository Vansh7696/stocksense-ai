# StockSense AI — Operational Runbook: PostgreSQL Database Failover & Recovery

## 1. Symptoms & Alert Triggers
- Prometheus alert: `PostgresConnectionPoolExhausted` or `PostgresServiceUnreachable`.
- Backend logs: `PrismaClientInitializationError: Can't reach database server` or HTTP 500 errors on authenticated endpoints (`/api/auth/me`, `/api/stocks`).
- Express backend health check returns: `"database": "disconnected"` on `GET /api/health`.

---

## 2. Immediate Diagnostic Commands
```bash
# 1. Check PostgreSQL container status and health
docker ps --filter "name=stocksense-postgres"

# 2. Check recent database engine logs
docker logs --tail 100 stocksense-postgres

# 3. Test direct PostgreSQL socket connectivity
docker exec stocksense-postgres pg_isready -U stocksense_user -d stocksense_db

# 4. Check active database connection volume and lock contention
docker exec stocksense-postgres psql -U stocksense_user -d stocksense_db -c \
  "SELECT count(*), state FROM pg_stat_activity GROUP BY state;"
```

---

## 3. Recovery Procedures

### Scenario A: Transient Container or Process Failure
```bash
# 1. Restart database container safely
docker restart stocksense-postgres

# 2. Monitor PostgreSQL recovery and redo-log application
docker logs -f stocksense-postgres

# 3. Verify backend connectivity resumes
curl -s http://localhost:5001/api/health | jq .services.database
```

### Scenario B: Database Promotion / Replica Failover
If operating with a primary-standby replica topology (e.g. AWS RDS Multi-AZ or Patroni/Pgpool):
1. **Promote Standby**:
   ```bash
   # On standby node
   pg_ctl promote -D /var/lib/postgresql/data
   ```
2. **Update Application Connection String**:
   Update `DATABASE_URL` secret in secrets manager or container environment.
3. **Gracefully Restart Backend Service**:
   ```bash
   docker-compose restart backend
   ```

### Scenario C: Corrupted State Restoration (Using Verified Backup)
> [!IMPORTANT]
> Never restore into an active production database directly. Perform isolated validation first.
```bash
# 1. Validate the latest backup archive
LATEST_BACKUP=$(ls -t backups/postgres/stocksense_db_*.sql.gz | head -n 1)
./scripts/verify_backup.sh "${LATEST_BACKUP}"

# 2. Run isolated dry-run restore into temporary database
./scripts/restore_postgres_validation.sh "${LATEST_BACKUP}" stocksense_restore_val_tmp

# 3. After operational sign-off, restore to new target database
```

---

## 4. Data Integrity Verification
```bash
# Check table row counts and Prisma migrations
docker exec stocksense-postgres psql -U stocksense_user -d stocksense_db -c \
  "SELECT count(*) FROM _prisma_migrations WHERE rolled_back_at IS NULL;"

docker exec stocksense-postgres psql -U stocksense_user -d stocksense_db -c \
  "SELECT count(*) FROM \"Stock\"; SELECT count(*) FROM \"HistoricalPrice\";"
```

---

## 5. Escalation Matrix
- **Level 1 (0-15m)**: On-call DevOps / Backend Engineer (container restarts, connection pool tuning).
- **Level 2 (15-45m)**: Principal Architect / Lead DBA (replica failover, volume snapshot recovery).
- **Level 3 (>45m)**: Incident Commander (declare emergency disaster recovery protocol).
