# StockSense AI — Operational Runbook: Incident Response & Triage

## 1. Incident Severity Classification

| Severity | Definition | Target Response (MTTA) | Target Resolution (MTTR) |
| :--- | :--- | :--- | :--- |
| **SEV-1 (Critical)** | Core prediction API completely down; data corruption; security breach; persistent PostgreSQL outage. | < 15 minutes | < 2 hours |
| **SEV-2 (Major)** | Degraded ML prediction latency (>2s); Redis cache offline with fail-open active; intermittent 5xx errors (>5%). | < 30 minutes | < 4 hours |
| **SEV-3 (Minor)** | Background ingestion delays; non-critical telemetry reporting errors; UI cosmetic defects. | < 2 hours | < 24 hours |

---

## 2. Standard Triage Flowchart

1. **Acknowledge & Declare**: Log incident ticket, declare severity level, notify on-call engineering channel.
2. **Isolate**: Determine if incident is localized to a single service (Database, Redis, ML Service, Backend Gateway, Nginx).
3. **Mitigate**: Prioritize restoring service availability over root-cause investigation:
   - For DB issues: follow `docs/RUNBOOK_DB_FAILOVER.md`.
   - For Redis issues: follow `docs/RUNBOOK_REDIS_OUTAGE.md`.
   - For ML inference issues: follow `docs/RUNBOOK_MODEL_ROLLBACK.md`.
4. **Investigate**: Capture correlation IDs, structured logs, and container state before restarting if possible.
5. **Resolve & Review**: Run smoke verification, mark resolved, schedule Blameless Post-Mortem within 48 hours.

---

## 3. Incident Investigation Toolkit

```bash
# 1. Capture system-wide container health
docker ps --all

# 2. Extract errors with correlation IDs from backend logs
docker logs --tail 200 backend | grep -E "ERROR|WARN"

# 3. Check ML microservice error rates
docker logs --tail 200 stocksense-ml-service | grep -E "ERROR|CRITICAL"

# 4. Check Prometheus / Metrics scrape status
curl -s http://localhost:5001/metrics | grep -E "http_requests_total|process_cpu_seconds_total"
```

---

## 4. Post-Mortem Template
Every SEV-1 and SEV-2 incident requires a post-mortem documenting:
- Incident summary & timeline (UTC)
- Root cause (5 Whys methodology)
- Impact (downtime duration, impacted users, request failure rate)
- Action items (preventive architectural hardening with assigned owners and tickets).
