# StockSense AI — v1.0.0 Production Release Notes

**Release Version:** v1.0.0
**Release Date:** November 18, 2026
**Target Environment:** Production Ready (Local & Distributed Microservice Deployment)
**System Architecture:** React 19 Frontend + Node.js 22 Express Backend + Python 3.14 FastAPI ML Service + PostgreSQL 16 + Redis 7
**Full-Stack Verification:** 949 / 949 Tests Passing (100% Pass Rate)

---

## 1. Executive Summary

StockSense AI v1.0.0 represents the complete, production-grade quantitative intelligence and multi-horizon directional forecasting platform specifically engineered for Indian Equities listed on the **National Stock Exchange (NSE)** and **Bombay Stock Exchange (BSE)**.

By uniting classical technical analysis, institutional risk modeling, advanced machine learning (Gradient Boosting & Random Forests), Tree SHAP model explainability, real-time financial market news sentiment analysis, and pattern recognition, StockSense AI provides traders, portfolio managers, and quantitative researchers with unprecedented directional transparency, probabilistic conviction, and analytical rigor.

---

## 2. Key Capabilities & Subsystems

### 2.1 Multi-Horizon Directional Prediction Engine (Phases 5C.1 – 5C.6)
- **Triple-Horizon Forecasting**: Simultaneous probabilistic forecasts across three distinct forward horizons:
  - **Horizon 1 ($T+1$)**: Short-term tactical movement ($\pm 0.5\%$ target barrier) powered by Champion Model `xgboost_h1_v1.0.0`.
  - **Horizon 3 ($T+3$)**: Multi-session swing movement ($\pm 1.0\%$ target barrier) powered by Champion Model `xgboost_h3_v1.0.0`.
  - **Horizon 5 ($T+5$)**: Weekly positional movement ($\pm 1.5\%$ target barrier) powered by Champion Model `random_forest_h5_v1.0.0`.
- **Validation-Selected Champion Models**: Selected using Purged Walk-Forward Time-Series Split with embargo margins, strictly evaluated against baseline random and majority class models.
- **Cryptographic Provenance**: Every champion artifact is validated via SHA-256 manifest fingerprints.
- **Strict Quarantine Preservation**: The Phase 5C.3 held-out test partition (`2026-07-14` to `2026-11-09`) remains completely unaccessed, ensuring zero data leakage.

### 2.2 Model Explainability & Feature Attribution (Phase 5C.8)
- **Local Feature Attribution**: Tree SHAP and decision-path feature attributions computed directly during inference.
- **Top-5 Driver Ranking**: Identifies whether dynamic indicators (e.g. RSI 14, RVOL 20, MACD histogram, Moving Average spreads) provide positive support or opposing drag on predicted directional outcomes.
- **Visual Attribution Dashboard**: Normalized proportional bars highlighting bullish vs. bearish contributions.

### 2.3 Real-Time News Sentiment & Bayesian Multi-Factor Fusion (Phase 5C.9)
- **Indian Financial Lexicon**: Custom financial domain lexicon (100+ terms) tuned to Indian markets, incorporating corporate earnings, SEBI regulatory actions, RBI monetary policy, and order wins.
- **Negation & Amplifier Handling**: Context-sensitive modifiers with hyperbolic tangent squashing into $[-1.0, +1.0]$ polarity.
- **Bayesian Multi-Factor Fusion**: Mathematical blending of technical model probabilities with qualitative sentiment polarity to compute fused directional probabilities and alignment labels (`CONFIRMING`, `CONTRADICTING`, `NEUTRAL_ALIGNMENT`).

### 2.4 Advanced Technical Analysis & Pattern Recognition (Phase 5C.10)
- **Candlestick Pattern Recognition**: Automated identification of 9 classical patterns (Hammer, Shooting Star, Bullish Engulfing, Bearish Engulfing, Doji, Morning Star, Evening Star, Three White Soldiers, Three Black Crows) with zero look-ahead bias.
- **Support & Resistance Extrema Clustering**: Rolling local extrema detection aggregated into volume-weighted clusters with touch count scoring.
- **Breakout & Momentum Triggers**: Donchian 20-period channel breakouts, RSI regular divergence detection, and MACD signal line crossovers.
- **Composite Technical Stance**: Continuous $-1.0$ to $+1.0$ scoring mapped to institutional stances (`STRONG_BULLISH`, `BULLISH`, `NEUTRAL`, `BEARISH`, `STRONG_BEARISH`).

### 2.5 Production Hardening, Security & Observability (Phases 3, 4, 5C.7)
- **Containerization**: Hardened multi-stage Docker builds running as non-root users (`uid: 10001` / `node`), with custom health checks, `no-new-privileges:true`, and isolated bridge networks.
- **Security & Cryptography**: AES-256-GCM encryption for stored API secrets, JWT authentication with rotating refresh tokens, rate limiting per IP and user, CORS whitelist, and automatic secret redaction in logs.
- **Telemetry & Tracing**: Distributed correlation IDs (`X-Correlation-ID`) tracked across Frontend $\to$ Backend $\to$ ML Service, structured JSON logging, and native Prometheus metrics (`/metrics`).
- **Resilient Database Entrypoint**: Automated PostgreSQL connection polling with exponential backoff and containerized migration runner (`prisma migrate deploy`).
- **CI/CD Automation**: Comprehensive GitHub Actions workflow validating security audit, linting, and 949 test cases across all three layers.

---

## 3. End-to-End Test Suite Verification

| Microservice | Test Framework | Test Files | Total Tests | Pass Rate |
| :--- | :--- | :--- | :--- | :--- |
| **Python ML Service** | `pytest` + `pytest-asyncio` | 9 suites | 385 | **100%** |
| **Node.js Express Backend** | `node:test` + `supertest` | 13 suites | 480 | **100%** |
| **React Frontend** | `node:test` | 5 suites | 84 | **100%** |
| **Frontend Production Build** | Vite v6.4.5 (Rollup) | Bundle | Success (1.31s) | **100%** |
| **Full Stack Total** | — | **27 suites** | **949 tests** | **100%** |

---

## 4. API Endpoints Reference

### 4.1 Prediction & Intelligence Endpoints
- `GET /api/stocks/:id/predictions` — Multi-horizon directional forecasts (requires auth, rate-limited, Redis cached).
- `GET /api/stocks/predictions/models` — Active champion model registry manifest.
- `GET /api/stocks/:id/sentiment` — Financial news sentiment analysis and Bayesian multi-factor fusion.
- `GET /api/stocks/:id/patterns` — Candlestick patterns, S/R zones, and breakout momentum signals.

### 4.2 Market Data & Stock Catalogue
- `GET /api/stocks` — Paginated stock catalogue with exchange and segment filtering.
- `GET /api/stocks/search` — Typeahead symbol/company name search.
- `GET /api/stocks/:id` — Full stock instrument specifications.
- `GET /api/stocks/:id/prices` — Historical OHLCV candlestick time series.
- `GET /api/stocks/:id/indicators` — Standard technical indicators (RSI, MACD, Bollinger Bands, ATR).
- `GET /api/stocks/:id/features` — 23 scale-invariant quantitative features.

### 4.3 Authentication, Watchlists & Telemetry
- `POST /api/auth/register`, `POST /api/auth/login`, `POST /api/auth/refresh`, `POST /api/auth/logout` — Enterprise auth engine.
- `GET /api/watchlists`, `POST /api/watchlists`, `POST /api/watchlists/:id/items` — Persistent watchlists.
- `GET /api/alerts`, `POST /api/alerts` — Stock price and technical alerts.
- `GET /health` — Service health across database, Redis, and ML connectivity.
- `GET /metrics` — Prometheus telemetry scraper endpoint.

---

## 5. Deployment Instructions

### Production Deployment via Docker Compose
```bash
# 1. Copy and configure production environment variables
cp .env.production.example .env.production

# 2. Build and launch hardened production stack
docker compose -f docker-compose.production.yml up -d --build

# 3. Verify health status
curl -s http://localhost:5001/health | jq .
curl -s http://localhost:8000/health | jq .
```

---

## 6. Regulatory & Statutory Disclaimer

Predictions, sentiment scores, and technical pattern alerts generated by StockSense AI are designed strictly for educational, technical evaluation, and quantitative research purposes. They do not constitute financial advice, investment recommendations, or SEBI-registered research analyst opinions. All market operations carry inherent risk.
