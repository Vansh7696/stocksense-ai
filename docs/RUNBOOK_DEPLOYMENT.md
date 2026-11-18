# StockSense AI — Operational Runbook: Production Deployment & Zero-Downtime Release

## 1. Scope & Prerequisites
Standard release procedure for rolling out backend, frontend, database migrations, and ML microservice updates.

### Pre-Deployment Verification Checklist
1. All automated tests pass:
   - Backend: `npm test --prefix backend` (489+ tests)
   - ML Service: `pytest ml-service/tests` (390+ tests)
   - Frontend Build: `npm run build --prefix frontend`
2. Database migrations tested via Prisma dry-run.
3. Production secrets validated via `validateProductionEnvironment()`.
4. Automated backup executed prior to deployment: `./scripts/backup_postgres.sh`.

---

## 2. Standard Deployment Steps

### Step 1: Pre-Release Database Backup
```bash
./scripts/backup_postgres.sh
```

### Step 2: Apply Database Schema Migrations
```bash
# Apply pending Prisma migrations safely
cd backend && npx prisma migrate deploy
```

### Step 3: Rolling Update of ML Intelligence Service
```bash
docker-compose build ml-service
docker-compose up -d --no-deps ml-service
# Wait for health check
curl --retry 5 --retry-delay 2 http://localhost:8000/health
```

### Step 4: Rolling Update of Express Backend
```bash
docker-compose build backend
docker-compose up -d --no-deps backend
# Wait for health check
curl --retry 5 --retry-delay 2 http://localhost:5001/api/health
```

### Step 5: Rolling Update of Frontend Nginx Proxy
```bash
docker-compose build frontend
docker-compose up -d --no-deps frontend
# Verify frontend health
curl -s http://localhost/health
```

---

## 3. Post-Deployment Smoke Verification
1. `GET /api/health`: Verify PostgreSQL, Redis, and ML Service reports healthy.
2. `POST /api/auth/csrf`: Verify signed double-submit CSRF cookie issuance.
3. `POST /api/auth/login`: Test authentication flow with test account.
4. `GET /api/stocks`: Test stock catalog listing and search.
5. `GET /api/stocks/:id/predictions`: Test multi-horizon ML inference.

---

## 4. Rollback Plan
If smoke verification fails:
```bash
# 1. Roll back container images to previous commit tag
git checkout <previous_release_tag>

# 2. Re-deploy previous stable containers
docker-compose up -d

# 3. If database migration needs rollback, apply migration rollback script
```
