# StockSense AI — REST API Documentation

Base URL: `http://localhost:5001/api`

All JSON responses follow a standardized payload envelope:
```json
{
  "success": true,
  "data": { ... },
  "message": "Optional descriptive status message",
  "meta": {
    "timestamp": "2026-11-07T00:00:00.000Z",
    "version": "1.0.0"
  }
}
```

Error responses:
```json
{
  "success": false,
  "error": {
    "code": "RESOURCE_NOT_FOUND",
    "message": "Stock with the specified identifier was not found",
    "details": null
  }
}
```

Standard Provider & Rate Limiting Error Codes:
- `REAUTHORIZATION_REQUIRED` (401): Upstox token is unconfigured, expired at 03:30 AM IST, or invalid. Requires manual OAuth re-authorization.
- `PROVIDER_RATE_LIMITED` (429): Provider rate limit exceeded. Automatically retried with full-jitter exponential backoff before failing.
- `RATE_LIMITER_OFFLINE` (503): Redis is unreachable; requests fail closed to protect broker account quotas.
- `PROVIDER_TIMEOUT` (504): Provider API did not respond within configured timeout (10,000ms).
- `PROVIDER_NETWORK_ERROR` (503): Network-level connection failure to provider.
- `PROVIDER_RESPONSE_MALFORMED` (502): Provider returned non-JSON or invalid payload envelope.

---

## Market Data Provider Architecture & Endpoints

### Upstox API V3 Endpoints (Integrated in Provider Layer)
1. **Historical Closed Candles (V3)**:
   - `GET https://api.upstox.com/v3/historical-candle/{instrumentKey}/{unit}/{interval}/{to_date}/{from_date}`
   - Plural units: `minutes`, `hours`, `days`, `weeks`, `months`
   - Limits: 1m–15m (30-day chunk), 30m/1h (90-day chunk), 1D (365-day chunk), 1W/1M (unlimited)
2. **Intraday Candles (V3)**:
   - `GET https://api.upstox.com/v3/historical-candle/intraday/{instrumentKey}/{unit}/{interval}`
3. **Market Quotes (V2)**:
   - `GET https://api.upstox.com/v2/market-quote/quotes?instrument_key={instrumentKey}`
4. **LTP Quotes (V3)**:
   - `GET https://api.upstox.com/v3/market-quote/ltp?instrument_key={instrumentKey}`
   - *Note: Deprecated `/v2/market-quote/ltp` has been completely replaced with official V3 LTP.*
   - Fields mapped: `last_price`, `instrument_token`, `ltq` (last traded quantity), `volume`, `cp` (previous close).

### Validated Candle Format (`MarketDataValidatorService`)
Candles persisted to PostgreSQL or served via API conform to the validated schema:
- `timestamp`: UTC JavaScript `Date` instance (mapped to PostgreSQL `TIMESTAMPTZ(3)`)
- `originalTimestampString`: Exact string returned by provider (preserves market offset e.g. `+05:30`)
- `open`, `high`, `low`, `close`: Positive finite numbers (`High >= Low`, `High >= Open/Close`, `Low <= Open/Close`)
- `openDecimal`, `highDecimal`, `lowDecimal`, `closeDecimal`: 4-decimal strings (`DECIMAL(14, 4)` safe)
- `volume`: Non-negative `BigInt` (>= 0)
- `openInterest`: `BigInt` (>= 0)

---

## Phase 1 Endpoints

### 1. System Health
- **Endpoint**: `GET /api/health`
- **Description**: Returns operational health of the Express API, database connectivity, and Redis status.
- **Response**:
```json
{
  "success": true,
  "data": {
    "status": "UP",
    "environment": "development",
    "uptimeSeconds": 124.5,
    "services": {
      "database": "CONNECTED",
      "redis": "CONNECTED",
      "mlService": "CONNECTED"
    }
  }
}
```

### 2. Market Overview
- **Endpoint**: `GET /api/market/overview`
- **Description**: Summary of broad market health, index movements (NIFTY 50, SENSEX), market breadth, and top movers.

### 3. Market Indices
- **Endpoint**: `GET /api/market/indices`
- **Description**: Returns live and historical snapshots for Indian benchmark indices.

### 4. Stock Directory & Search
- **Endpoint**: `GET /api/stocks`
- **Query Params**: `page=1&limit=20&exchange=NSE&sector=Information%20Technology`
- **Description**: Paginated list of equities.

- **Endpoint**: `GET /api/stocks/search?q={query}`
- **Description**: Fast substring/prefix search for symbols and company names.

### 5. Stock Details
- **Endpoint**: `GET /api/stocks/:id`
- **Description**: Full profile of an individual equity (symbol, ISIN, sector, exchange info).

### 6. Historical Candlestick Prices
- **Endpoint**: `GET /api/stocks/:id/prices`
- **Query Params**: `interval=1D&from=2026-01-01&to=2026-11-01`
- **Description**: Returns OHLCV candles suitable for TradingView Lightweight Charts.

### 7. Upstox OAuth 2.0 Authentication & Session Management
- **`GET /api/auth/upstox/start` (Alias: `GET /api/auth/upstox/login`)**:
  - Initiates OAuth 2.0 flow. Generates a cryptographically secure 64-hex state (stored as SHA-256 hash in Redis with 5-minute TTL).
  - Rate-limited to 10 requests/minute per IP.
  - Redirects browser to official Upstox dialog (`https://api.upstox.com/v2/login/authorization/dialog`).
  - If `Accept: application/json` or `?json=true`, returns `{ success: true, authUrl: "..." }`.
- **`GET /api/auth/upstox/callback`**:
  - Handles authorization-code callback from Upstox.
  - Atomically consumes state from Redis (guaranteeing strictly single-use CSRF protection).
  - Exchanges authorization code via `POST https://api.upstox.com/v2/login/authorization/token`.
  - Single-use guarantee: Never retries failed code exchanges.
  - Encrypts access token using AES-256-GCM and persists in PostgreSQL `system_configs` and Redis cache.
  - Redirects browser to `${CORS_ORIGIN}/settings?auth=success` or returns JSON if requested.
- **`GET /api/auth/upstox/status`**:
  - Returns safe token metadata without exposing raw tokens, keys, or ciphertext:
    `{ success: true, data: { configured: true, active: true, status: "ACTIVE", expiresAt: "...", reauthorizationRequired: false } }`.
- **`POST /api/auth/upstox/disconnect`**:
  - Clears stored encrypted token from PostgreSQL and Redis cache.
  - Returns `{ success: true, message: "Upstox session disconnected. Local credentials and tokens cleared." }`.
