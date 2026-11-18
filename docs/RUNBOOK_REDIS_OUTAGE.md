# StockSense AI — Operational Runbook: Redis Outage & Cache Degradation

## 1. Symptoms & Alert Triggers
- Prometheus alert: `RedisServiceDown` or `RedisMemoryPressureHigh`.
- Backend logs: `[Redis] Notice: Redis service not connected. Application running with in-memory fallback.`
- Health check `GET /api/health` indicates: `"redis": "disconnected"`.

---

## 2. Impact on Application Architecture
- **Fail-Open Rate Limiting**: `predictionRateLimiter` and `analyticsRateLimiter` fail open gracefully; legitimate users are NOT blocked.
- **Fail-Open Analytics Caching**: Controller endpoints bypass Redis cache and retrieve directly from PostgreSQL / ML Service.
- **Session Revocation**: Access token verification falls back to stateless JWT cryptographic signatures with PostgreSQL token blacklist authority.

---

## 3. Immediate Diagnostic Commands
```bash
# 1. Inspect Redis container state
docker ps --filter "name=stocksense-redis"

# 2. Check Redis server logs
docker logs --tail 100 stocksense-redis

# 3. Test Redis ping response
docker exec stocksense-redis redis-cli ping

# 4. Check Redis memory usage and connected clients
docker exec stocksense-redis redis-cli info memory
docker exec stocksense-redis redis-cli info clients
```

---

## 4. Recovery Procedures

### Scenario A: Out of Memory (OOM) or MaxClients Reached
```bash
# 1. Inspect current maxmemory policy
docker exec stocksense-redis redis-cli config get maxmemory-policy

# 2. Enforce volatile-lru eviction for cache keys
docker exec stocksense-redis redis-cli config set maxmemory-policy volatile-lru

# 3. Evict expired analytical cache keys safely
docker exec stocksense-redis redis-cli --scan --pattern 'stocksense:cache:*' | xargs -r docker exec -i stocksense-redis redis-cli del
```

### Scenario B: Redis Container Crash
```bash
# 1. Restart Redis container
docker restart stocksense-redis

# 2. Verify ioredis client automatic reconnection in backend logs
docker logs --tail 50 -f backend | grep "Redis"
```

---

## 5. Verification Steps
```bash
# Verify Redis responds with PONG
docker exec stocksense-redis redis-cli ping

# Verify backend health check reports Redis as healthy
curl -s http://localhost:5001/api/health | jq .services.redis
```

---

## 6. Escalation Conditions
- Persistent Redis data corruption or AOF append failure: escalate to Senior DevOps if unresolved within 20 minutes.
