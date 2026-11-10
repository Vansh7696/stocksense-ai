# StockSense AI — Financial Intelligence & Market Analysis Platform

StockSense AI is a professional full-stack financial intelligence platform designed for the Indian equity markets (NSE & BSE). It combines fundamental metrics, technical analysis, news sentiment intelligence, and explainable machine learning predictions to deliver actionable, transparent BUY / HOLD / SELL recommendations.

---

## 🏛️ High-Level Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    React Frontend (Vite)                    │
│   - Tailwind CSS, TradingView Lightweight Charts, Lucide    │
└──────────────────────────────┬──────────────────────────────┘
                               │ REST / JSON (JWT Auth)
                               ▼
┌─────────────────────────────────────────────────────────────┐
│                 Express.js Backend (Node.js)                │
│   - Business Logic, Zod Validation, Upstox API V3 Provider  │
│   - Rate Limiting, Cache Control, Security (Helmet/CORS)    │
└──────────────┬──────────────────────────────┬───────────────┘
               │ Prisma ORM (v6)              │ HTTP / JSON
               ▼                              ▼
┌──────────────────────────────┐ ┌────────────────────────────┐
│      PostgreSQL & Redis      │ │   FastAPI ML Microservice  │
│ - Historical OHLCV Candles   │ │ - Feature Engineering      │
│ - Relational Market Schema   │ │ - FinBERT Sentiment (Future│
│ - Redis In-Memory Cache      │ │ - XGBoost / SHAP (Future)  │
└──────────────────────────────┘ └────────────────────────────┘
```

> **Security Rule**: The Frontend communicates strictly with the Express backend. It never connects directly to the database or ML microservice.

---

## 📂 Monorepo Structure

```
stocksense/
├── frontend/             # React + Vite client application
├── backend/              # Node.js + Express REST API server with Prisma ORM
├── ml-service/           # Python FastAPI AI/ML microservice
├── docs/                 # Architectural specifications, DB schema, API docs
├── docker-compose.yml    # Container orchestration (Postgres, Redis, Services)
├── .env.example          # Environment variables template
├── .gitignore
└── README.md
```

---

## 🚀 Quickstart & Setup

### Prerequisites
- Node.js (v18+) & npm
- Python (v3.10+)
- PostgreSQL (v14+) & Redis (v6+) OR Docker Desktop

> **macOS Note**: On macOS Monterey and later, Apple's AirPlay Receiver listens on port 5000. To avoid collisions, StockSense backend runs on **Port 5001** by default.

### 1. Environment Configuration
Copy `.env.example` to the respective subdirectories:
```bash
cp .env.example backend/.env
cp .env.example ml-service/.env
```

### 2. Run with Docker (Recommended)
```bash
docker compose up -d
```

### 3. Database Migrations & Seeding (Milestone 2)
Once PostgreSQL is running (via Docker Desktop or native installation):
```bash
cd backend
npm run prisma:migrate   # Applies initial migration (creates all 7 tables)
npm run prisma:seed      # Seeds NSE, BSE & verified blue-chip equities
```

### 4. Local Development Mode (Without Docker)
If Docker Desktop is not installed, install PostgreSQL and Redis natively:
- **Postgres.app** (macOS): Download from [postgresapp.com](https://postgresapp.com/)
- **Homebrew**: `brew install postgresql@16 redis && brew services start postgresql@16 && brew services start redis`

Create the database:
```sql
CREATE USER stocksense_user WITH PASSWORD 'your_secure_password_here';
CREATE DATABASE stocksense_db OWNER stocksense_user;
```

Run services:
- **Backend**:
  ```bash
  cd backend
  npm install
  npm run dev
  ```
- **ML Service**:
  ```bash
  cd ml-service
  source .venv/bin/activate
  uvicorn app.main:app --reload --port 8000
  ```
- **Frontend**:
  ```bash
  cd frontend
  npm install
  npm run dev
  ```

### 5. Upstox OAuth 2.0 Setup (Milestone 3)
1. Register a developer app at [Upstox Developer Portal](https://upstox.com/developer/).
2. Set the Redirect URI in the Upstox developer console to:
   `http://localhost:5001/api/auth/upstox/callback`
3. Configure your API key and secret in `backend/.env`:
   ```bash
   UPSTOX_API_KEY=your_registered_api_key
   UPSTOX_API_SECRET=your_registered_api_secret
   UPSTOX_REDIRECT_URI=http://localhost:5001/api/auth/upstox/callback
   ```
4. Authenticate your account:
   Navigate to `http://localhost:5001/api/auth/upstox/start` in your browser. Complete Upstox login and authorize the application. The callback securely exchanges the authorization code, encrypts the access token with AES-256-GCM, and persists it in PostgreSQL/Redis with automatic 03:30 AM IST expiry.
5. Check status:
   `GET http://localhost:5001/api/auth/upstox/status`
6. Disconnect session:
   `POST http://localhost:5001/api/auth/upstox/disconnect` (Requires Bearer JWT in `Authorization` header)

### 6. Instrument Master Ingestion (Milestone 3, Step 5)
Download, parse, and synchronize official Upstox NSE & BSE equities and indices into PostgreSQL using the supported CLI script:

```bash
cd backend

# Standard live ingestion (equities & indices: NSE_EQ, BSE_EQ, NSE_INDEX, BSE_INDEX)
npm run ingest:instruments

# Dry-run simulation (verifies parsing & validation without database modification)
npm run ingest:instruments -- --dry-run

# Limit records for fast ingestion testing
npm run ingest:instruments -- --limit=100

# Ingest all market segments (including derivatives and commodities)
npm run ingest:instruments -- --all
```

> **Security Note**: HTTP administrative triggers (`/api/admin/instruments/*`) are explicitly disabled returning HTTP 503 pending full Role-Based Access Control (RBAC) in Milestone 4. The CLI script above is the primary supported manual ingestion mechanism.

### 7. Stock Catalogue & Market REST APIs (Milestone 3, Step 6)
All catalogue and market APIs deliver clean JSON payloads cached in Redis with deterministic query normalization and automatic fail-open PostgreSQL fallback:

| Method | Endpoint | Description | Cache TTL | Query Parameters |
|--------|----------|-------------|-----------|------------------|
| `GET` | `/api/stocks` | Paginated stock catalogue with filters | 5 minutes (300s) | `page`, `limit`, `search`, `exchange`, `instrumentType`, `segment`, `isActive`, `sortBy`, `sortOrder` |
| `GET` | `/api/stocks/search` | Fast typeahead search | 2 minutes (120s) | `q` (1–50 chars), `limit` (max 25) |
| `GET` | `/api/stocks/:id` | Full stock detail by UUID, token, or symbol | 10 minutes (600s) | `:id` (UUID, Upstox key e.g. `NSE_EQ\|INE002A01018`, or symbol e.g. `RELIANCE`) |
| `GET` | `/api/stocks/:id/prices` | Chronological OHLCV candles | 5 minutes (300s) | `interval` (`1m`–`1M`), `from`, `to`, `page`, `limit` |
| `GET` | `/api/stocks/:id/indicators` | Computed technical indicators (SMA, EMA, RSI, MACD, BB, ATR, Volatility, RVOL) | 5 minutes (300s) | `interval`, `limit`, `exchange` |
| `GET` | `/api/stocks/:id/features` | Engineered ML feature matrix from historical candles | 5 minutes (300s) | `interval`, `limit`, `dropNa`, `exchange` |
| `GET` | `/api/market/overview` | Platform summary & provider status | 30 seconds | None |
| `GET` | `/api/market/indices` | Verified database indices (Nifty, Sensex) | 5 minutes (300s) | None |

#### Standard Response Format
```json
{
  "success": true,
  "data": { ... },
  "meta": {
    "cached": false,
    "timestamp": "2026-11-07T14:15:30.000Z",
    "pagination": { "page": 1, "limit": 20, "totalRecords": 19, "totalPages": 1, "hasNextPage": false, "hasPrevPage": false }
  }
}
```

### 8. Historical Market Data Ingestion (Milestone 5, Phase 5A)
Download, validate, and persist historical daily OHLCV candlestick data for verified NSE bluechips (`RELIANCE`, `TCS`, `INFY`, `HDFCBANK`, `ICICIBANK`) using the official Upstox API V3 provider:

```bash
cd backend

# Ingest 3 years of daily history for all 5 verified initial NSE equities (Live Upstox V3)
npm run ingest:historical -- --all

# Ingest daily OHLCV candles for a single symbol over a date range
npm run ingest:historical -- --symbol=RELIANCE --from=2023-01-01 --to=2026-03-01

# Ingest multiple symbols for custom number of years (e.g. 5 years)
npm run ingest:historical -- --symbols=RELIANCE,TCS,INFY --years=5

# Incremental update (skips if up-to-date; ingests only missing days since latest candle)
npm run ingest:historical -- --all --incremental

# Dry-run mode (simulates ingestion & metrics without database mutation)
npm run ingest:historical -- --all --dry-run

# Offline mock provider for dry-run validation without live broker credentials
npm run ingest:historical -- --all --dry-run --mock
```

- **Features**:
  - **Indian Trading Calendar Engine**: Excludes weekends and official Indian exchange holidays (2021–2026) in `Asia/Kolkata` timezone so market closures are never falsely flagged as missing data.
  - **Automatic Date-Range Chunking**: Segments 3–5 year ranges into consecutive 365-day chunks for Upstox V3 daily bars, safely traversing leap year boundaries (2024 leap year 29-day February).
  - **Data Quality & Gap Analysis**: Measures coverage %, detects unexpected multi-day gaps ($\ge 2$ days), validates strict OHLC logic (`High >= Low`), preserves exact `DECIMAL(14, 4)` prices, and prevents BigInt volume truncation.
  - **Incremental Sync**: Automatically detects the latest stored candle in PostgreSQL to skip redundant API requests and only download fresh bars.
  - **Fail-Closed Redis Locking**: `stocksense:lock:historical_ingestion` with atomic UUID tokens, periodic Lua heartbeat renewal, and atomic release.
  - **Idempotent Batch Persistence**: Batches upserts (250 records/batch) against PostgreSQL compound unique key `(stockId, timestamp, interval)`. Deduplicates within-batch duplicate timestamps safely.
  - **Audit & Status Logging**: Detailed per-stock and overall metrics recorded in `DataSourceLog` and `UPSTOX_HISTORICAL_INGESTION_SUMMARY`.
  - **Cache Invalidation**: Target stock prices cache in Redis is automatically invalidated upon successful persistence.
  - **Upstox Authorization**: Live runs require an active Upstox access token obtained via `http://localhost:5001/api/auth/upstox/start`. If token is absent or expired, the tool fails safely with clear re-authorization instructions without fabricating prices.


---

## 📈 Phase Roadmap

- [x] **Phase 1: Foundation & Market Dashboard**
  - [x] Milestone 1: Project Initialization & Monorepo Setup (Verified)
  - [x] Milestone 2: Relational Database Schema & Prisma Migrations (Verified: PostgreSQL 16 & Redis 7 live)
  - [x] Milestone 3: Real Market Data Integration (Upstox API V3 Provider) (Verified: Steps 1–7 Complete)
  - [ ] Milestone 4: Python FastAPI Service & Health Verification
  - [ ] Milestone 5: Market Intelligence & Technical Indicator Pipeline
  - [ ] Milestone 6: High-Fidelity Fintech Market Dashboard
- [ ] **Phase 2: Technical & Fundamental Intelligence Engine**
- [ ] **Phase 3: Explainable Machine Learning & Sentiment Analytics**
- [ ] **Phase 4: Watchlist, Portfolio & Paper Trading Simulation**
