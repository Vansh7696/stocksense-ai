# StockSense AI — Secrets Management & External Vault Integration Guide

## 1. Overview
StockSense AI uses strict cryptographic secrets isolation. In production environments, all critical secrets (database credentials, symmetric encryption keys, HMAC secrets, and JWT signing keys) must be loaded dynamically from an external, auditable secrets manager rather than plaintext disk files.

---

## 2. Inventory of Critical Secrets

| Variable | Security Requirement | Description |
| :--- | :--- | :--- |
| `DATABASE_URL` | Strict URI credentials | PostgreSQL connection string. Must not use trivial passwords. |
| `REDIS_URL` | Protocol & Auth | Redis distributed caching & rate limiting connection string. |
| `JWT_SECRET` | Min 32 chars, high entropy | HMAC-SHA256 signature key for application user sessions. |
| `APP_ENCRYPTION_KEY` | Exactly 64 hex chars (32 bytes) | AES-256-GCM master key for encrypting Upstox OAuth tokens. |
| `CSRF_SECRET` | Min 32 chars | HMAC key for signed double-submit CSRF cookie validation. |
| `UPSTOX_API_KEY` | Provider Credential | Upstox API v2 client identifier. |
| `UPSTOX_API_SECRET` | Provider Secret | Upstox API v2 client secret. |

---

## 3. Production Startup Validation
The backend enforces automated fail-closed startup validation via `validateProductionEnvironment()` in `backend/src/config/index.js`.
If any required variable is missing, uses known placeholder patterns (e.g. `dev_super_secret...`), or fails cryptographic length constraints, the application immediately aborts with exit code 1 before binding network ports.

---

## 4. Integration Blueprints

### A. AWS Secrets Manager
For AWS ECS, EKS, or EC2 deployments:

```bash
# Retrieve secrets via AWS CLI at deployment time:
aws secretsmanager get-secret-value \
  --secret-id stocksense/production/backend \
  --query SecretString \
  --output text > /etc/stocksense/env.json
```

Or inject directly into container task definitions via AWS ECS secret references:
```json
{
  "name": "JWT_SECRET",
  "valueFrom": "arn:aws:secretsmanager:ap-south-1:123456789012:secret:stocksense/production/backend:JWT_SECRET::"
}
```

### B. HashiCorp Vault
Using Vault Agent sidecar or init container:
```hcl
path "secret/data/stocksense/production" {
  capabilities = ["read"]
}
```

Inject via template:
```gotemplate
{{ with secret "secret/data/stocksense/production" }}
DATABASE_URL="{{ .Data.data.DATABASE_URL }}"
JWT_SECRET="{{ .Data.data.JWT_SECRET }}"
APP_ENCRYPTION_KEY="{{ .Data.data.APP_ENCRYPTION_KEY }}"
CSRF_SECRET="{{ .Data.data.CSRF_SECRET }}"
REDIS_URL="{{ .Data.data.REDIS_URL }}"
{{ end }}
```

### C. Google Cloud Secret Manager (GCP)
```bash
gcloud secrets versions access latest --secret="stocksense-jwt-secret"
```
Or mount via Kubernetes External Secrets Operator (`external-secrets.io`).

---

## 5. Secret Redaction Guarantees in Application Logs
StockSense AI includes automated secret redaction in `backend/src/utils/crypto.js` (`redactString` and `redactSecrets`).
- Sensitive keys (`token`, `secret`, `password`, `authorization`, `cookie`, `key`) are sanitized before being serialized by Winston / JSON loggers.
- Error stack traces and HTTP access URLs with query strings are scrubbed.
