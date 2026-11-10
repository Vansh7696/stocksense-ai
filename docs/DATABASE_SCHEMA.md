# StockSense AI — Database Schema Specification

The database is built on PostgreSQL 16 using Prisma ORM (v6). It adheres to strict relational integrity, UUID primary keys, financial decimal precision, foreign key cascades, and indexed queries.

---

## 1. Core Entities (Phase 1 Initial Schema)

### `Exchange`
Represents an Indian stock exchange (NSE, BSE).
- `id` (UUID, PK)
- `code` (VARCHAR(10), UNIQUE, e.g., 'NSE', 'BSE')
- `name` (VARCHAR(100), e.g., 'National Stock Exchange of India')
- `country` (VARCHAR(50), default 'India')
- `currency` (VARCHAR(10), default 'INR')
- `timezone` (VARCHAR(50), default 'Asia/Kolkata')
- `createdAt`, `updatedAt`

### `Stock`
Represents a tradable equity instrument.
- `id` (UUID, PK)
- `exchangeId` (UUID, FK -> Exchange.id with CASCADE)
- `symbol` (VARCHAR(30), e.g., 'RELIANCE', 'TCS')
- `companyName` (VARCHAR(255))
- `isin` (VARCHAR(30), nullable, indexed)
- `instrumentToken` (VARCHAR(100), nullable, Upstox instrument key e.g. 'NSE_EQ|INE002A01018')
- `series` (VARCHAR(10), default 'EQ')
- `sector` (VARCHAR(100), nullable, indexed)
- `industry` (VARCHAR(100), nullable)
- `isActive` (BOOLEAN, default true)
- `createdAt`, `updatedAt`
- *Constraints*: Unique constraint on `[exchangeId, symbol]`.

### `HistoricalPrice`
Stores OHLCV candlestick data for stocks.
- `id` (UUID, PK)
- `stockId` (UUID, FK -> Stock.id with ON DELETE CASCADE)
- `timestamp` (TIMESTAMP WITH TIME ZONE)
- `open` (DECIMAL(12, 2)) — Exact monetary precision
- `high` (DECIMAL(12, 2))
- `low` (DECIMAL(12, 2))
- `close` (DECIMAL(12, 2))
- `volume` (BIGINT) — Large volume capacity without integer overflow
- `interval` (VARCHAR(10), e.g., '1D', '15m', '1m')
- `dataSource` (VARCHAR(50), default 'UPSTOX')
- `createdAt`
- *Constraints*: Unique constraint on `[stockId, timestamp, interval]` (Prevents duplicate historical candles).
- *Indexes*: Composite index on `[stockId, timestamp DESC]`.

### `User`
Application users, credentials, and settings.
- `id` (UUID, PK)
- `email` (VARCHAR(255), UNIQUE)
- `passwordHash` (VARCHAR(255))
- `fullName` (VARCHAR(150))
- `role` (VARCHAR(20), default 'USER')
- `createdAt`, `updatedAt`

### `Watchlist` & `WatchlistStock`
User-curated equity watchlists.
- `Watchlist`: `id`, `userId` (FK -> User.id with CASCADE), `name`, `createdAt`, `updatedAt`
- `WatchlistStock`: `id`, `watchlistId` (FK with CASCADE), `stockId` (FK with CASCADE), `addedAt`
- *Constraints*: Unique `[watchlistId, stockId]`.

### `DataSourceLog`
Tracks upstream synchronization events, API latency, and status.
- `id` (UUID, PK)
- `provider` (VARCHAR(50), e.g., 'UPSTOX')
- `operation` (VARCHAR(100), e.g., 'SYNC_OHLCV')
- `status` (VARCHAR(20), e.g., 'SUCCESS', 'FAILED')
- `recordsProcessed` (INTEGER)
- `errorMessage` (TEXT, nullable)
- `createdAt`

---

## 2. Evaluation of Financial Decimal Precision

### Current Configuration: `DECIMAL(12, 2)`
- Supports numerical values up to `9,999,999,999.99` with exact 2-decimal paisa precision.
- **Sufficiency for Cash Equities**: Standard NSE and BSE equities trade with a minimum tick size of ₹0.05. `DECIMAL(12, 2)` is completely adequate for standard equity spot prices and transaction values.
- **Recommendation for Milestone 3 Evolution**:
  In institutional financial platforms, `DECIMAL(14, 4)` is strongly recommended for:
  1. Mutual fund and ETF Net Asset Values (NAVs), which are published to 4 decimal places (e.g. ₹124.5421).
  2. Currency derivatives and commodity pairs with tick size ₹0.0025.
  3. Corporate action price adjustments (stock splits, bonus issues, and dividend adjustments) where retroactively adjusted historical prices contain fractional paise.
  4. Volume-Weighted Average Price (VWAP) calculation integrity.
  *Decision*: For Milestone 3, we propose migrating `open`, `high`, `low`, `close` in `HistoricalPrice` to `DECIMAL(14, 4)` to support exact split adjustments and analytical metrics without loss of precision.

---

## 3. Seeded Indian Market Metadata & Upstox Reconcilation

### Exchanges
1. **NSE**: `National Stock Exchange of India` (Asia/Kolkata, INR)
2. **BSE**: `BSE Limited` (Asia/Kolkata, INR)

### Verified Blue-Chip Equities
| Symbol | Exchange | Company Name | ISIN (NSDL/CDSL) | Upstox Instrument Token Format | Sector |
|---|---|---|---|---|---|
| `RELIANCE` | NSE | Reliance Industries Limited | INE002A01018 | `NSE_EQ\|INE002A01018` | Energy |
| `TCS` | NSE | Tata Consultancy Services Limited | INE467B01029 | `NSE_EQ\|INE467B01029` | Information Technology |
| `INFY` | NSE | Infosys Limited | INE009A01021 | `NSE_EQ\|INE009A01021` | Information Technology |
| `HDFCBANK` | NSE | HDFC Bank Limited | INE040A01034 | `NSE_EQ\|INE040A01034` | Financial Services |
| `ICICIBANK` | NSE | ICICI Bank Limited | INE090A01021 | `NSE_EQ\|INE090A01021` | Financial Services |
| `500325` | BSE | Reliance Industries Limited | INE002A01018 | `BSE_EQ\|INE002A01018` | Energy |
| `532540` | BSE | Tata Consultancy Services Limited | INE467B01029 | `BSE_EQ\|INE467B01029` | Information Technology |

*Strict Rule*: Seed contains exclusively verified company metadata. No simulated prices, volumes, or financial statements are ever inserted during seeding. Real market quotes and OHLCV candlestick histories will be ingested dynamically via the Upstox API V3 provider in Milestone 3.
