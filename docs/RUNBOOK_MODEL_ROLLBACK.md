# StockSense AI — Operational Runbook: Champion Model Rollback

## 1. Symptoms & Rollback Triggers
- Sudden drop in prediction directional accuracy, confidence, or calibration metrics in production.
- Model monitoring triggers: feature drift alerts or elevated `model_inference_latency_seconds_bucket`.
- Production prediction errors or unexpected HTTP 500 responses from `/api/inference/predict`.

---

## 2. Immediate Diagnostic Commands
```bash
# 1. Inspect ML Service active models and cryptographic checksums
curl -s http://localhost:8000/api/inference/models/active | jq .

# 2. Check ML microservice inference logs and exceptions
docker logs --tail 100 stocksense-ml-service

# 3. Verify registry manifest integrity
cat ml-service/models/champion_registry.json | jq .
```

---

## 3. Champion Model Rollback Procedure

### Step 1: Identify Prior Proven Champion Version
Inspect `ml-service/models/registry_history.json` or previous commit tags to find the known good model artifacts and SHA-256 checksums:
```bash
git log -n 5 --oneline ml-service/models/champion_registry.json
```

### Step 2: Update Champion Registry Manifest
Update `ml-service/models/champion_registry.json` pointing to the previous champion model artifacts:
```json
{
  "champions": {
    "h1": {
      "model_type": "XGBoostClassifier",
      "artifact_path": "models/artifacts/h1_xgboost_champion_v1.0.joblib",
      "sha256": "<verified_sha256_hash>"
    }
  }
}
```

### Step 3: Trigger Graceful Model Reload
The ML service supports atomic hot-reloading:
```bash
# Send reload signal or restart ML service container
docker restart stocksense-ml-service
```

### Step 4: Verify Model Reload & Integrity
```bash
# Verify active models response returns rolled-back version with valid checksums
curl -s http://localhost:8000/api/inference/models/active | jq .

# Test test prediction endpoint
curl -s -X POST http://localhost:8000/api/inference/predict \
  -H "Content-Type: application/json" \
  -d '{"symbol":"RELIANCE","horizon":1,"features":{"price_to_sma20":0.02,...}}' | jq .
```

---

## 4. Quarantined Data Safeguard
> [!CAUTION]
> Under NO circumstances should rollback testing, fine-tuning, or validation load the quarantined held-out test partition (`2026-07-14` through `2026-11-09`). Use only approved validation fixtures.
